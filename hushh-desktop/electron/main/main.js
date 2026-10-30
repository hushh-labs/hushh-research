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

const { findFreePort } = require("./services/ports");
const { initRuntimeContext } = require("./services/runtime");
const { ensureBackendVenv } = require("./services/launcher");
const { spawnProcesses, waitForServices, shutdownServices } = require("./services/supervisor");

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
  } catch (err) {
    console.error("[main] Startup failed:", err);
    shutdownServices();
    app.quit();
  }
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

// before-quit fires before window close events; ideal place to kill children
app.on("before-quit", () => {
  shutdownServices();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
