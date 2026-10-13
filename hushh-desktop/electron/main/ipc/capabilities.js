/**
 * ipc/capabilities.js
 *
 * Channel: hushh:capabilities:get
 *
 * Returns a capability map that the UI uses to decide what to render.
 * No UI code should guess — it reads capabilities.
 *
 * Shape is intentionally stable: new capabilities are added as false,
 * never removed, so old UI code continues to work.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { ipcMain, app } = require("electron");

// ── Runtime detection helpers ────────────────────────────────────────────────

function isOllamaInstalled() {
  // Check common install locations on Windows / macOS / Linux
  const candidates = [
    "C:\\Users\\Default\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe")
      : null,
    "/usr/local/bin/ollama",
    "/usr/bin/ollama",
  ].filter(Boolean);

  return candidates.some((p) => fs.existsSync(p));
}

function isOnnxRuntimeInstalled() {
  // Detect onnxruntime Python package or the native C++ redistributable
  // For now: conservative false until we probe the venv
  return false;
}

function isQnnAvailable() {
  // Qualcomm QNN SDK detection — Windows only
  if (process.platform !== "win32") return false;
  const qnnPath = process.env.QNN_SDK_ROOT;
  return !!qnnPath && fs.existsSync(qnnPath);
}

// ── Handler ─────────────────────────────────────────────────────────────────

function registerCapabilitiesHandlers() {
  ipcMain.handle("hushh:capabilities:get", () => {
    const ollama = isOllamaInstalled();
    const onnx   = isOnnxRuntimeInstalled();
    const qnn    = isQnnAvailable();

    return {
      desktop: true,

      runtime: {
        cloud:  true,           // always available
        ollama: ollama,
        onnx:   onnx,
        qnn:    qnn,
      },

      hardware: {
        // GPU/NPU detection is async + native — false until probed
        gpu: false,
        npu: qnn,               // if QNN SDK is present, treat NPU as available
      },

      filesystem:   true,
      folderPicker: true,
      notifications: Notification.permission === "granted" || true,

      // Future namespaces — reserve the keys now
      plugins:   false,
      downloads: true,          // download manager is always available
    };
  });
}

module.exports = { registerCapabilitiesHandlers };
