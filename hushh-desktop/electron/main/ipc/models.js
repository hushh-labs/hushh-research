/**
 * ipc/models.js
 *
 * Channels: hushh:models:list   hushh:models:install   hushh:models:remove
 *
 * Stubs — filesystem scanning and download logic will be added
 * once model directory is configured via settings.
 */

"use strict";

const { ipcMain } = require("electron");

function registerModelsHandlers() {
  ipcMain.handle("hushh:models:list", () => ({
    modelDir:  null,       // populated once settings are configured
    models:    [],
  }));

  ipcMain.handle("hushh:models:install", async (_event, modelId) => {
    const { registry } = require("../services/models/registry");
    return await registry.downloadLocalInferenceEngine(modelId);
  });

  ipcMain.handle("hushh:models:remove", (_event, _modelId) => {
    throw new Error("Model removal not yet implemented.");
  });
}

module.exports = { registerModelsHandlers };
