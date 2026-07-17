"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");

// Hybrid setup, split across two models by role. History: tried the 3B to
// fix the 1B's tendency to deflect open-ended opinion questions, reverted
// (no reliable sub-minute latency, confidently WRONG compounding math ~70%
// off). Then tried making Qwen3.5-2B do everything after a same-session live
// comparison found it the most internally-coherent reasoner on paper -- also
// reverted at first, because its always-on <think> reasoning trace (no way
// to disable it -- a "think" JSON field errors, a "/no_think" suffix isn't
// honored and can trigger runaway repetition loops instead) breaks GenieX's
// action-plan classifier call whenever `tools` are attached to the request:
// confirmed live AND via isolated repro down to a single minimal tool with a
// 5-token completion ask, still `context_length_exceeded` at ~345 prompt
// tokens -- nowhere near the assumed 4096 window, and not fixable by
// trimming tool schemas further, since the failure isn't really about total
// prompt size (it reproduces at small sizes) but about `tools` + this
// model's forced reasoning trace together.
//
// Scoped Qwen3.5-2B to just reply generation (tools-free) to dodge that
// failure mode, but repeated live testing then found a second, separate
// problem: even scoped to that role, its thinking trace failed to close
// within any reasonable token budget in ~40-60% of trials, each failure
// costing 4-5 minutes before falling back to an error message. Reverted
// again, this time to Qwen3-4B-Instruct-2507 -- the same checkpoint
// previously served via QAIRT/NPU (see the RAM-curve history further down
// this file), now run through llama.cpp/GGUF instead. This model has no
// thinking-mode trace at all (confirmed via its model card and directly via
// this endpoint -- zero `<think>` tags across every trial), so it needs none
// of the budget/stripping complexity Qwen3.5-2B required: 100% success
// across all trials tested, replies in 16-27s, and a measured ~3.2-3.5GB
// GenieX process footprint -- smaller than the original QAIRT path's ~6GB
// free-RAM gate, since llama.cpp carries no NPU driver/context overhead.
//
// The role split itself stays regardless of which model is in the reply
// slot: the 1B has no reasoning-trace-driven budget blowup, so it stays on
// the classifier (`_plan_action_via_bridge`, agent_chat_service.py) which
// always attaches `tools`. The reply-generation model
// (`stream_response`) never attaches `tools` at all, so whichever model
// sits there never hits the tools-attachment failure mode above. Math/
// reasoning guardrail kept regardless (see local_math_guardrail in
// _build_local_bridge_messages) since no candidate model tested this session
// is safe to trust blind on arithmetic.
// No precision suffix here -- `geniex list`'s cache-check and the REST API's
// `model` field both accept the bare name when only one precision is cached
// (see the *_PRECISION constants for the one place a suffix is required).
const GENIEX_MODEL_ID = "unsloth/Qwen3-4B-Instruct-2507-GGUF"; // reply generation
const GENIEX_MODEL_PRECISION = "Q4_0";
const GENIEX_CLASSIFIER_MODEL_ID = "unsloth/Llama-3.2-1B-Instruct-GGUF"; // action-plan classifier
const GENIEX_CLASSIFIER_MODEL_PRECISION = "Q4_0";
const GENIEX_MODEL_HUB = "hf";
// GenieX auto-detects the Qwen3.5-2B repo as a "vlm" (vision-language model)
// despite it being text-only, which crashes `geniex serve` with
// "SDKError(Multimodal generation failed)" on the SECOND request in a
// session (confirmed live, twice, on a clean process: first call always
// succeeds, every call after fails) -- fatal for a persistent multi-turn
// server even though it's invisible in one-shot `geniex infer` testing.
// Forcing `--model-type llm` at pull time fixes the detection and the
// crash. Passed unconditionally below since it's also correct for the 1B.
const GENIEX_MODEL_TYPE = "llm";
const GENIEX_PORT = 18181;

