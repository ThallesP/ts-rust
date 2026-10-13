"use strict";

// The tsc command line in this process, through the tsc-rs addon (crates/ts_napi runTsc): the
// compiler of tsc-rs with the OS file system, stdout, stderr and the bundled lib files. A process
// runs it once, and never in a process that opened an API session (tsc-rs runs a plain compile as
// the one program of the process).

const { loadAddon } = require("./native/addon.js");

function runTsc(args) {
    return loadAddon().runTsc(args);
}

module.exports = { runTsc };
