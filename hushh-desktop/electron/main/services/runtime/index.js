"use strict";

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * @typedef {Object} RuntimeContext
 * @property {number} frontendPort
 * @property {number} backendPort
 * @property {string} frontendURL
 * @property {string} backendURL
 * @property {boolean} isDev
 * @property {boolean} isPackaged
 */

/** @type {RuntimeContext | null} */
let context = null;

/**
 * Initializes the centralized RuntimeContext and writes it to userData/runtime.json.
 * @param {number} frontendPort
 * @param {number} backendPort
 * @returns {RuntimeContext}
 */
function initRuntimeContext(frontendPort, backendPort) {
  const isPackaged = app.isPackaged;
  const isDev = !isPackaged;
  
  context = {
    frontendPort,
    backendPort,
    frontendURL: `http://localhost:${frontendPort}`,
    backendURL: `http://127.0.0.1:${backendPort}`,
    isDev,
    isPackaged,
  };

  // Write runtime.json to Electron's userData directory
  try {
    const userDataPath = app.getPath("userData");
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    const runtimeFilePath = path.join(userDataPath, "runtime.json");
    fs.writeFileSync(runtimeFilePath, JSON.stringify(context, null, 2), "utf8");
    console.log(`[runtime] Centralized context written to: ${runtimeFilePath}`);
  } catch (err) {
    console.error("[runtime] Failed to write runtime.json:", err);
  }

  return context;
}

/**
 * Gets the current RuntimeContext.
 * @returns {RuntimeContext}
 */
function getRuntimeContext() {
  if (!context) {
    throw new Error("[runtime] RuntimeContext has not been initialized yet!");
  }
  return context;
}

module.exports = {
  initRuntimeContext,
  getRuntimeContext,
};
