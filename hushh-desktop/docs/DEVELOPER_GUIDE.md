# Hushh Desktop Developer Guide

Development guide for the Hushh Desktop client. Covers local setup, the runtime
architecture, the on-device AI stack, and debugging. For packaging/distribution
see [PIPELINE.md](./PIPELINE.md); for the current known issues see
[KNOWN_ISSUES.md](./KNOWN_ISSUES.md).

> **Platform note:** The desktop app is currently built and tested for
> **Windows 11 on ARM64 (Snapdragon)**. The on-device AI path (GenieX/QAIRT)
> is Snapdragon-NPU–specific. macOS/Linux are not yet supported targets.

---

## 🛠️ Prerequisites & Setup

- **Node.js** v18+ (Electron 42 bundles its own Node for runtime; this is for tooling)
- **Python** 3.13 (backend) — managed via [`uv`](https://docs.astral.sh/uv/)
- **uv** — Python package/venv manager (`pip install uv` or the standalone installer)
- **Git**

### Installation

```bash
cd hushh-desktop

# 1. Electron / build tooling deps
npm install

# 2. Backend Python environment (creates backend/.venv from the lockfile)
cd backend
uv sync
cd ..

# 3. Frontend deps
cd frontend
npm install
cd ..
```

Environment files required at repo paths (not committed):
- `frontend/.env.local` — `NEXT_PUBLIC_*` Firebase config, backend URL, etc.
- `backend/.env` — DB, Firebase admin, and integration secrets.

> ⚠️ These `.env` files currently ship inside the packaged app. This is
> acceptable only for solo/internal builds — see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md)
> ("Secrets shipped in the installer").

---

## 🚀 Running the App in Development Mode

```bash
npm start
```

`npm start` runs `electron .`, which boots `electron/main/main.js`. In dev mode
(`!app.isPackaged`) the main process spins up three things:

1. **FastAPI backend** — `uvicorn server:app --reload` from `backend/.venv`, on a
   dynamically-allocated port (nominally 8000).
2. **Next.js dev server** — `next dev` on a dynamically-allocated port (nominally 3001).
3. **Electron `BrowserWindow`** — loads the frontend URL once both services respond.

Ports are resolved at runtime via `services/ports` (falls back to the next free
port if the default is taken), so multiple instances or a leftover process won't
hard-block startup.

### Main-process service layout

The old monolithic `launcher.js` has been replaced by focused modules under
`electron/main/services/`:

| Module | Responsibility |
| --- | --- |
| `runtime/` | Builds the shared `RuntimeContext` (ports, URLs, dev/prod flag) and writes it to disk for child processes. |
| `ports/` | Finds free TCP ports before spawning. |
| `environment/` | Parses `.env*` files and injects them into child `process.env`; generates machine-specific `VAULT_DATA_KEY` / `APP_SIGNING_KEY` into `userData/backend.env` on first launch. |
| `launcher/` | Builds the spawn commands for the backend and frontend (dev vs. packaged). |
| `supervisor/` | Spawns both child processes, monitors exits, restarts on unexpected crash (bounded, max 3), and tears the tree down on quit. |
| `models/registry.js` | Manages the on-device AI engine (GenieX) lifecycle — see below. |
| `logging/` | Tees `console.log` and child stdout/stderr into `frontend.log` / `backend.log` / `electron.log`. |

IPC handlers live under `electron/main/ipc/` (`platform`, `runtime`, `models`,
`settings`, `filesystem`, `capabilities`) and are all registered in `main.js`
before any window is created.

### Dev vs. Production launch matrix

| | Backend | Frontend |
| --- | --- | --- |
| **Dev** (`npm start`) | `python -m uvicorn server:app --reload` from `backend/.venv` | `next dev` |
| **Packaged** | `backend/dist/hushh-backend.exe` (PyInstaller onefile) | Next.js **standalone** `server.js` via bundled Node |

---

## 🧠 On-Device AI (GenieX / Snapdragon NPU)

The local chat path runs a quantized LLM entirely on the Snapdragon NPU via
Qualcomm's **GenieX** CLI (an OpenAI-compatible inference server on
`localhost:18181`).

- **Model:** `qualcomm/qwen3_4b_instruct_2507` (Qwen3-4B-Instruct, W4A16, QAIRT/NPU),
  pulled from Qualcomm AI Hub. (Meta's Llama variants aren't available as
  pre-compiled QAIRT assets due to licensing — hence Qwen.)