// Must match local_bridge/server.py's BRIDGE_PORT. The bridge makes GenieX
// a spec-compliant, tool-calling-capable OpenAI backend (see that module's
// docstring) -- Kai's local mode (agent_chat_service.py's
// local_runtime_provider routing) talks to this port, never GenieX
// directly. It is our own code, not a vendored tool like GenieX, so it's
// spawned/packaged differently -- see _getLocalBridgeCommand.
const LOCAL_BRIDGE_PORT = 18182;

// Redefined here rather than imported from launcher/index.js (which doesn't
// export these) -- both files are the same depth under electron/main/services/,
// so this resolves to the identical BACKEND_DIR.
const DESKTOP_DIR = path.resolve(__dirname, "..", "..", "..", "..");
const BACKEND_DIR = path.resolve(DESKTOP_DIR, "backend");
const BACKEND_PYTHON_EXE = path.resolve(
    BACKEND_DIR,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python"
);

// Crash-recovery tuning -- bounded retries so a genuinely broken install
// doesn't loop forever. Originally sized around the QAIRT native crash
// (0xc0000005 under memory pressure); kept as-is since a bounded retry is
// reasonable insurance against a llama.cpp/CPU-GPU crash too, though none
// has been observed with this runtime yet. Reused as-is (same constants,
// separate counters) for the local bridge's own crash recovery below.
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const RESTART_DELAY_MS = 1500;

// With the hybrid split above, a single conversation turn can load BOTH
// models into the same GenieX process (1B for the classifier call, then
// Qwen3-4B for the reply) -- so the gate/working-set sizing below accounts
// for both potentially being resident, not just one. Real weight sizes:
// ~773MB (1B) + ~2.4GB (Qwen3-4B GGUF Q4_0) =~ 3.2GB combined. Directly
// measured GenieX process footprint with just Qwen3-4B loaded: ~3.2-3.5GB
// working set/private memory -- smaller than the original QAIRT path's ~6GB
// free-RAM gate (no NPU driver/context overhead in the llama.cpp runtime).
//
// Real degradation curve measured (controlled memory-pressure allocator +
// real tok/s measurement against a realistic ~800-token production prompt,
// both a short and a 900-token-completion generation, at each level):
//   2.10GB free: 9.6 / 9.7 tok/s   1.35GB free: 7.4 / 9.6 tok/s
//   0.83GB free: 7.0 / 9.6 tok/s   0.69GB free: 8.6 / 9.5 tok/s
//   0.63GB free: 7.9 / 9.6 tok/s   0.19GB free: 8.6 / 9.4 tok/s
// No degradation cliff found anywhere in this range -- long-generation
// throughput stayed flat (9.4-9.7 tok/s) all the way down to 190MB free;
// the short-prompt variance (7.0-9.6) didn't correlate with RAM level and
// looks like ordinary per-request noise, not RAM-driven decay. Far more
// resilient than either prior candidate (QAIRT Qwen3-4B collapsed 20x below
// ~1.3GB free; Qwen3.5-2B/llama.cpp degraded ~27% below 0.49GB). Stopped
// testing at 190MB free rather than pushing toward true system exhaustion,
// since that risks broader OS-level instability, not just GenieX slowness --
// so "no cliff below 190MB" is not the same claim as "no cliff at all."
// Gate dropped to a minimal 200MB floor on this evidence -- but note what
// the curve actually proved: an ALREADY-LOADED GenieX process tolerates
// pressure down to 190MB free with zero throughput loss. It says nothing
// about whether spawning fresh and loading ~3.2GB of new model weights
// succeeds cleanly when free RAM is already near-zero at spawn time --
// that's a different failure mode (allocation failure / system-wide
// instability under the load itself), untested here. 200MB is kept as a
// minimal safety floor against that untested case, not derived from the
// throughput curve the way the old multi-GB gate was. Caveat: the curve
// also tested only the reply-generation model (Qwen3-4B) resident alone,
// not the combined classifier+reply scenario noted above.
//
// Important tradeoff, not just a strength: this resilience and the 100%
// reliability (see agent_chat_service.py's stream_response comment) come at
// a real speed cost -- ~7-10 tok/s here, vs. the original QAIRT/NPU path's
// 23.1 tok/s rating (~16 tok/s real-world best case) and vs. Qwen3.5-2B's
// 23-27 tok/s when it happened to converge. llama.cpp here is CPU-only, no
// NPU offload. Live-tested in the running app and judged acceptable on
// feel/smoothness despite the lower raw number -- a deliberate reliability-
// over-speed tradeoff, not an oversight.
const MIN_FREE_RAM_BYTES = 0.2 * 1024 * 1024 * 1024;

