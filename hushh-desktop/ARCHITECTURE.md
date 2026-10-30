# Hushh Desktop Architecture

This document describes the foundational architecture of the Hushh Desktop application. It enforces a strict boundary between the main repository and the desktop codebase, ensuring all desktop-specific orchestration remains self-contained.

## 1. Folder Layout

The `hushh-desktop` directory is structured as follows:

```text
hushh-desktop/
├── electron/          # Electron shell process scripts
│   ├── main/          # Electron main process (Node.js)
│   │   ├── launcher.js # Process orchestrator (Next.js server & Python FastAPI)
│   │   └── main.js    # Window and app lifecycle management
│   ├── preload/       # Preload scripts (Context bridge)
│   │   └── preload.js # Maps native Capacitor plugins to Electron IPC
│   └── ipc/           # IPC handlers (capabilities, runtime, settings, etc.)
├── config/            # Shared runtime configuration (e.g. port allocations)
├── frontend/          # Standalone Next.js frontend build (copied from hushh-webapp)
├── backend/           # Embedded Python backend codebase (copied from consent-protocol)
├── docs/              # Developer guides and packaging pipeline docs
├── sync/              # Manifests tracking original commit baselines
└── installer/         # Packaging build outputs (untracked, portable ZIP)
```

## 2. Desktop/Web Integration Philosophy

- **Standalone Next.js standalone server**: We compile the Next.js frontend (`frontend/`) in `standalone` mode, which generates a minimal self-contained Node server (`server.js`). Electron boots this standalone server locally.
- **Embedded Python Backend**: The FastAPI Python backend is packaged directly in the bundle (`backend/`) and executed in a virtual environment by `launcher.js` on port 8000.
- **Unified Launch Orchestrator (`launcher.js`)**: Coordinates the boot sequence of both frontend and backend child processes, manually parses `.env.local` and `.env.production` at startup, and pipes standard streams to the console/logs.

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
