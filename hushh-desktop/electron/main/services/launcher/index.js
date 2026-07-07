"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getRuntimeContext } = require("../runtime");
const { resolveEnvironments } = require("../environment");
const { pipeOutput, frontendLogStream, backendLogStream } = require("../logging");

// Paths
const DESKTOP_DIR  = path.resolve(__dirname, "..", "..", "..", "..");
const BACKEND_DIR  = path.resolve(DESKTOP_DIR, "backend");
const FRONTEND_DIR = path.resolve(DESKTOP_DIR, "frontend");

const PYTHON_EXE = path.resolve(
  BACKEND_DIR,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);

const NEXT_STANDALONE = path.resolve(FRONTEND_DIR, ".next", "standalone", "frontend", "server.js");
const NEXT_BIN = path.resolve(
  FRONTEND_DIR,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);

const NODE_EXE = process.execPath;

/**
 * In production, the .venv is not shipped — run `uv sync` on first launch.
 * @returns {Promise<void>}
 */
async function ensureBackendVenv() {
  const context = getRuntimeContext();
  if (!context.isDev) {
    console.log("[launcher] ── Production mode: skipping python venv check (using compiled binary).");
    return;
  }
  if (fs.existsSync(PYTHON_EXE)) return; // already installed

  console.log("[launcher] ── First-run: installing backend dependencies via uv sync …");
  await new Promise((resolve, reject) => {
    const uvProc = spawn("uv", ["sync"], {
      cwd: BACKEND_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    pipeOutput(uvProc, "UV", backendLogStream);
    uvProc.on("error", (err) => {
      console.error("[launcher] uv sync spawn error:", err);
      reject(err);
    });
    uvProc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`uv sync failed with exit code ${code}`));
    });
  });
  console.log("[launcher] ✓ Backend dependencies installed.");
}

const { app } = require("electron");

/**
 * Spawns the FastAPI backend process.
 * @returns {import("child_process").ChildProcess}
 */
function startBackend() {
  const context = getRuntimeContext();
  
  const userDataPath = app.getPath("userData");
  const { backendEnv } = resolveEnvironments(FRONTEND_DIR, BACKEND_DIR, userDataPath);
  const mergedEnv = { ...process.env, ...backendEnv };

  let exeCommand = "";
  let exeArgs = [];

  if (context.isDev) {
    exeCommand = PYTHON_EXE;
    exeArgs = [
      "-m", "uvicorn", "server:app",
      "--port", context.backendPort.toString()
      // No --reload: it spawns a second watcher/reloader process on top of
      // the actual worker, roughly doubling backend memory for a feature
      // that's not needed since the app gets restarted after backend edits
      // anyway.
    ];
    console.log("[launcher] ── Backend diagnostics (Development) ──────");
    console.log("[launcher]   PYTHON_EXE  :", PYTHON_EXE);
    console.log("[launcher]   exists      :", fs.existsSync(PYTHON_EXE));
  } else {
    let prodExePath = path.resolve(BACKEND_DIR, "dist", "hushh-backend.exe");
    exeCommand = prodExePath;
    exeArgs = [
      "--port", context.backendPort.toString()
    ];
    console.log("[launcher] ── Backend diagnostics (Production) ───────");
    console.log("[launcher]   BINARY_EXE  :", exeCommand);
    console.log("[launcher]   exists      :", fs.existsSync(exeCommand));
  }
  
  console.log("[launcher]   cwd         :", BACKEND_DIR);
  console.log("[launcher] ─────────────────────────────────────────────────");

  // Set stdio to ["pipe", "pipe", "pipe"] for process supervisor hooks
  const backendProc = spawn(exeCommand, exeArgs, {
    cwd: BACKEND_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: mergedEnv,
  });

  pipeOutput(backendProc, "BACKEND", backendLogStream);

  backendProc.on("error", (err) => {
    console.error(`[launcher] ⚠ Backend spawn error:`, err);
  });

  return backendProc;
}

/**
 * Spawns the Next.js frontend process.
 * @returns {import("child_process").ChildProcess}
 */
function startFrontend() {
  const context = getRuntimeContext();

  // In production the compiled Next.js standalone server is required. If it's
  // missing, fail fast with a clear message rather than silently falling back
  // to `next dev` (which needs the full dev toolchain/node_modules a packaged
  // build doesn't ship).
  if (!context.isDev && !fs.existsSync(NEXT_STANDALONE)) {
    throw new Error(
      `[launcher] Production frontend build missing at ${NEXT_STANDALONE}. ` +
      "Run `cd frontend && npm run build` before packaging."
    );
  }

  const useStandalone = !context.isDev && fs.existsSync(NEXT_STANDALONE);
  const frontendArgs = useStandalone
    ? [NEXT_STANDALONE]
    : [NEXT_BIN, "dev", "-p", context.frontendPort.toString()];
  const frontendCwd = useStandalone
    ? path.dirname(NEXT_STANDALONE)
    : FRONTEND_DIR;

  console.log("[launcher] ── Frontend diagnostics ─────────────────────────");
  console.log("[launcher]   NODE_EXE    :", NODE_EXE);
  console.log("[launcher]   Node version:", process.version);
  console.log("[launcher]   mode        :", useStandalone ? "production (standalone)" : context.isDev ? "development (next dev)" : "production (next start)");
  console.log("[launcher]   entry       :", useStandalone ? NEXT_STANDALONE : NEXT_BIN);
  console.log("[launcher]   PORT        :", context.frontendPort);
  console.log("[launcher] ─────────────────────────────────────────────────");

  const userDataPath = app.getPath("userData");
  const { frontendEnv } = resolveEnvironments(FRONTEND_DIR, BACKEND_DIR, userDataPath);

  const frontendProc = spawn(NODE_EXE, frontendArgs, {
    cwd: frontendCwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { 
      ...process.env,
      ...frontendEnv,
      PORT: context.frontendPort.toString(), 
      BACKEND_URL: context.backendURL,
      NEXT_PUBLIC_BACKEND_URL: context.backendURL,
      HOSTNAME: "localhost",
      ELECTRON_RUN_AS_NODE: "1" 
    },
  });

  pipeOutput(frontendProc, "FRONTEND", frontendLogStream);

  frontendProc.on("error", (err) => {
    console.error(`[launcher] ⚠ Frontend spawn error:`, err);
  });

  return frontendProc;
}

module.exports = {
  ensureBackendVenv,
  startBackend,
  startFrontend,
};
