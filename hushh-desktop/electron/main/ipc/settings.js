/**
 * ipc/settings.js
 *
 * Channels: hushh:settings:load   hushh:settings:save
 *
 * Persists desktop settings to a JSON file in Electron's userData directory.
 * Completely independent of the web-app's state — the desktop app can
 * remember model directory, runtime preference, and future options even when
 * the Next.js frontend is wiped/rebuilt.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { ipcMain, app } = require("electron");

function settingsPath() {
  return path.join(app.getPath("userData"), "hushh-settings.json");
}

/** @returns {Record<string, unknown>} */
function loadSettings() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} settings */
function saveSettings(settings) {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

function registerSettingsHandlers() {
  ipcMain.handle("hushh:settings:load", () => loadSettings());

  ipcMain.handle("hushh:settings:save", (_event, patch) => {
    const current = loadSettings();
    const merged  = { ...current, ...patch };
    saveSettings(merged);
    return merged;
  });
}

module.exports = { registerSettingsHandlers, loadSettings };
