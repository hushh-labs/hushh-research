/**
 * main.js – Electron entry point
 *
 * Orchestrates startup using decoupled services:
 *   1. Resolve dynamic ports.
 *   2. Initialize centralized RuntimeContext.
 *   3. Start backend and frontend via Supervisor.
 *   4. Wait for services.
 *   5. Open BrowserWindow.
 *
 * On quit:
 *   - Gracefully terminate child process trees.
 */

"use strict";

const path = require("path");
const { app, BrowserWindow } = require("electron");

// Windows groups taskbar icons/jump-lists/notifications by this ID. Without
// it, Windows falls back to grouping by the executable path, which breaks
// taskbar pinning and notification identity for Electron apps. Must match
// electron-builder's `appId` (package.json) and be set before any window is
// created.
if (process.platform === "win32") {
  app.setAppUserModelId("com.hushh.desktop.beta1");
}

// Without this, launching the exe twice (a double-click, a stuck taskbar
// icon, a Start Menu misfire) runs two full, independent startup
// sequences -- each spawning its own backend/frontend/daemon/analysis-
// engine. The fixed-port services (daemon, analysis engine, bridge) each
// only check "is something already healthy on my port" before spawning,
// which doesn't protect against two instances racing that same check at
// once (confirmed live: one such race left a dangling second backend.exe
// that lost its own port bind and a dangling second analysis-engine.exe).
// The single-instance lock stops this at the source -- the second launch
// hands off to the first and exits immediately instead of starting
// anything.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // app.quit() only REQUESTS a quit -- it doesn't halt execution of this
  // script. Without this early return, the rest of the module (including
  // the app.whenReady() handler below that spawns backend/frontend/daemon/
  // analysis-engine) would still run to completion for the very instance
  // that's supposed to be bowing out -- confirmed live: this exact gap
  // produced a second full set of backend/analysis-engine processes.
  app.quit();
  return;
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const { findFreePort } = require("./services/ports");
const { initRuntimeContext } = require("./services/runtime");
const { ensureBackendVenv } = require("./services/launcher");
const { spawnProcesses, waitForServices, shutdownServices } = require("./services/supervisor");
const { ensureDaemonRunning, killDaemon } = require("./services/daemon");
const { ensureAnalysisEngineRunning, killAnalysisEngine } = require("./services/analysisEngine");
const { registry } = require("./services/models/registry");

const { registerPlatformHandlers }      = require("./ipc/platform");
const { registerRuntimeHandlers }       = require("./ipc/runtime");
const { registerModelsHandlers }        = require("./ipc/models");
const { registerSettingsHandlers }      = require("./ipc/settings");
const { registerFilesystemHandlers }    = require("./ipc/filesystem");
const { registerCapabilitiesHandlers }  = require("./ipc/capabilities");

// Register all IPC handlers before any BrowserWindow is created
registerPlatformHandlers();
registerRuntimeHandlers();
registerModelsHandlers();
registerSettingsHandlers();
registerFilesystemHandlers();
registerCapabilitiesHandlers();

// ─── Window ─────────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow(frontendURL) {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    icon: path.resolve(__dirname, "..", "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.resolve(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
    },
    // Keep window hidden until services are ready
    show: false,
  });

  mainWindow.loadURL(frontendURL);

  // Renderer console.warn/error don't reach this process's stdout by
  // default -- forward them here (dev only) so frontend-only bugs (a JS
  // exception breaking a component before it ever calls the backend) are
  // visible in the same terminal/log as everything else, not just DevTools.
  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (event, level, message, line, sourceId) => {
      if (level >= 2) {
        console.log(`[renderer] ${message} (${sourceId}:${line})`);
      }
    });
  }

  // Show the window smoothly once the page finishes loading
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Startup ────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const isDev = !app.isPackaged;
  console.log(`[main] Runtime mode: ${isDev ? "development" : "production"}`);

  try {
    // 1. Resolve free ports dynamically
    const frontendPort = await findFreePort(3001);
    const backendPort = await findFreePort(8000);
    console.log(`[main] Ports allocated dynamically — Frontend: ${frontendPort}, Backend: ${backendPort}`);

    // 2. Initialize RuntimeContext
    const context = initRuntimeContext(frontendPort, backendPort);

    // 3. Ensure backend virtual environment. This is a dev-only concern
    //    (installs backend/.venv via `uv sync` on first run); ensureBackendVenv
    //    self-guards and no-ops in production, where the compiled binary is used.
    await ensureBackendVenv();

    // 4. Spawn frontend and backend processes
    spawnProcesses();

    // 5. Wait for both services to be responsive
    await waitForServices();

    // 6. Launch browser window
    createWindow(context.frontendURL);

    // 7. Best-effort: ensure the OneWindows MCP daemon is running. Fired
    //    off without awaiting -- it must never delay or block the window
    //    that just opened, and unlike steps 3-5 a failure here is not fatal.
    void ensureDaemonRunning();

    // 8. Best-effort: ensure the local analysis engine (deterministic
    //    financial math as MCP tools) is running. Same fire-and-forget,
    //    non-fatal treatment as the daemon -- see analysisEngine/index.js
    //    for why this is independent of GenieX/local chat state.
    void ensureAnalysisEngineRunning();
  } catch (err) {
    console.error("[main] Startup failed:", err);
    shutdownServices();
    app.quit();
  }
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

// before-quit fires before window close events; ideal place to kill children.
// Kills everything this app can spawn -- backend/frontend (supervisor),
// GenieX (registry), the OneWindows daemon, and the analysis engine --
// so nothing outlives the app. The daemon and analysis engine were
// originally left running after quit to serve other local MCP clients;
// see killDaemon/killAnalysisEngine's own comments for why that's
// overridden here.
app.on("before-quit", () => {
  shutdownServices();
  registry.killLocalInferenceEngine();
  killDaemon();
  killAnalysisEngine();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
