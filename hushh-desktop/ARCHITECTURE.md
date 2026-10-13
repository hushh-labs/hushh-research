# Hushh Desktop Architecture

This document describes the foundational architecture of the Hushh Desktop application. It enforces a strict boundary between the main repository and the desktop codebase, ensuring all desktop-specific orchestration remains self-contained.

## 1. Folder Layout

The `hushh-desktop` directory is structured as follows:

```text
hushh-desktop/
├── electron/              # Electron shell process scripts
│   ├── main/              # Electron main process (Node.js)
│   │   ├── main.js        # Entry point: registers IPC, orchestrates startup
│   │   ├── services/      # Modular main-process services (see below)
│   │   │   ├── runtime/       # Shared RuntimeContext (ports, URLs, dev/prod)
│   │   │   ├── ports/         # Free-port allocation
│   │   │   ├── environment/   # .env parsing + per-machine key generation
│   │   │   ├── launcher/      # Builds backend/frontend spawn commands
│   │   │   ├── supervisor/    # Spawns/monitors/recovers child processes
│   │   │   ├── models/        # On-device AI (GenieX) lifecycle (registry.js)
│   │   │   └── logging/       # Tees console + child streams to log files
│   │   └── ipc/           # IPC handlers (platform, runtime, models, settings, …)
│   └── preload/           # Preload scripts (contextBridge → window.hushh)
├── ai-library/            # On-device AI assets
│   └── geniex/            # Portable GenieX runtime bundled via extraResources
├── frontend/              # Next.js frontend (shared hushh-webapp codebase)
├── backend/               # FastAPI backend (PyInstaller-compiled for release)
├── docs/                  # Developer guide, pipeline, known issues
├── sync/                  # Manifests tracking original commit baselines
└── installer/             # Packaging build outputs (untracked, portable ZIP)
```

> **Note:** The Alpha's monolithic `electron/main/launcher.js` has been replaced
> by the modular `electron/main/services/` layout above. `launcher/` now only
> builds spawn commands; `supervisor/` owns process lifecycle. See
> [docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md).

## 2. Desktop/Web Integration Philosophy

- **Standalone Next.js server**: We compile the Next.js frontend (`frontend/`) in `standalone` mode, which generates a minimal self-contained Node server (`server.js`). Electron boots this standalone server locally. (In dev, `next dev` is used instead.)
- **Embedded Python Backend**: For release, the FastAPI backend is compiled to a single `hushh-backend.exe` via PyInstaller and spawned directly — no system Python required. In dev it runs via `uvicorn --reload` from `backend/.venv`.
- **Service-based orchestration**: `main.js` registers IPC handlers, then `services/supervisor` spawns and monitors the backend and frontend child processes. `services/environment` parses `.env*` and injects it into both; `services/runtime` allocates ports and builds the shared runtime context. Streams are teed to log files by `services/logging`.
- **On-device inference**: `services/models/registry.js` manages the GenieX NPU engine (`localhost:18181`) — provisioning, spawn/kill, and bounded crash recovery.

## 3. IPC Philosophy & Preload Context Bridge

The Inter-Process Communication (IPC) bridge is the backbone of the desktop app.
- **Preload Script (`preload.js`)**: Leverages Electron's `contextBridge` to securely expose native APIs (such as `HushhAuth`, `HushhVault`, and `HushhConsent`) directly to the Next.js React frontend.
- **Plugin Emulation**: By routing Capacitor calls through `preload.js` and IPC handlers, we simulate full native mobile plugin capabilities directly inside Chromium, avoiding web-only fallbacks.
- **Process Communication**: Node.js APIs and OS filesystem capabilities are kept isolated within the Electron main process, exposing only namespaced functions to the frontend.

## 4. Capability Discovery

The UI relies on `window.hushh.capabilities.get()` to discover available runtimes and hardware specs. Capability discovery is structured as follows:

```ts
{
  hardware: {
    cpu: { vendor: "...", model: "...", cores: 12 },
    gpu: { available: true, vendor: "Qualcomm" },
    npu: { available: false, provider: null }
  }
}
```

## 5. Runtimes vs Inference Engines
- **Application Runtime**: Electron, Node, Python (the underlying stack).
- **Inference Engine**: Cloud, Ollama, ONNX, QNN, llama.cpp (the backend executing the models).

The desktop app abstracts inference backends through a unified provider interface.

## 6. Storage Layer
Local persistence is kept strictly independent of the UI layer in `hushh-desktop/storage/`. This layer includes interfaces like `SettingsStore`, `ModelStore`, `DownloadStore`, and `BenchmarkStore` for managing application state on disk.

## 7. Model Lifecycle & Download Service
- **Downloads Service**: Manages transfers for models, LoRA adapters, tokenizers, runtime binaries, and plugins. It exposes a unified interface (`start`, `pause`, `resume`, `cancel`).
- **Models**: Managed via `desktop-ui/core/models`, responsible for `list`, `delete`, and interfacing with benchmarks.
- **Benchmarks**: Allows the user to compare different models across CPU, GPU, NPU, and Cloud.

## 8. Plugin Architecture
Plugins are explicitly defined with strict permissions and capabilities:

```ts
interface Plugin {
  id: string;
  name: string;
  version: string;
  permissions: string[];
  capabilities: ('OCR' | 'Speech' | 'Vision' | 'Filesystem' | 'Network' | 'Finance')[];
}
```
The runtime determines what each plugin is allowed to access.
