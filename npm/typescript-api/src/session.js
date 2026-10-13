"use strict";

// One tsc-rs API session per current directory and case sensitivity. Programs are snapshots in it.
// The session asks the JS side for every file system operation; the innermost entry of
// `fileSystems` answers, and an operation it does not handle (or no entry at all) goes to the
// operating system.

const fileSystemCallbacks = ["readFile", "fileExists", "directoryExists", "getAccessibleEntries", "realpath", "stat", "writeFile", "removeFile"];
const useOS = JSON.stringify({ kind: "useOS" });
const missing = JSON.stringify({ kind: "missing" });
// What a callback that threw answers: tsc-rs panics on an answer of the wrong kind
// (crates/ts_goport/src/api/callbackfs.rs).
const fallbackAnswers = {
    readFile: missing,
    fileExists: JSON.stringify({ kind: "value", value: false }),
    directoryExists: JSON.stringify({ kind: "value", value: false }),
    getAccessibleEntries: JSON.stringify({ kind: "value", value: { files: [], directories: [] } }),
    realpath: JSON.stringify({ kind: "identity" }),
    stat: missing,
    writeFile: JSON.stringify({ kind: "noop" }),
    removeFile: JSON.stringify({ kind: "noop" }),
};
const done = JSON.stringify({ kind: "value" });
const encoder = new TextEncoder();
const { loadAddon } = require("./native/addon.js");

const sessions = new Map();

// tsc-rs compares file names the way its session was started, and its current directory names
// relative paths, finds automatic @types and words messages. A host whose case sensitivity or
// current directory differs from ts.sys (TS 6.0's own tests use in-memory hosts at "/.src")
// gets its own session.
function getSession(ts, useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames, currentDirectory = ts.sys.getCurrentDirectory()) {
    const key = `${!!useCaseSensitiveFileNames}\0${currentDirectory}`;
    let session = sessions.get(key);
    if (session === undefined) {
        session = new Session(!!useCaseSensitiveFileNames, currentDirectory);
        sessions.set(key, session);
    }
    return session;
}

class Session {
    constructor(useCaseSensitiveFileNames, currentDirectory) {
        const { createChannel } = require("./native/channel.js");
        this.fileSystems = [];
        // An exception thrown by a host callback while tsc-rs waits for its answer. The callback
        // gives a harmless answer instead (a throwing callback would break the channel), and the request
        // rethrows it when tsc-rs is done.
        this.callbackError = undefined;
        this.nextCallbackId = 0;
        this.channel = createChannel([
            "--api",
            "--cwd",
            currentDirectory,
            `--useCaseSensitiveFileNames=${useCaseSensitiveFileNames}`,
            `--callbacks=${fileSystemCallbacks.join(",")}`,
        ]);
        for (const name of fileSystemCallbacks) {
            this.channel.registerCallback(name, (_, payload) => this.guard(() => this.answer(name, payload), fallbackAnswers[name]));
        }
        this.request("initialize", null);
    }

    request(method, params) {
        const text = this.channel.requestSync(method, JSON.stringify(params));
        this.throwCallbackError();
        return text === "" ? undefined : JSON.parse(text);
    }

    requestBinary(method, params) {
        const bytes = this.channel.requestBinarySync(method, encoder.encode(JSON.stringify(params)));
        this.throwCallbackError();
        return bytes.length === 0 ? undefined : bytes;
    }

    // Results of several requests in one round trip; a failed request gives an Error in its slot.
    requestBatch(requests) {
        if (requests.length === 0) {
            return [];
        }
        const results = [];
        let response = this.request("batchRequests", { requests });
        for (;;) {
            for (const item of response.responses) {
                results.push(item.error === undefined || item.error === "" ? item.result : new Error(`tsc-rs: ${item.method}: ${item.error}`));
            }
            if (!response.continuationToken) {
                return results;
            }
            response = this.request("batchRequests", { requests: [], continuationToken: response.continuationToken });
        }
    }

    // V8 sees only the JS side of a program; tsc-rs's side lives in this process too (unless the
    // session runs in a child process).
    adjustExternalMemory(change) {
        if (process.env.TSRS_API_CHANNEL !== "process" && change !== 0) {
            loadAddon().adjustExternalMemory(change);
        }
    }

    withFileSystem(fileSystem, run) {
        this.fileSystems.push(fileSystem);
        try {
            return run();
        }
        finally {
            this.fileSystems.pop();
        }
    }

    // Registers a callback that tsc-rs can call by the returned name (module resolution).
    registerCallback(prefix, callback) {
        const name = `${prefix}/${++this.nextCallbackId}`;
        this.channel.registerCallback(name, (_, payload) => this.guard(() => JSON.stringify(callback(JSON.parse(payload)) ?? null), "null"));
        return name;
    }

    unregisterCallback(name) {
        this.channel.unregisterCallback(name);
    }

    guard(run, fallback) {
        try {
            return run();
        }
        catch (error) {
            this.callbackError ??= error;
            return fallback;
        }
    }

    throwCallbackError() {
        const error = this.callbackError;
        if (error !== undefined) {
            this.callbackError = undefined;
            throw error;
        }
    }

    answer(name, payload) {
        const handler = this.fileSystems.at(-1)?.[name];
        if (handler === undefined) {
            return useOS;
        }
        if (name === "writeFile") {
            const { path, data } = JSON.parse(payload);
            return handler(path, data) === useOSAnswer ? useOS : done;
        }
        if (name === "removeFile") {
            return handler(JSON.parse(payload)) === useOSAnswer ? useOS : done;
        }
        const result = handler(JSON.parse(payload));
        if (result === useOSAnswer) {
            return useOS;
        }
        if (result === undefined) {
            return missing;
        }
        return JSON.stringify({ kind: "value", value: result });
    }
}

// A file system handler returns this to let the operating system answer one call.
const useOSAnswer = Symbol("useOS");

module.exports = { getSession, useOSAnswer };
