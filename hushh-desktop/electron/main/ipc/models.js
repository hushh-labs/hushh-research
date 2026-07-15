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
    return await registry.provisionGenieXModel(modelId);
  });

  ipcMain.handle("hushh:models:cancelInstall", (_event, modelId) => {
    const { registry } = require("../services/models/registry");
    return registry.cancelDownloadLocalInferenceEngine(modelId);
  });

  ipcMain.handle("hushh:models:remove", (_event, modelId) => {
    const { registry } = require("../services/models/registry");
    return registry.deleteLocalInferenceEngine(modelId);
  });

  ipcMain.handle("hushh:models:status", (_event, modelId) => {
    const { registry } = require("../services/models/registry");
    return registry.getStatus(modelId);
  });

  ipcMain.handle("hushh:models:kill", (_event, modelId) => {
    const { registry } = require("../services/models/registry");
    return registry.killLocalInferenceEngine(modelId);
  });
  
  ipcMain.handle("hushh:models:spawn", async (_event, modelId) => {
    const { registry } = require("../services/models/registry");
    const proc = await registry.spawnLocalInferenceEngine(modelId);
    return proc ? true : false;
  });
}

module.exports = { registerModelsHandlers };
