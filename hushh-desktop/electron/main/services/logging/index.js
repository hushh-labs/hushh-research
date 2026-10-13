"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Hushh Desktop", "Logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const frontendLogStream = fs.createWriteStream(path.join(LOG_DIR, "frontend.log"), { flags: "a" });
const backendLogStream = fs.createWriteStream(path.join(LOG_DIR, "backend.log"), { flags: "a" });
const electronLogStream = fs.createWriteStream(path.join(LOG_DIR, "electron.log"), { flags: "a" });

/**
 * Pipes stdout/stderr of a ChildProcess to the Electron console with a label.
 * Also appends to the provided log write stream.
 * @param {import("child_process").ChildProcess} proc
 * @param {string} label
 * @param {fs.WriteStream} logStream
 */
function pipeOutput(proc, label, logStream) {
  proc.stdout?.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
    logStream?.write(chunk);
  });
  proc.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
    logStream?.write(chunk);
  });
}

// Intercept Electron's console logging
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  originalLog.apply(console, args);
  electronLogStream.write(args.join(" ") + "\n");
};

console.error = function (...args) {
  originalError.apply(console, args);
  electronLogStream.write(args.join(" ") + "\n");
};

module.exports = {
  LOG_DIR,
  frontendLogStream,
  backendLogStream,
  electronLogStream,
  pipeOutput,
};