- **Runtime resolution** (`services/models/registry.js`, `_getGenieXExePath`):
  - **Packaged:** uses the GenieX runtime bundled at `resources/geniex/geniex.exe`
    (shipped via `extraResources`), so end users don't need a separate install.
  - **Dev:** uses the system install at `%LOCALAPPDATA%\GenieX CLI\geniex.exe`.
- **Populating `ai-library/geniex` for release builds:** this folder is the source
  of the bundled runtime but is **gitignored** (too large to commit, ~255 MB).
  Before running `npm run dist`, populate it by copying the runtime from the
  GenieX CLI install:
  ```bash
  cp -r "$LOCALAPPDATA/GenieX CLI/{geniex.exe,geniex.dll,llama_cpp,qairt}" \
    hushh-desktop/ai-library/geniex/
  ```
  (Install the GenieX CLI first if it's not present. Only these four entries are
  needed — the model weights are not bundled.)
- **Model storage:** GenieX manages its own model cache; the model itself
  (~3.2 GB) is **downloaded on first use** via `geniex pull`, not bundled.
- **Lifecycle:** `provisionGenieXModel` (pull) → `spawnLocalInferenceEngine`
  (`geniex serve`, dead-man's-switch on stdin) → `killLocalInferenceEngine`.
  Unexpected exits trigger bounded auto-recovery (`_attemptCrashRecovery`, max 3
  restarts / 5 min) for the occasional native QAIRT crash under memory pressure.
- **Frontend wiring:** the "On-device AI" toggle in `app/profile/page.tsx` drives
  `window.hushh.models.{install,spawn,kill,remove,status}`. When the engine is
  running, `agent-chat-workspace.tsx` sets `runtimeCredentialMode: "local"` so the
  agent chat streams from GenieX instead of the cloud model.

See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) for the current performance and
provisioning caveats of this path.

---

## 🔐 Environment & Key Handling

`services/environment/index.js` resolves env in this precedence:

- **Frontend:** `.env.production` < `.env` < `.env.local` (later wins).
- **Backend:** bundled `backend/.env` < per-machine `userData/backend.env`.

On first launch, if `userData/backend.env` is absent, a fresh 32-byte
`VAULT_DATA_KEY` and `APP_SIGNING_KEY` are generated and persisted there — so
each install gets machine-specific crypto material rather than a shared default.

---

## ☠️ Handling Zombie Processes

The backend and frontend run as child processes of Electron. The `supervisor`
tears down the process tree on `before-quit` (via `taskkill /T /F` on Windows),
but a forceful kill of Electron (Task Manager, IDE crash) can still orphan a
child, locking its port and causing `ECONNREFUSED`/port-conflict on the next
boot. Because ports are now allocated dynamically, a stray process usually just
shifts the next launch to a different port rather than blocking it — but to
reclaim a specific port:

- **Windows (PowerShell):**
  ```powershell
  Stop-Process -Name "hushh-backend","node" -Force
  ```
- **macOS/Linux:**
  ```bash
  killall node
  ```

---

## 🌉 IPC & Preload Bridge

The frontend talks to the Electron main process through a `contextBridge` in
`electron/preload/preload.js`, exposed under the `window.hushh` namespace.

### Adding a native API hook

1. **Handler** (`electron/main/ipc/<domain>.js`):
   ```javascript
   const { ipcMain } = require("electron");
   ipcMain.handle("hushh:models:status", async (_event, modelId) => {
     return registry.getStatus(modelId);
   });
   ```
2. **Bridge** (`electron/preload/preload.js`):
   ```javascript
   contextBridge.exposeInMainWorld("hushh", {
     models: {
       status: (modelId) => ipcRenderer.invoke("hushh:models:status", modelId),
     },
   });
   ```
3. **Invoke** (frontend):
   ```typescript
   const status = await window.hushh?.models?.status("Llama-3.2-3B-Instruct");
   ```

> Note: the internal model id string is still `"Llama-3.2-3B-Instruct"` for
> IPC/bookkeeping continuity; the actual model served is Qwen3-4B (see the
> GenieX section). This is intentional and load-bearing across the IPC boundary —
> don't rename it without updating both sides.

---

## 🪵 Logs

Runtime logs are written under Electron's `userData` directory:
- `frontend.log` — Next.js server output
- `backend.log` — FastAPI / uvicorn output
- `electron.log` — main-process orchestration

These are the first place to look when a packaged build misbehaves.
