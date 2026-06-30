/**
 * main.js – Electron entry point
 *
 * Orchestrates startup:
 *   1. Start Python backend
 *   2. Start Next.js frontend
 *   3. Wait for both HTTP endpoints
 *   4. Open BrowserWindow
 *
 * On quit:
 *   - Gracefully terminate both child process trees
 */

"use strict";

const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ensureBackendVenv,
  startBackend,
  startFrontend,
  waitForServices,
  shutdownServices,
} = require("./launcher");
const { DESKTOP_PORT } = require("../../config/runtime");
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

function createWindow() {
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

  mainWindow.loadURL(`http://localhost:${DESKTOP_PORT}`);

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
  // app.isPackaged reflects how Electron was launched:
  //   false → `electron .` / `npm start` / development
  //   true  → packaged .exe / installer / production distribution
  const isDev = !app.isPackaged;
  console.log(`[main] Runtime mode: ${isDev ? "development" : "production"}`);

  try {
    if (!isDev) {
      await ensureBackendVenv();
    }
    
    startBackend(isDev);
    startFrontend(isDev);

    await waitForServices();

    createWindow();
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
