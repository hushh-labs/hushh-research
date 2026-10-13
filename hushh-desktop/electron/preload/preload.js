/**
 * preload.js
 *
 * Exposes `window.hushh` to React/Next.js via contextBridge.
 * All namespaces are declared up-front so the API shape is stable
 * even before their IPC handlers are fully implemented.
 *
 * Usage in React:
 *
 *   const isDesktop = window.hushh?.platform?.isDesktop === true;
 *
 *   const info     = await window.hushh.platform.getInfo();
 *   const runtime  = await window.hushh.runtime.get();
 *   const settings = await window.hushh.settings.load();
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** Thin helper so every IPC call follows the same pattern */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("hushh", {

  // ── platform ────────────────────────────────────────────────────────────
  platform: {
    /** Static flag — always true in Electron, undefined in a browser tab. */
    isDesktop: true,

    /**
     * Returns a live platform snapshot from the main process.
     * @returns {Promise<import("./ipc/platform").PlatformInfo>}
     */
    getInfo: () => invoke("hushh:platform:info"),
  },

  // ── runtime ─────────────────────────────────────────────────────────────
  runtime: {
    /** @returns {Promise<{selected: string, available: string[], backendStatus: string, frontendStatus: string}>} */
    get: () => invoke("hushh:runtime:get"),

    /** @param {"cloud"|"ollama"|"onnx"|"qnn"} runtimeId */
    set: (runtimeId) => invoke("hushh:runtime:set", runtimeId),
  },

  // ── models ──────────────────────────────────────────────────────────────
  models: {
    /** @returns {Promise<{modelDir: string|null, models: object[]}>} */
    list: () => invoke("hushh:models:list"),

    /** @param {string} modelId */
    install: (modelId) => invoke("hushh:models:install", modelId),
    
    /** @param {string} modelId */
    cancelInstall: (modelId) => invoke("hushh:models:cancelInstall", modelId),

    /** @param {string} modelId */
    remove: (modelId) => invoke("hushh:models:remove", modelId),
    
    /** @returns {Promise<{downloaded: boolean, running: boolean}>} */
    status: (modelId) => invoke("hushh:models:status", modelId),
    
    /** @param {(status: {downloaded: boolean, running: boolean}) => void} callback */
    onStatusChange: (callback) => {
      const handler = (event, status) => callback(status);
      ipcRenderer.on("hushh:models:statusChange", handler);
      return () => ipcRenderer.removeListener("hushh:models:statusChange", handler);
    },
    
    /** @param {string} modelId */
    spawn: (modelId) => invoke("hushh:models:spawn", modelId),
    
    /** @param {string} modelId */
    kill: (modelId) => invoke("hushh:models:kill", modelId),
  },

  // ── settings ────────────────────────────────────────────────────────────
  settings: {
    /** @returns {Promise<Record<string, unknown>>} */
    load: () => invoke("hushh:settings:load"),

    /**
     * Merge `patch` into the persisted settings and return the result.
     * @param {Record<string, unknown>} patch
     */
    save: (patch) => invoke("hushh:settings:save", patch),
  },

  // ── filesystem ──────────────────────────────────────────────────────────
  filesystem: {
    /**
     * Open a native folder picker.
     * @param {{ title?: string, defaultPath?: string }} [opts]
     * @returns {Promise<string|null>}
     */
    showFolderDialog: (opts) => invoke("hushh:filesystem:showFolderDialog", opts),

    /** @param {string} absPath @returns {Promise<boolean>} */
    exists: (absPath) => invoke("hushh:filesystem:exists", absPath),
  },

  // ── system ──────────────────────────────────────────────────────────────
  // Reserved namespace — log streaming, crash reports, diagnostics.
  system: {
    // Channels will be added as monitoring features are built.
  },

  // ── capabilities ────────────────────────────────────────────────────────
  capabilities: {
    /**
     * Probe available runtimes and hardware.
     * UI renders from this — never guesses.
     * @returns {Promise<{
     *   desktop: boolean,
     *   runtime: { cloud: boolean, ollama: boolean, onnx: boolean, qnn: boolean },
     *   hardware: { gpu: boolean, npu: boolean },
     *   filesystem: boolean,
     *   folderPicker: boolean,
     *   notifications: boolean,
     *   plugins: boolean,
     *   downloads: boolean,
     * }>}
     */
    get: () => invoke("hushh:capabilities:get"),
  },

  // ── plugins ─────────────────────────────────────────────────────────────
  // Reserved namespace — PDF, OCR, Whisper, Vision, Finance plugins.
  plugins: {
    // Channels will be registered as the plugin system is implemented.
  },
});
