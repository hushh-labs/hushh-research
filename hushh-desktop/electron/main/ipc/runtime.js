/**
 * ipc/runtime.js
 *
 * Channels: hushh:runtime:get   hushh:runtime:set
 *
 * Runtime providers are structured objects, not plain strings.
 * The UI renders from the provider list — it never hardcodes labels.
 */

"use strict";

const { ipcMain } = require("electron");

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   status: "ready" | "missing" | "installing" | "error",
 *   supportsChat: boolean,
 *   supportsVision: boolean,
 *   supportsEmbeddings: boolean,
 *   local: boolean,
 * }} RuntimeProvider
 */

/** @type {RuntimeProvider[]} */
const PROVIDERS = [
  {
    id:                  "cloud",
    name:                "Cloud (Gemini)",
    description:         "Google Gemini via Vertex AI. Requires internet connection.",
    status:              "ready",
    supportsChat:        true,
    supportsVision:      true,
    supportsEmbeddings:  true,
    local:               false,
  },
  {
    id:                  "ollama",
    name:                "Ollama",
    description:         "Local inference via Ollama. Runs models on your hardware.",
    status:              "missing",    // updated by capabilities probe at runtime
    supportsChat:        true,
    supportsVision:      false,
    supportsEmbeddings:  true,
    local:               true,
  },
  {
    id:                  "onnx",
    name:                "ONNX Runtime",
    description:         "Microsoft ONNX Runtime for CPU/GPU inference.",
    status:              "missing",
    supportsChat:        true,
    supportsVision:      false,
    supportsEmbeddings:  false,
    local:               true,
  },
  {
    id:                  "qnn",
    name:                "Qualcomm QNN",
    description:         "Qualcomm Neural Networks SDK — requires NPU hardware.",
    status:              "missing",
    supportsChat:        true,
    supportsVision:      false,
    supportsEmbeddings:  false,
    local:               true,
  },
];

let selectedRuntime = "cloud";

function registerRuntimeHandlers() {
  ipcMain.handle("hushh:runtime:get", () => ({
    selected:       selectedRuntime,
    providers:      PROVIDERS,
    backendStatus:  "running",
    frontendStatus: "running",
  }));

  ipcMain.handle("hushh:runtime:set", (_event, runtimeId) => {
    const provider = PROVIDERS.find((p) => p.id === runtimeId);
    if (!provider) throw new Error(`Unknown runtime: ${runtimeId}`);
    if (provider.status !== "ready") throw new Error(`Runtime "${runtimeId}" is not ready.`);
    selectedRuntime = runtimeId;
    return { selected: selectedRuntime };
  });
}

module.exports = { registerRuntimeHandlers };
