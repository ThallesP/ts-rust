"use strict";

// createChannel(args) opens a tsc-rs API session and returns an object with the interface of TS7's
// SyncRpcChannel (src/api/syncChannel.ts): requestSync, requestBinarySync, registerCallback,
// unregisterCallback, close, lastBytesSent and lastBytesReceived. `args` are the `tsgo --api`
// arguments. The session runs in this process (crates/ts_napi); TSRS_API_CHANNEL=process runs it in
// a `tsgo --api` child process instead (TSRS_TSGO names the binary).
//
// A filesystem callback that throws gets a harmless answer and its exception is thrown again when
// the request returns: tsc-rs reads a failed read callback as a Go panic, and inside program loading
// that ends the whole process (crates/ts_goport/src/api/callbackfs.rs panic_error).

const fs = require("node:fs");
const path = require("node:path");
const { loadAddon } = require("./addon.js");
const { ProcessTransport } = require("./process.js");

const readAnswers = new Map([
    ["readFile", JSON.stringify({ kind: "missing" })],
    ["fileExists", JSON.stringify({ kind: "value", value: false })],
    ["directoryExists", JSON.stringify({ kind: "value", value: false })],
    ["getAccessibleEntries", JSON.stringify({ kind: "value", value: { files: [], directories: [] } })],
    ["realpath", JSON.stringify({ kind: "identity" })],
    ["stat", JSON.stringify({ kind: "missing" })],
]);
const fileSystemCallbacks = new Set([...readAnswers.keys(), "writeFile", "removeFile"]);
const errorAnswer = JSON.stringify({ kind: "error" });
const repoTsgo = path.resolve(__dirname, "..", "..", "..", "..", "target", "release", "tsgo");

class NativeTransport {
    constructor(args) {
        const { NativeChannel } = loadAddon();
        this.native = new NativeChannel(args);
    }

    requestSync(method, payload, onCall) {
        try {
            return this.native.requestSync(method, payload, onCall);
        }
        catch (error) {
            throw plainError(error);
        }
    }

    requestBinarySync(method, payload, onCall) {
        const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
        try {
            return this.native.requestBinarySync(method, bytes, onCall);
        }
        catch (error) {
            throw plainError(error);
        }
    }

    close() {
        this.native.close();
    }
}

class SyncChannel {
    constructor(transport, collectTiming, sentinels) {
        this.transport = transport;
        this.collectTiming = collectTiming;
        this.callbacks = new Map();
        this.sentinels = sentinels;
        this.callbackFailure = undefined;
        this.onCall = (name, payload) => this.handleCall(name, payload);
        this.lastBytesSent = 0;
        this.lastBytesReceived = 0;
    }

    requestSync(method, payload) {
        const result = this.request(this.transport.requestSync, method, payload);
        if (this.collectTiming) {
            this.lastBytesReceived = Buffer.byteLength(result, "utf8");
        }
        return result;
    }

    requestBinarySync(method, payload) {
        const result = this.request(this.transport.requestBinarySync, method, payload);
        if (this.collectTiming) {
            this.lastBytesReceived = result.length;
        }
        return result;
    }

    registerCallback(name, callback) {
        this.callbacks.set(name, callback);
    }

    unregisterCallback(name) {
        this.callbacks.delete(name);
    }

    close() {
        this.transport.close();
    }

    request(send, method, payload) {
        if (this.collectTiming) {
            this.lastBytesSent = typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.length;
            this.lastBytesReceived = 0;
        }
        // A callback may make requests of its own; each request keeps the failures of its callbacks.
        const outer = this.callbackFailure;
        this.callbackFailure = undefined;
        let result;
        let failure;
        try {
            result = send.call(this.transport, method, payload, this.onCall);
        }
        catch (error) {
            failure = { error };
        }
        const callbackFailure = this.callbackFailure;
        this.callbackFailure = outer;
        if (callbackFailure !== undefined) {
            throw callbackFailure.error;
        }
        if (failure !== undefined) {
            throw failure.error;
        }
        return result;
    }

    handleCall(name, payload) {
        const callback = this.callbacks.get(name) ?? this.sentinels.get(name);
        let answer;
        try {
            if (callback === undefined) {
                throw new Error(`no callback named \`${name}\` found`);
            }
            answer = callback(name, payload);
        }
        catch (error) {
            return this.failCall(name, error);
        }
        if (typeof answer !== "string") {
            return this.failCall(name, new TypeError(`callback \`${name}\` returned ${typeof answer}, not a string`));
        }
        if (answer === errorAnswer && fileSystemCallbacks.has(name)) {
            return this.failCall(name, new Error(`filesystem callback returned serverFS.error: ${name}`));
        }
        return answer;
    }

    // A failed read callback answers as if the file were missing; any other callback gets
    // CALL_ERROR (tsc-rs returns that as an error). The request throws the exception at its end.
    failCall(name, error) {
        this.callbackFailure ??= { error };
        const answer = readAnswers.get(name);
        if (answer === undefined) {
            throw error;
        }
        return answer;
    }
}

function createChannel(args, options = {}) {
    const { args: sessionArgs, sentinels } = takeErrorSentinels(args);
    const collectTiming = options.collectTiming ?? sessionArgs.includes("--timing");
    const transport = process.env.TSRS_API_CHANNEL === "process"
        ? new ProcessTransport(tsgoPath(options.tsgo), withApiFlag(sessionArgs))
        : new NativeTransport(sessionArgs);
    return new SyncChannel(transport, collectTiming, sentinels);
}

// `--callbacks=<name>:error` makes tsc-rs panic when it reaches that operation (serverFS.error), and
// a panic inside program loading ends the process. The channel answers those operations itself and
// fails the request instead.
function takeErrorSentinels(args) {
    const sentinels = new Map();
    const sessionArgs = args.map(arg => {
        const match = /^(--?callbacks=)(.*)$/.exec(arg);
        if (!match) {
            return arg;
        }
        const names = match[2].split(",").map(entry => {
            const [name, sentinel] = entry.split(":");
            if (sentinel !== "error" || !fileSystemCallbacks.has(name)) {
                return entry;
            }
            sentinels.set(name, () => {
                throw new Error(`filesystem operation configured with serverFS.error: ${name}`);
            });
            return name;
        });
        return match[1] + names.join(",");
    });
    return { args: sessionArgs, sentinels };
}

function withApiFlag(args) {
    return args[0] === "--api" ? args : ["--api", ...args];
}

function tsgoPath(fallback) {
    const exe = process.env.TSRS_TSGO || fallback || (fs.existsSync(repoTsgo) ? repoTsgo : undefined);
    if (exe === undefined) {
        throw new Error("TSRS_API_CHANNEL=process needs a tsgo binary: set TSRS_TSGO, or build target/release/tsgo.");
    }
    return exe;
}

// The native layer's errors carry a napi status code; the channel throws plain errors, as TS7's does.
function plainError(error) {
    if (error instanceof Error && error.code === "GenericFailure") {
        return new Error(error.message);
    }
    return error;
}

module.exports = { createChannel };
