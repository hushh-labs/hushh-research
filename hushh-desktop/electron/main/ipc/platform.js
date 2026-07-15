/**
 * ipc/platform.js
 *
 * Channel: hushh:platform:info
 *
 * Returns a rich, serialisable platform snapshot including OS, CPU, memory,
 * Electron/Node/Chrome versions, and NPU/GPU capability stubs.
 */

"use strict";

const os   = require("os");
const { ipcMain, app } = require("electron");

function registerPlatformHandlers() {
  ipcMain.handle("hushh:platform:info", () => {
    const cpus = os.cpus();
    return {
      // Identity
      isDesktop:        true,
      version:          app.getVersion(),
      electronVersion:  process.versions.electron,
      nodeVersion:      process.versions.node,
      chromeVersion:    process.versions.chrome,
      isDev:            !app.isPackaged,

      // OS
      os:               process.platform,   // "win32" | "darwin" | "linux"
      arch:             process.arch,        // "x64" | "arm64" | …
      osRelease:        os.release(),
      hostname:         os.hostname(),

      // CPU
      cpuModel:         cpus[0]?.model ?? "unknown",
      cpuCount:         cpus.length,

      // Memory (bytes — let the UI format)
      totalMemory:      os.totalmem(),
      freeMemory:       os.freemem(),

      // Paths
      userDataDir:      app.getPath("userData"),
      logsDir:          app.getPath("logs"),

      // GPU / NPU — detection implemented progressively
      // Set available=false until native probing is added.
      gpu: {
        available: false,
        vendor:    null,
        model:     null,
        vram:      null,      // bytes or null
      },
      npu: {
        available: false,
        vendor:    "Qualcomm",   // optimistic for Snapdragon X devices
        driver:    null,
        runtime:   "QNN",
      },
    };
  });
}

module.exports = { registerPlatformHandlers };
