/**
 * ipc/filesystem.js
 *
 * Channels: hushh:filesystem:showFolderDialog   hushh:filesystem:exists
 *
 * Safe, narrow filesystem access — the renderer never touches Node's `fs`
 * directly.  All paths must be explicitly whitelisted here.
 */

"use strict";

const fs   = require("fs");
const { ipcMain, dialog, app } = require("electron");

function registerFilesystemHandlers() {
  // Open a native folder picker and return the chosen path (or null).
  ipcMain.handle("hushh:filesystem:showFolderDialog", async (_event, opts = {}) => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title:       opts.title ?? "Choose a folder",
      defaultPath: opts.defaultPath ?? app.getPath("documents"),
      properties:  ["openDirectory", "createDirectory"],
    });
    return canceled ? null : (filePaths[0] ?? null);
  });

  // Check whether a path exists (used to validate model/data directories).
  ipcMain.handle("hushh:filesystem:exists", (_event, absPath) => {
    if (typeof absPath !== "string") return false;
    return fs.existsSync(absPath);
  });
}

module.exports = { registerFilesystemHandlers };
