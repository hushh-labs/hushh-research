"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

class ModelRegistry {
  constructor() {
    this.modelsDir = this._getModelsDir();
    this._ensureDirectory();
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
  
  /**
   * Scaffolds the download UX for fetching hushh-ai-runtime.exe
   * and the full ONNX model directory (.bin, .onnx, tokenizer.json, etc.)
   */
  async downloadLocalInferenceEngine(modelId = "Llama-3.2-3B-Instruct") {
    console.log(`[ModelRegistry] 🔄 Initiating download for decoupled AI engine and ${modelId} folder...`);
    // TODO: Implement actual HuggingFace Hub / HTTP downloader streams here
    // Must pull: 
    // 1. hushh-ai-runtime.exe
    // 2. genai_config.json
    // 3. tokenizer.json
    // 4. model.onnx
    // 5. *.bin (QNN context binaries)
    return { success: true, status: "scaffolded" };
  }

  /**
   * Spawns the decoupled Python PyInstaller executable in the background.
   */
  spawnLocalInferenceEngine(modelDir, port = 8001) {
    const { spawn } = require("child_process");
    
    // In production, this points to %LOCALAPPDATA%/Hushh Desktop/AI/hushh-ai-runtime.exe
    const engineExe = path.join(this.modelsDir, "..", "AI", "hushh-ai-runtime.exe");
    
    if (!fs.existsSync(engineExe)) {
        console.error(`[ModelRegistry] ❌ AI Runtime executable not found at ${engineExe}`);
        return null;
    }
    
    console.log(`[ModelRegistry] 🚀 Spawning decoupled AI Engine on port ${port}...`);
    const aiProcess = spawn(engineExe, [
        "--model-dir", modelDir,
        "--port", port.toString()
    ], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    
    aiProcess.stdout.on("data", (data) => console.log(`[AI-Engine] ${data.toString().trim()}`));
    aiProcess.stderr.on("data", (data) => console.error(`[AI-Engine] ${data.toString().trim()}`));
    
    return aiProcess;
  }
}

// Export a singleton instance
const registry = new ModelRegistry();
module.exports = { registry, ModelRegistry };
