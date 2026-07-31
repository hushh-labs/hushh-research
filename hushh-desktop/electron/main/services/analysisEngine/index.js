"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app } = require("electron");

// Must match local_analysis_engine/server.py's ANALYSIS_ENGINE_PORT. Fixed
// (not dynamically allocated) for the same reason as the daemon (31070) and
// the local bridge (18182): external MCP clients (Hermes, Kai's own
// runtime) need one address to configure once.
const ANALYSIS_ENGINE_PORT = 18183;
const ANALYSIS_ENGINE_HEALTH_URL = `http://127.0.0.1:${ANALYSIS_ENGINE_PORT}/health`;

// Redefined here rather than imported -- same shallow depth under
// electron/main/services/ as registry.js and daemon/index.js, so this
// resolves to the identical BACKEND_DIR.
const DESKTOP_DIR = path.resolve(__dirname, "..", "..", "..", "..");
const BACKEND_DIR = path.resolve(DESKTOP_DIR, "backend");
const BACKEND_PYTHON_EXE = path.resolve(
  BACKEND_DIR,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);

/**
 * Resolves how to launch the analysis engine. Same dev-vs-packaged split as
 * local_bridge (_getLocalBridgeCommand in models/registry.js): a
 * PyInstaller-compiled exe in a packaged build (build:analysis-engine --
 * see package.json), the backend's own venv python running the module
 * directly in dev.
 */
function getAnalysisEngineCommand() {
  if (app.isPackaged) {
    return {
      command: path.join(process.resourcesPath, "analysis-engine", "hushh-analysis-engine.exe"),
      args: [],
      cwd: path.join(process.resourcesPath, "analysis-engine"),
    };
  }
  return {
    command: BACKEND_PYTHON_EXE,
    args: ["-m", "local_analysis_engine.server"],
    cwd: BACKEND_DIR,
  };
}

/**
 * @returns {Promise<boolean>}
 */
async function isAnalysisEngineHealthy() {
  try {
    const response = await fetch(ANALYSIS_ENGINE_HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** @type {import("child_process").ChildProcess | null} */
let engineProc = null;

/**
 * Best-effort: starts the local analysis engine if it isn't already
 * reachable. Deliberately NOT gated behind GenieX/local-chat state -- unlike
 * the bridge (which only exists to serve Kai's local chatbot and is
 * supervised alongside GenieX in models/registry.js), the analysis engine
 * is pure deterministic math with no model loaded and no dependency on
 * whether local chat is even enabled (see server.py's own module
 * docstring). Originally spawned detached + unref'd and left running after
 * app shutdown (same "always-on background compute service" role as
 * OneWindows.Daemon) -- explicitly overridden by killAnalysisEngine() below
 * on this app's own quit; see daemon/index.js's killDaemon for the full
 * rationale, same tradeoff applies here.
 *
 * @returns {Promise<void>}
 */
async function ensureAnalysisEngineRunning() {
  if (await isAnalysisEngineHealthy()) {
    console.log("[analysisEngine] Local analysis engine already running, leaving it alone.");
    return;
  }

  const { command, cwd, args } = getAnalysisEngineCommand();
  if (!fs.existsSync(command)) {
    console.warn(
      `[analysisEngine] Analysis engine executable not found at ${command} -- skipping. ` +
      "Build it with `npm run build:analysis-engine` for a packaged build, or ensure the " +
      "backend venv exists for dev."
    );
    return;
  }

  console.log(`[analysisEngine] Starting local analysis engine on port ${ANALYSIS_ENGINE_PORT}...`);
  engineProc = spawn(command, args, {
    cwd,
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  engineProc.on("error", (err) => {
    console.warn("[analysisEngine] Failed to spawn analysis engine:", err);
  });
  engineProc.on("exit", () => {
    engineProc = null;
  });
  engineProc.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isAnalysisEngineHealthy()) {
      console.log("[analysisEngine] Local analysis engine responding.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.warn("[analysisEngine] Analysis engine spawned but did not respond within 10s.");
}

/**
 * Kills the local analysis engine on app quit. Tree-kills the tracked PID
 * (covers the PyInstaller onefile bootloader-then-child-copy pattern in
 * packaged builds -- taskkill /T catches both). Also does a best-effort
 * image-name kill for the packaged exe specifically, to catch an instance
 * left over from a previous run that crashed/was force-killed without
 * going through this shutdown path -- not done for the dev-mode python.exe
 * invocation, since killing by "python.exe" would be far too broad.
 */
function killAnalysisEngine() {
  if (engineProc && engineProc.pid) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(engineProc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      engineProc.kill("SIGTERM");
    }
    engineProc = null;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/IM", "hushh-analysis-engine.exe", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
}

module.exports = {
  ensureAnalysisEngineRunning,
  killAnalysisEngine,
};