// A working-set floor pin (forcing Windows to keep ~3.5GB permanently
// resident, even while GenieX sits idle) was carried from the earlier
// QAIRT/Qwen3.5-2B era, where it existed specifically to prevent the
// RAM-pressure paging/degradation documented above. The real degradation
// curve run for Qwen3-4B/llama.cpp found no such degradation at all, down
// to 190MB free -- so for this model, the pin was pure reserved memory
// with no protective benefit, working directly against a low idle
// footprint. Removed: see _pinGenieXWorkingSet's removal below. If a future
// model swap reintroduces real RAM-pressure sensitivity (re-run the mem_hog
// + tok/s curve methodology to check), reinstate a pin sized to that
// model's actual measured cliff, not a guess.

class ModelRegistry {
  constructor() {
    this.modelsDir = this._getModelsDir();
    this._ensureDirectory();
    // Cache for the "downloaded" state so getStatus() (polled by the UI) does
    // not shell out via a synchronous `geniex list` on every call and block the
    // Electron main-process event loop. null = unknown/needs recompute.
    this._downloadedCache = null;
    // Reason the last spawn attempt failed, if any (e.g. "insufficient_ram"),
    // surfaced to the renderer via getStatus() for a specific toast message.
    this._lastSpawnFailureReason = null;
    // The local bridge process (see LOCAL_BRIDGE_PORT) -- spawned/killed
    // alongside GenieX (this.aiProcess), not independently tracked in the
    // renderer-facing status beyond a simple running flag.
    this.bridgeProcess = null;
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
   * Resolves how to launch the local bridge. Unlike GenieX (an external
   * vendored tool bundled as-is via extraResources), the bridge is our own
   * code, packaged the same way the main backend itself is: a
   * PyInstaller-compiled exe in a packaged build (build:local-bridge --
   * see package.json), the backend's own venv python running uvicorn
   * directly in dev.
   */
  _getLocalBridgeCommand() {
    if (app.isPackaged) {
      return {
        command: path.join(process.resourcesPath, "local-bridge", "hushh-local-bridge.exe"),
        args: [],
        cwd: path.join(process.resourcesPath, "local-bridge"),
      };
    }
    return {
      command: BACKEND_PYTHON_EXE,
      args: ["-m", "uvicorn", "local_bridge.server:app", "--port", String(LOCAL_BRIDGE_PORT)],
      cwd: BACKEND_DIR,
    };
  }

  /**
   * Kills whatever is LISTENING on `port`, if anything, and waits for the
   * OS to actually release it. Fixes a real, live-reproduced EADDRINUSE on
   * LOCAL_BRIDGE_PORT (4 occurrences in one session before it happened to
   * stabilize): `_killLocalBridge()`'s taskkill is fire-and-forget (the
   * `exec` callback isn't awaited) and sets `this.bridgeProcess = null`
   * immediately, so a recovery/respawn can race a not-yet-released socket
   * from the process we just told Windows to kill. Separately, an orphaned
   * bridge from a prior dev session (e.g. a terminal-wrapped `uvicorn` that
   * outlived its wrapper -- TaskStop on a bash-wrapped command doesn't
   * kill the real child) can be sitting on the port with nothing in this
   * registry instance tracking it at all, so the `this.bridgeProcess`
   * guard above can't catch it either way. `netstat` + `taskkill` here
   * covers both cases regardless of which process (ours or orphaned) holds
   * the port. Scoped to LOCAL_BRIDGE_PORT specifically, which is assumed
   * exclusively ours (see the port's own definition above) -- same
   * assumption every other fixed-port service in this file already makes.
   */
  async _ensurePortFree(port) {
    const { exec } = require("child_process");
    const stdout = await new Promise((resolve) => {
      exec(`netstat -ano -p TCP`, (err, out) => resolve(err ? "" : out));
    });

    const pids = new Set();
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (match && Number(match[1]) === port) {
        pids.add(match[2]);
      }
    }
    if (pids.size === 0) return;

    console.warn(`[ModelRegistry] ⚠️ Port ${port} already held by PID(s) ${[...pids].join(", ")} -- clearing before spawn.`);
    await Promise.all(
      [...pids].map(
        (pid) =>
          new Promise((resolve) => {
            exec(`taskkill /PID ${pid} /F`, () => resolve());
          })
      )
    );
    // taskkill returning doesn't guarantee the OS has released the socket
    // yet -- give it a beat before the caller tries to bind.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  /**
   * Spawns the local bridge. Only ever called after GenieX itself is
   * confirmed online (see spawnLocalInferenceEngine) -- the bridge proxies
   * every request to GenieX, so starting it first would just mean every
   * request fails until GenieX catches up. Non-fatal if it can't start:
   * GenieX itself still comes up either way, this just means Kai local
   * chat (and any external MCP-style client pointed at the bridge) won't
   * work until it's addressed -- logged clearly, not silently swallowed.
   */
  async _spawnLocalBridge() {
    if (this.bridgeProcess) {
      console.log(`[ModelRegistry] Local bridge already running.`);
      return this.bridgeProcess;
    }

    const { spawn } = require("child_process");
    const waitOn = require("wait-on");
    const { command, args, cwd } = this._getLocalBridgeCommand();

    if (!fs.existsSync(command)) {
      console.warn(
        `[ModelRegistry] ⚠️ Local bridge executable not found at ${command} -- skipping. ` +
        "Kai local chat will not work without it. Build it with `npm run build:local-bridge` " +
        "for a packaged build, or ensure the backend venv exists for dev."
      );
      return null;
    }

    await this._ensurePortFree(LOCAL_BRIDGE_PORT);

    console.log(`[ModelRegistry] 🚀 Spawning local bridge from ${command} on port ${LOCAL_BRIDGE_PORT}...`);

    this.bridgeProcess = spawn(command, args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.bridgeProcess.stdout.on("data", (data) => {
      console.log(`[LocalBridge] ${data.toString().trim()}`);
    });
    this.bridgeProcess.stderr.on("data", (data) => {
      console.error(`[LocalBridge] ⚠️ ${data.toString().trim()}`);
    });

    this.bridgeProcess.on("exit", (code, signal) => {
      console.log(`[ModelRegistry] Local bridge exited with code ${code} and signal ${signal}`);
      this.bridgeProcess = null;
      // Torn down together with GenieX (see killLocalInferenceEngine): if
      // this is part of an intentional shutdown, or GenieX itself is
      // already gone (its own exit handler kills the bridge before
      // attempting GenieX's own recovery -- see below), don't treat this
      // as an independent bridge crash needing its own recovery.
      if (this._intentionalShutdown || !this.aiProcess) return;
      console.warn(`[ModelRegistry] ⚠️ Local bridge exited unexpectedly while GenieX is still running. Attempting automatic recovery.`);
      this._attemptBridgeRecovery();
    });

    try {
      await waitOn({
        resources: [`http-get://127.0.0.1:${LOCAL_BRIDGE_PORT}/v1/models`],
        interval: 500,
        timeout: 60000,
      });
      console.log(`[ModelRegistry] ✅ Local bridge is online and ready!`);
      return this.bridgeProcess;
    } catch (err) {
      console.error(`[ModelRegistry] ❌ Local bridge failed to come online:`, err);
      this._killLocalBridge();
      return null;
    }
  }

  /**
   * Bridge-specific crash recovery, separate from GenieX's own
   * _crashRestartState/_recoveryTimer -- a bridge-only fault (e.g. a Python
   * exception unrelated to GenieX) shouldn't consume or be conflated with
   * GenieX's own crash budget, even though both reuse the same bounded
   * MAX_RESTART_ATTEMPTS/RESTART_WINDOW_MS/RESTART_DELAY_MS tuning.
   */
  _attemptBridgeRecovery() {
    const now = Date.now();
    if (!this._bridgeCrashRestartState || now - this._bridgeCrashRestartState.windowStart > RESTART_WINDOW_MS) {
      this._bridgeCrashRestartState = { count: 0, windowStart: now };
    }
    this._bridgeCrashRestartState.count += 1;

    if (this._bridgeCrashRestartState.count > MAX_RESTART_ATTEMPTS) {
      console.error(
        `[ModelRegistry] ❌ Local bridge crashed ${this._bridgeCrashRestartState.count} times within ` +
        `${Math.round(RESTART_WINDOW_MS / 60000)} minutes. Giving up automatic recovery -- ` +
        `manual restart required.`
      );
      return;
    }

    console.log(
      `[ModelRegistry] 🔄 Attempting local bridge recovery ` +
      `(attempt ${this._bridgeCrashRestartState.count}/${MAX_RESTART_ATTEMPTS})...`
    );

    this._bridgeRecoveryTimer = setTimeout(() => {
      this._bridgeRecoveryTimer = null;
      this._spawnLocalBridge()
        .then((proc) => {
          if (proc) {
            console.log(`[ModelRegistry] ✅ Recovered from local bridge crash.`);
          } else {
            console.error(`[ModelRegistry] ❌ Recovery attempt failed to bring the local bridge back online.`);
          }
        })
        .catch((err) => {
          console.error(`[ModelRegistry] ❌ Local bridge recovery attempt threw:`, err);
        });
    }, RESTART_DELAY_MS);
  }

  /**
   * Kills the local bridge. Mirrors killLocalInferenceEngine's shape
   * (taskkill on the tree, kill() as a fallback) but kept separate since
   * it's called both standalone (GenieX's own exit handler kills the
   * bridge before attempting GenieX recovery) and as part of the combined
   * teardown in killLocalInferenceEngine.
   */
  _killLocalBridge() {
    if (this._bridgeRecoveryTimer) {
      clearTimeout(this._bridgeRecoveryTimer);
      this._bridgeRecoveryTimer = null;
    }
    if (!this.bridgeProcess) return;

    console.log(`[ModelRegistry] 🛑 Stopping local bridge...`);
    const pid = this.bridgeProcess.pid;
    if (pid && pid !== 99999) {
      const { exec } = require("child_process");
      exec(`taskkill /PID ${pid} /T /F`, (err) => {
        if (err) {
          console.error("Failed to kill local bridge process tree:", err);
        }
      });
    } else if (this.bridgeProcess.kill) {
      this.bridgeProcess.kill();
    }
    this.bridgeProcess = null;
  }

  /**
   * Pulls a single GenieX model into its local cache (idempotent -- skips if
   * already present, per `geniex list`). Internal helper for
   * provisionGenieXModel, which pulls both hybrid-role models below.
   */
  _pullOneGenieXModel(geniexExe, modelRef) {
    const { spawn } = require("child_process");
    return new Promise((resolve) => {
        // Precision suffix is required here even though the rest of the
        // codebase uses the bare model ID: these assets have 10+ cached
        // precision variants on their hub, and `geniex pull` without a
        // ':<precision>' suffix drops into an interactive picker -- which
        // would hang forever against this spawn's non-interactive stdio.
        // --model-type llm is required too: GenieX has been observed to
        // auto-detect some text-only repos (Qwen3.5-2B, tried and reverted
        // earlier this session) as a "vlm", which crashes `geniex serve`
        // after exactly one request (see GENIEX_MODEL_TYPE above) -- forcing
        // the correct type at pull time is what fixes that. Passed
        // unconditionally since it's harmless for models that are already
        // correctly auto-detected (the 1B, and Qwen3-4B-Instruct-2507).
        const pullProcess = spawn(geniexExe, [
            "pull", modelRef,
            "--model-hub", GENIEX_MODEL_HUB,
            "--model-type", GENIEX_MODEL_TYPE,
        ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

        this._pullProcess = pullProcess;

        pullProcess.stdout.on("data", (data) => {
            console.log(`[GenieX pull] ${data.toString().trim()}`);
        });
        pullProcess.stderr.on("data", (data) => {
            console.error(`[GenieX pull] ⚠️ ${data.toString().trim()}`);
        });

        pullProcess.on("exit", (code) => {
            this._pullProcess = null;
            resolve(code);
        });
    });
  }

  /**
   * Pulls both hybrid-role GenieX models into the local cache (idempotent --
   * skips whichever is already present, per `geniex list`). The classifier
   * (1B) and reply-generation (Qwen3-4B-Instruct-2507) models are split by
   * role -- see GENIEX_MODEL_ID's comment above for why -- so both must be
   * provisioned for local mode to work end-to-end, not just one.
   */
  async provisionGenieXModel(modelId = "Llama-3.2-3B-Instruct") {
    const geniexExe = this._getGenieXExePath();
    if (!geniexExe || !fs.existsSync(geniexExe)) {
        console.error(`[ModelRegistry] ❌ GenieX CLI not found at ${geniexExe}. Install GenieX CLI first.`);
        return { success: false, status: "error", error: "geniex_not_installed" };
    }

    if (this.verifyLocalInferenceEngine(modelId)) {
        console.log(`[ModelRegistry] ✅ Both hybrid-role models already cached, skipping pull.`);
        this._downloadedCache = true;
        return { success: true, status: "downloaded" };
    }

    this._cancelDownloadFlag = false;
    const { spawn } = require("child_process");

    const toPull = [
        { ref: `${GENIEX_MODEL_ID}:${GENIEX_MODEL_PRECISION}`, name: GENIEX_MODEL_ID },
        { ref: `${GENIEX_CLASSIFIER_MODEL_ID}:${GENIEX_CLASSIFIER_MODEL_PRECISION}`, name: GENIEX_CLASSIFIER_MODEL_ID },
    ];

    for (const { ref, name } of toPull) {
        if (this._cancelDownloadFlag) {
            console.log(`[ModelRegistry] 🛑 Download cancelled for ${modelId}.`);
            return { success: false, status: "cancelled" };
        }
        console.log(`[ModelRegistry] 🔄 Pulling ${name} via GenieX...`);
        const code = await this._pullOneGenieXModel(geniexExe, ref);
        if (this._cancelDownloadFlag) {
            console.log(`[ModelRegistry] 🛑 Download cancelled for ${modelId}.`);
            return { success: false, status: "cancelled" };
        }
        if (code !== 0) {
            console.error(`[ModelRegistry] ❌ geniex pull exited with code ${code} for ${name}.`);
            return { success: false, status: "error", error: `geniex pull exited with code ${code} for ${name}` };
        }
        console.log(`[ModelRegistry] ✅ Pull complete for ${name}.`);
    }

    this._downloadedCache = true;
    return { success: true, status: "downloaded" };
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
   * Requires BOTH hybrid-role models (see GENIEX_MODEL_ID's comment) to be
   * cached, since local mode needs both the classifier and reply-generation
   * models to function end-to-end.
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
        const cachedNames = new Set(cached.map((m) => m.name));
        const downloaded = cachedNames.has(GENIEX_MODEL_ID) && cachedNames.has(GENIEX_CLASSIFIER_MODEL_ID);
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
        this._lastSpawnFailureReason = "verification_failed";
        return null;
    }

    // Minimal safety gate against spawning into near-zero free RAM -- see
    // MIN_FREE_RAM_BYTES for what this does and doesn't protect against.
    const freeRamBytes = os.freemem();
    if (freeRamBytes < MIN_FREE_RAM_BYTES) {
        console.error(
            `[ModelRegistry] ❌ Refusing to spawn GenieX: only ${(freeRamBytes / 1024 ** 3).toFixed(2)}GB ` +
            `free, need ${(MIN_FREE_RAM_BYTES / 1024 ** 3).toFixed(2)}GB minimum to spawn safely.`
        );
        this._lastSpawnFailureReason = "insufficient_ram";
        return null;
    }
    this._lastSpawnFailureReason = null;

    console.log(`[ModelRegistry] 🚀 Spawning GenieX server from ${geniexExe} on port ${port}...`);

    // NOTE: `geniex serve` binds its own configured default port (GENIEX_PORT,
    // 18181); it does not take a port argument here. `port` therefore must match
    // that default -- it drives the readiness wait below, not the bind.
    this.aiProcess = spawn(geniexExe, ["serve"], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
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

        console.warn(`[ModelRegistry] ⚠️ GenieX server exited unexpectedly (code=${code}, signal=${signal}). Attempting automatic recovery.`);
        // The bridge is now pointing at a dead GenieX -- kill it too rather
        // than leave it running and erroring on every request. GenieX's own
        // recovery below will bring the bridge back once GenieX is
        // confirmed online again (see the success path just below).
        this._killLocalBridge();
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
        // Bridge depends on GenieX being up first -- only ever spawned here,
        // after that's confirmed. Non-fatal if it fails (see
        // _spawnLocalBridge): GenieX itself still comes up either way.
        await this._spawnLocalBridge();
        this.broadcastStatusChange(modelId);
        return this.aiProcess;
    } catch (err) {
        console.error(`[ModelRegistry] ❌ GenieX server failed to come online:`, err);
        this._lastSpawnFailureReason = "startup_timeout";
        this.killLocalInferenceEngine(modelId);
        return null;
    }
  }

  /**
   * Handles an unexpected GenieX exit by respawning it automatically, with a bounded
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
   * Kills the running GenieX server, and the local bridge with it (torn
   * down together -- see _spawnLocalBridge). Closing stdin (dead man's
   * switch) is GenieX's primary shutdown signal; taskkill is a forceful
   * fallback in case it doesn't exit on its own.
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
          // Set before killing the bridge too, so its own exit handler
          // (see _spawnLocalBridge) recognizes this as intentional and
          // doesn't try to recover it.
          this._intentionalShutdown = true;
          this._killLocalBridge();

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
   * Removes both hybrid-role models from GenieX's cache to reclaim SSD
   * space -- both need removing, not just one, or the other would be left
   * as orphaned dead weight on disk with no way to trigger local mode again.
   */
  async deleteLocalInferenceEngine(modelId = "Llama-3.2-3B-Instruct") {
      await this.killLocalInferenceEngine(modelId);

      const geniexExe = this._getGenieXExePath();
      if (!geniexExe || !fs.existsSync(geniexExe)) {
          console.warn(`[ModelRegistry] GenieX CLI not found, nothing to remove.`);
          return true;
      }

      const { execFileSync } = require("child_process");
      for (const name of [GENIEX_MODEL_ID, GENIEX_CLASSIFIER_MODEL_ID]) {
          try {
              execFileSync(geniexExe, ["remove", name, "--yes"], { encoding: "utf-8" });
              console.log(`[ModelRegistry] 🗑️ Removed ${name} from GenieX cache.`);
          } catch (err) {
              console.error(`[ModelRegistry] Failed to remove ${name}:`, err.message);
          }
      }
      this._downloadedCache = false;
      return true;
  }
  
  /**
   * Returns the current state for the UI polling.
   */
  getStatus(modelId = "Llama-3.2-3B-Instruct") {
      return {
          downloaded: this._isDownloadedCached(modelId),
          running: !!this.aiProcess,
          restarting: !!this._restarting,
          lastError: this._lastSpawnFailureReason,
          // Additive field: whether Kai's actual local-mode backend (the
          // bridge, not GenieX directly) is up. `running` alone can be true
          // while local chat still doesn't work if the bridge failed to
          // start (see _spawnLocalBridge) -- surfaced separately so the UI
          // isn't stuck inferring that from `running` alone.
          bridgeRunning: !!this.bridgeProcess,
      };
  }
}

// Export a singleton instance
const registry = new ModelRegistry();
module.exports = { registry, ModelRegistry };
