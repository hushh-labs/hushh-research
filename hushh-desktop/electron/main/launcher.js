/**
 * launcher.js
 *
 * Manages the backend (Python/uvicorn) and frontend (Next.js) child processes
 * and waits for both HTTP endpoints to become reachable before returning.
 *
 * Exposed API:
 *   startBackend(isDev)    → ChildProcess
 *   startFrontend(isDev)   → ChildProcess
 *   waitForServices()      → Promise<void>
 *   shutdownServices()     → void
 *
 * Key design decisions
 * ────────────────────
 * • Frontend is launched via `process.execPath … next dev/start` (pure Node),
 *   never via npm.cmd, which fails with EINVAL inside Electron's sandboxed env.
 * • Backend is launched via the venv Python exe directly, not via a shell.
 * • Dev vs Production is controlled by the isDev flag passed from main.js
 *   (tied to app.isPackaged).
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const waitOn = require("wait-on");
const { DESKTOP_PORT, BACKEND_PORT } = require("../../config/runtime");

// ─── Paths ──────────────────────────────────────────────────────────────────

// hushh-desktop/electron/main/launcher.js → hushh-desktop root → repo root
const DESKTOP_DIR  = path.resolve(__dirname, "..", "..");
const ROOT_DIR     = path.resolve(DESKTOP_DIR, "..");
const BACKEND_DIR  = path.resolve(DESKTOP_DIR, "backend");
const FRONTEND_DIR = path.resolve(DESKTOP_DIR, "frontend");

// Python venv executable (Windows path; Linux/macOS has bin/python)
const PYTHON_EXE = path.resolve(
  BACKEND_DIR,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);

// Next.js CLI binary (avoids npm entirely)
const NEXT_BIN = path.resolve(
  FRONTEND_DIR,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);

// The Node runtime bundled with Electron (same process that's running us)
const NODE_EXE = process.execPath;

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {import("child_process").ChildProcess | null} */
let backendProc  = null;

/** @type {import("child_process").ChildProcess | null} */
let frontendProc = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pipe stdout/stderr of a ChildProcess to the Electron console with a label.
 * @param {import("child_process").ChildProcess} proc
 * @param {string} label
 */
function pipeOutput(proc, label) {
  proc.stdout?.on("data", (chunk) =>
    process.stdout.write(`[${label}] ${chunk}`)
  );
  proc.stderr?.on("data", (chunk) =>
    process.stderr.write(`[${label}] ${chunk}`)
  );
}

/**
 * Kill a child process tree on Windows via taskkill /T /F.
 * Falls back to SIGTERM on POSIX.
 * @param {import("child_process").ChildProcess | null} proc
 * @param {string} label
 */
function killTree(proc, label) {
  if (!proc || proc.exitCode !== null) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    console.log(`[launcher] Sent taskkill to ${label} (pid ${proc.pid})`);
  } else {
    proc.kill("SIGTERM");
    console.log(`[launcher] Sent SIGTERM to ${label} (pid ${proc.pid})`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Spawn the Python/uvicorn backend.
 * @param {boolean} isDev  true → uvicorn --reload, false → uvicorn (prod)
 * @returns {import("child_process").ChildProcess}
 */
function startBackend(isDev = true) {
  const uvicornArgs = [
    "-m", "uvicorn", "server:app",
    "--port", BACKEND_PORT.toString(),
    ...(isDev ? ["--reload"] : []),
  ];

  console.log("[launcher] ── Backend diagnostics ──────────────────────────");
  console.log("[launcher]   PYTHON_EXE  :", PYTHON_EXE);
  console.log("[launcher]   exists      :", fs.existsSync(PYTHON_EXE));
  console.log("[launcher]   cwd         :", BACKEND_DIR);
  console.log("[launcher]   mode        :", isDev ? "development (--reload)" : "production");
  console.log("[launcher] ─────────────────────────────────────────────────");

  backendProc = spawn(PYTHON_EXE, uvicornArgs, {
    cwd: BACKEND_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  pipeOutput(backendProc, "BACKEND");

  backendProc.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(
        `[launcher] ⚠ Backend exited unexpectedly (code=${code}, signal=${signal})`
      );
    }
  });

  return backendProc;
}

/**
 * Spawn the Next.js frontend via Node directly (no npm / npm.cmd).
 *
 * Electron's sandboxed environment can't reliably resolve npm.cmd which
 * causes spawn EINVAL on Windows.  Using process.execPath (the Node runtime
 * embedded in Electron) and the next binary directly is the reliable fix.
 *
 * @param {boolean} isDev  true → next dev, false → next start
 * @returns {import("child_process").ChildProcess}
 */
function startFrontend(isDev = true) {
  const nextCmd = isDev ? "dev" : "start";

  console.log("[launcher] ── Frontend diagnostics ─────────────────────────");
  console.log("[launcher]   NODE_EXE    :", NODE_EXE);
  console.log("[launcher]   Node version:", process.version);
  console.log("[launcher]   ComSpec     :", process.env.ComSpec ?? "(not set)");
  console.log("[launcher]   NEXT_BIN    :", NEXT_BIN);
  console.log("[launcher]   next exists :", fs.existsSync(NEXT_BIN));
  console.log("[launcher]   FRONTEND_DIR:", FRONTEND_DIR);
  console.log("[launcher]   dir exists  :", fs.existsSync(FRONTEND_DIR));
  console.log("[launcher]   package.json:", fs.existsSync(path.join(FRONTEND_DIR, "package.json")));
  console.log("[launcher]   mode        :", isDev ? "development (next dev)" : "production (next start)");
  console.log("[launcher]   PORT        :", DESKTOP_PORT);
  console.log("[launcher] ─────────────────────────────────────────────────");

  frontendProc = spawn(NODE_EXE, [NEXT_BIN, nextCmd, "-p", DESKTOP_PORT.toString()], {
    cwd: FRONTEND_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: DESKTOP_PORT.toString() },
  });

  pipeOutput(frontendProc, "FRONTEND");

  frontendProc.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(
        `[launcher] ⚠ Frontend exited unexpectedly (code=${code}, signal=${signal})`
      );
    }
  });

  return frontendProc;
}

/**
 * Wait until both services respond on their expected ports.
 * @returns {Promise<void>}
 */
async function waitForServices() {
  console.log(`[launcher] Waiting for backend  → http://127.0.0.1:${BACKEND_PORT}/docs`);
  console.log(`[launcher] Waiting for frontend → http://localhost:${DESKTOP_PORT}`);

  await waitOn({
    resources: [
      `http-get://127.0.0.1:${BACKEND_PORT}/docs`,
      `http-get://localhost:${DESKTOP_PORT}`,
    ],
    interval: 500,     // poll every 500 ms
    timeout: 180_000,  // give up after 3 minutes
    validateStatus: (status) => status < 400,
    strictSSL: false,
  });

  console.log("[launcher] ✓ Both services are ready.");
}

/**
 * Gracefully terminate both child process trees.
 */
function shutdownServices() {
  console.log("[launcher] Shutting down child processes …");
  killTree(frontendProc, "FRONTEND");
  killTree(backendProc,  "BACKEND");
  frontendProc = null;
  backendProc  = null;
}

module.exports = {
  startBackend,
  startFrontend,
  waitForServices,
  shutdownServices,
};
