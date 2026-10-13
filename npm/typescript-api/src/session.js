"use strict";

// One tsc-rs API session per process. Programs are snapshots in it. The session asks the JS side
// for every file system operation; the innermost entry of `fileSystems` answers, and an operation
// it does not handle (or no entry at all) goes to the operating system.

const fileSystemCallbacks = ["readFile", "fileExists", "directoryExists", "getAccessibleEntries", "realpath", "stat", "writeFile", "removeFile"];
const useOS = JSON.stringify({ kind: "useOS" });
const missing = JSON.stringify({ kind: "missing" });
const done = JSON.stringify({ kind: "value" });
const encoder = new TextEncoder();

let session;

function getSession(ts) {
    session ??= new Session(ts);
    return session;
}

class Session {
    constructor(ts) {
        const { createChannel } = require("./native/channel.js");
        this.fileSystems = [];
        // An exception thrown by a host callback while tsc-rs waits for its answer. The callback
        // answers "missing" instead (a throwing callback would break the channel), and the request
        // rethrows it when tsc-rs is done.
        this.callbackError = undefined;
        this.nextCallbackId = 0;
        this.channel = createChannel([
            "--api",
            "--cwd",
            ts.sys.getCurrentDirectory(),
            `--useCaseSensitiveFileNames=${ts.sys.useCaseSensitiveFileNames}`,
            `--callbacks=${fileSystemCallbacks.join(",")}`,
        ]);
        for (const name of fileSystemCallbacks) {
            this.channel.registerCallback(name, (_, payload) => this.guard(() => this.answer(name, payload), missing));
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
