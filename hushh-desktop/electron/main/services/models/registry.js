"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// The GenieX model identifier, distinct from the internal `modelId` used
// for on-disk/IPC bookkeeping ("Llama-3.2-3B-Instruct"). Pre-compiled QAIRT
// asset pulled directly from AI Hub (real NPU execution, no local export
// needed) -- Meta's Llama variants don't offer this due to licensing, so
// this is Qwen3-4B-Instruct instead.
const GENIEX_MODEL_ID = "qualcomm/qwen3_4b_instruct_2507";
const GENIEX_MODEL_HUB = "aihub";
const GENIEX_PORT = 18181;

// Crash-recovery tuning for the occasional native QAIRT crash under memory
// pressure -- bounded retries so a genuinely broken install doesn't loop forever.
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const RESTART_DELAY_MS = 1500;

class ModelRegistry {
  constructor() {
    this.modelsDir = this._getModelsDir();
    this._ensureDirectory();
    // Cache for the "downloaded" state so getStatus() (polled by the UI) does
    // not shell out via a synchronous `geniex list` on every call and block the
    // Electron main-process event loop. null = unknown/needs recompute.
    this._downloadedCache = null;
  }

  _getModelsDir() {
    // The user specifically requested %LOCALAPPDATA%\Hushh Desktop\Models
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
      return path.join(process.env.LOCALAPPDATA, "Hushh Desktop", "Models");
    }
    // Fallback for Mac/Linux
    return path.join(app.getPath("userData"), "Models");
  }

  _ensureDirectory() {
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
    }
  }

  /**
   * Scans the local models directory and returns a list of installed models.
   * For the MVP, we just list files and directories inside the Models folder.
   */
  listModels() {
    this._ensureDirectory();
    
    try {
      const entries = fs.readdirSync(this.modelsDir, { withFileTypes: true });
      const models = [];
      
      for (const entry of entries) {
        // Skip hidden files
        if (entry.name.startsWith(".")) continue;

        const fullPath = path.join(this.modelsDir, entry.name);
        const stats = fs.statSync(fullPath);
        
        // Basic heuristics for model type
        let runtime = "Unknown";
        if (entry.name.endsWith(".gguf")) runtime = "Ollama / llama.cpp";
        else if (entry.name.endsWith(".onnx")) runtime = "ONNX";
        else if (entry.isDirectory()) runtime = "HuggingFace Format / QNN";

        models.push({
          id: entry.name,
          name: entry.name.replace(/\.[^/.]+$/, ""), // Strip extension for display
          size: stats.size,
          description: `Local model located at ${fullPath}`,
          runtime: runtime,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          installedAt: stats.birthtime,
        });
      }
      
      return models;
    } catch (err) {
      console.error("[ModelRegistry] Failed to list models:", err);
      return [];
    }
  }

  getModelsDir() {
    return this.modelsDir;
  }

  broadcastStatusChange(modelId = "Llama-3.2-3B-Instruct") {
      const { BrowserWindow } = require("electron");
      const status = this.getStatus(modelId);
      BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
              win.webContents.send("hushh:models:statusChange", status);
          }
      });
  }

  /**
   * Resolves the GenieX CLI executable.
   * Packaged builds ship a portable copy under resources/geniex (see
   * ai-library/geniex + package.json extraResources) so end users don't need
   * GenieX's own Inno Setup installer. Dev runs still use the system install
   * at %LOCALAPPDATA%\GenieX CLI so the existing local dev workflow is untouched.
   */
  _getGenieXExePath() {
    if (process.platform !== "win32") return null;

    if (app.isPackaged) {
      return path.join(process.resourcesPath, "geniex", "geniex.exe");
    }

    if (process.env.LOCALAPPDATA) {
      return path.join(process.env.LOCALAPPDATA, "GenieX CLI", "geniex.exe");
    }
    return null;
  }

  _isGenieXInstalled() {
    const exe = this._getGenieXExePath();
    return !!exe && fs.existsSync(exe);
  }

  /**
   * Pulls the GenieX model into its local cache (idempotent — skips if
   * already present, per `geniex list`).
   */
  async provisionGenieXModel(modelId = "Llama-3.2-3B-Instruct") {
    const geniexExe = this._getGenieXExePath();
    if (!geniexExe || !fs.existsSync(geniexExe)) {
        console.error(`[ModelRegistry] ❌ GenieX CLI not found at ${geniexExe}. Install GenieX CLI first.`);
        return { success: false, status: "error", error: "geniex_not_installed" };
    }

    if (this.verifyLocalInferenceEngine(modelId)) {
        console.log(`[ModelRegistry] ✅ ${GENIEX_MODEL_ID} already cached, skipping pull.`);
        this._downloadedCache = true;
        return { success: true, status: "downloaded" };
    }

    console.log(`[ModelRegistry] 🔄 Pulling ${GENIEX_MODEL_ID} via GenieX...`);
    this._cancelDownloadFlag = false;

    const { spawn } = require("child_process");
    return await new Promise((resolve) => {
        const pullProcess = spawn(geniexExe, [
            "pull", GENIEX_MODEL_ID,
            "--model-hub", GENIEX_MODEL_HUB,
        ], { stdio: ["pipe", "pipe", "pipe"] });

        this._pullProcess = pullProcess;

        pullProcess.stdout.on("data", (data) => {
            console.log(`[GenieX pull] ${data.toString().trim()}`);
        });
        pullProcess.stderr.on("data", (data) => {
            console.error(`[GenieX pull] ⚠️ ${data.toString().trim()}`);
        });

        pullProcess.on("exit", (code) => {
            this._pullProcess = null;
            if (this._cancelDownloadFlag) {
                console.log(`[ModelRegistry] 🛑 Download cancelled for ${modelId}.`);
                resolve({ success: false, status: "cancelled" });
                return;
            }
            if (code === 0) {
                console.log(`[ModelRegistry] ✅ Pull complete for ${GENIEX_MODEL_ID}.`);
                this._downloadedCache = true;
                resolve({ success: true, status: "downloaded" });
            } else {
                console.error(`[ModelRegistry] ❌ geniex pull exited with code ${code}.`);
                resolve({ success: false, status: "error", error: `geniex pull exited with code ${code}` });
            }
        });
    });
  }

  cancelDownloadLocalInferenceEngine() {
      this._cancelDownloadFlag = true;
      if (this._pullProcess) {
          this._pullProcess.kill();
      }
      return true;
  }

  /**
   * Checks GenieX's own model cache (`geniex list`) rather than local
   * scaffold files — GenieX manages its own model storage internally.
   */
  verifyLocalInferenceEngine(modelId = "Llama-3.2-3B-Instruct") {
    const geniexExe = this._getGenieXExePath();
    if (!geniexExe || !fs.existsSync(geniexExe)) {
        this._downloadedCache = false;
        return false;
    }

    try {
        const { execFileSync } = require("child_process");
        const output = execFileSync(geniexExe, ["list", "--format", "json"], { encoding: "utf-8" });
        const cached = JSON.parse(output);
        const downloaded = cached.some((m) => m.name === GENIEX_MODEL_ID);
        this._downloadedCache = downloaded;
        return downloaded;
    } catch (err) {
        console.error(`[ModelRegistry] Failed to check GenieX model cache:`, err.message);
        this._downloadedCache = false;
        return false;
    }
  }

  /**
   * Cheap, cached "is the model downloaded?" check for the hot UI-polling path
   * (getStatus). Falls back to the authoritative `geniex list` check exactly
   * once, then serves the cached value until install/remove invalidates it.
   */
  _isDownloadedCached(modelId = "Llama-3.2-3B-Instruct") {
    if (this._downloadedCache === null) {
        return this.verifyLocalInferenceEngine(modelId);
    }
    return this._downloadedCache;
  }

  /**
   * Spawns `geniex serve` in the background. Preserves the dead man's
   * switch: stdin stays piped, so if Electron dies/closes the pipe,
   * GenieX sees EOF on stdin and exits on its own — no taskkill needed
   * for the happy path (kept as a fallback in killLocalInferenceEngine).
   */
  async spawnLocalInferenceEngine(modelId = "Llama-3.2-3B-Instruct", port = GENIEX_PORT) {
    if (this.aiProcess) {
        console.log(`[ModelRegistry] AI Engine is already running.`);
        return this.aiProcess;
    }

    const { spawn } = require("child_process");
    const waitOn = require("wait-on");
    const geniexExe = this._getGenieXExePath();

    if (!this.verifyLocalInferenceEngine(modelId)) {
        console.error(`[ModelRegistry] ❌ Verification failed. Cannot spawn GenieX server.`);
        return null;
    }

    console.log(`[ModelRegistry] 🚀 Spawning GenieX server from ${geniexExe} on port ${port}...`);

    // NOTE: `geniex serve` binds its own configured default port (GENIEX_PORT,
    // 18181); it does not take a port argument here. `port` therefore must match
    // that default -- it drives the readiness wait below, not the bind.
    this.aiProcess = spawn(geniexExe, ["serve"], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    this.aiProcess.stdout.on("data", (data) => {
        console.log(`[GenieX] ${data.toString().trim()}`);
    });

    this.aiProcess.stderr.on("data", (data) => {
        console.error(`[GenieX] ⚠️ ${data.toString().trim()}`);
    });

    this.aiProcess.on("exit", (code, signal) => {
        console.log(`[ModelRegistry] GenieX server exited with code ${code} and signal ${signal}`);
        this.aiProcess = null;
        const wasIntentional = this._intentionalShutdown;
        this._intentionalShutdown = false;

        if (wasIntentional) {
            this.broadcastStatusChange(modelId);
            return;
        }

        console.warn(`[ModelRegistry] ⚠️ GenieX server exited unexpectedly (code=${code}, signal=${signal}). This is a known occasional native crash in Qualcomm's QAIRT library, not an app bug -- attempting automatic recovery.`);
        this._attemptCrashRecovery(modelId, port);
    });

    console.log(`[ModelRegistry] ⏳ Waiting for GenieX server to respond on port ${port}...`);
    try {
        await waitOn({
        resources: [`http-get://127.0.0.1:${port}/v1/models`],
        interval: 500,
        timeout: 60000,
      });
        console.log(`[ModelRegistry] ✅ GenieX server is online and ready!`);
        this.broadcastStatusChange(modelId);
        return this.aiProcess;
    } catch (err) {
        console.error(`[ModelRegistry] ❌ GenieX server failed to come online:`, err);
        this.killLocalInferenceEngine(modelId);
        return null;
    }
  }

  /**
   * Handles an unexpected GenieX exit (e.g. the native QAIRT crash we've seen
   * under memory pressure) by respawning it automatically, with a bounded
   * number of attempts per time window so a truly broken install doesn't
   * crash-loop forever.
   */
  _attemptCrashRecovery(modelId, port) {
      const now = Date.now();
      if (!this._crashRestartState || now - this._crashRestartState.windowStart > RESTART_WINDOW_MS) {
          this._crashRestartState = { count: 0, windowStart: now };
      }
      this._crashRestartState.count += 1;

      if (this._crashRestartState.count > MAX_RESTART_ATTEMPTS) {
          console.error(
              `[ModelRegistry] ❌ GenieX crashed ${this._crashRestartState.count} times within ` +
              `${Math.round(RESTART_WINDOW_MS / 60000)} minutes. Giving up automatic recovery -- ` +
              `manual restart required.`
          );
          this._restarting = false;
          this.broadcastStatusChange(modelId);
          return;
      }

      this._restarting = true;
      this.broadcastStatusChange(modelId);
      console.log(
          `[ModelRegistry] 🔄 Attempting GenieX recovery ` +
          `(attempt ${this._crashRestartState.count}/${MAX_RESTART_ATTEMPTS})...`
      );

      this._recoveryTimer = setTimeout(() => {
          this._recoveryTimer = null;
          this.spawnLocalInferenceEngine(modelId, port)
              .then((proc) => {
                  this._restarting = false;
                  if (proc) {
                      console.log(`[ModelRegistry] ✅ Recovered from GenieX crash.`);
                  } else {
                      console.error(`[ModelRegistry] ❌ Recovery attempt failed to bring GenieX back online.`);
                  }
                  this.broadcastStatusChange(modelId);
              })
              .catch((err) => {
                  this._restarting = false;
                  console.error(`[ModelRegistry] ❌ Recovery attempt threw:`, err);
                  this.broadcastStatusChange(modelId);
              });
      }, RESTART_DELAY_MS);
  }

  /**
   * Kills the running GenieX server. Closing stdin (dead man's switch)
   * is GenieX's primary shutdown signal; taskkill is a forceful fallback
   * in case it doesn't exit on its own.
   */
  async killLocalInferenceEngine(modelId = "Llama-3.2-3B-Instruct") {
      // Cancel any pending auto-restart -- an explicit stop/remove should win.
      if (this._recoveryTimer) {
          clearTimeout(this._recoveryTimer);
          this._recoveryTimer = null;
          this._restarting = false;
      }

      if (this.aiProcess) {
          console.log(`[ModelRegistry] 🛑 Stopping GenieX server...`);
          this._intentionalShutdown = true;

          if (this.aiProcess.pid && this.aiProcess.pid !== 99999) {
              const { exec } = require('child_process');
              exec(`taskkill /PID ${this.aiProcess.pid} /T /F`, (err) => {
                  if (err) {
                      console.error('Failed to kill GenieX process tree:', err);
                  }
              });
          } else if (this.aiProcess.kill) {
              this.aiProcess.kill();
          }
          this.aiProcess = null;
          this.broadcastStatusChange(modelId);
      }
      return true;
  }

  /**
   * Removes the model from GenieX's cache to reclaim SSD space.
   */
  async deleteLocalInferenceEngine(modelId = "Llama-3.2-3B-Instruct") {
      await this.killLocalInferenceEngine(modelId);

      const geniexExe = this._getGenieXExePath();
      if (!geniexExe || !fs.existsSync(geniexExe)) {
          console.warn(`[ModelRegistry] GenieX CLI not found, nothing to remove.`);
          return true;
      }

      try {
          const { execFileSync } = require("child_process");
          execFileSync(geniexExe, ["remove", GENIEX_MODEL_ID, "--yes"], { encoding: "utf-8" });
          console.log(`[ModelRegistry] 🗑️ Removed ${GENIEX_MODEL_ID} from GenieX cache.`);
          this._downloadedCache = false;
      } catch (err) {
          console.error(`[ModelRegistry] Failed to remove GenieX model:`, err.message);
      }
      return true;
  }
  
  /**
   * Returns the current state for the UI polling.
   */
  getStatus(modelId = "Llama-3.2-3B-Instruct") {
      return {
          downloaded: this._isDownloadedCached(modelId),
          running: !!this.aiProcess,
          restarting: !!this._restarting
      };
  }
}

// Export a singleton instance
const registry = new ModelRegistry();
module.exports = { registry, ModelRegistry };
