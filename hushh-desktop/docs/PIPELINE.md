# Packaging & Distribution Pipeline Guide

How the Hushh Desktop app compiles, packages, and distributes production
binaries, with focus on Windows ARM64 (Snapdragon). For the day-to-day dev
setup see [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md); for open issues see
[KNOWN_ISSUES.md](./KNOWN_ISSUES.md).

---

## 🏗️ The Build Pipeline

A full production build has **three** stages, run in order:

### 1. Frontend — Next.js standalone
```bash
cd frontend && npm run build
```
This runs `next build --webpack` (`output: "standalone"` in `next.config.ts`)
**and then** `scripts/postbuild-standalone-assets.mjs`.

> ⚠️ **Critical:** Next.js standalone output does **not** include `.next/static`
> or `public/` — the standalone `server.js` expects them copied in as siblings.
> The postbuild script does exactly that
> (`.next/static` → `.next/standalone/frontend/.next/static`,
> `public` → `.next/standalone/frontend/public`). Without this step the packaged
> app boots the server but every JS/CSS chunk 404s, so the window hangs forever
> on a blank "Loading…" screen with no error. This bit us once — do not remove
> the postbuild step or revert `build` to a bare `next build`.

### 2. Backend — PyInstaller onefile
```bash
npm run build:backend      # -> cd backend && uv run build-backend.py
```
Compiles the FastAPI backend into a single `backend/dist/hushh-backend.exe`
(~160 MB). `build-backend.py` declares the hidden imports (uvicorn loops/
protocols, sqlalchemy async, asyncpg, psycopg2, cryptography) and bundles the
runtime data files (`db/offline_schema.sql`, `hushh_mcp/agents`, `contracts`).
This replaces the old "ship raw `**/*.py` + resolve a system Python" approach —
end users need no Python installed.

### 3. Electron Builder — assembly
```bash
npm run dist               # -> electron-builder
```
Bundles the standalone frontend, `hushh-backend.exe`, the Electron/Node/Chromium
runtime, and the **GenieX AI runtime** into the final portable `.zip`.

> The three stages are **not** chained by a single script yet — run them in
> order (frontend build → backend build → dist) when producing a release. If you
> only changed frontend code you can rerun stages 1 + 3; only backend, stages
> 2 + 3.

---

## 📦 What ships (`package.json` → `build`)

`files` (into `resources/app/`):
- `electron/**/*`, `package.json`
- `frontend/.next/standalone/**/*` (the self-contained Next server + static + public)
- `frontend/.env*`, `backend/.env` — **see the secrets caveat in KNOWN_ISSUES.md**
- `backend/dist/hushh-backend.exe`

`extraResources` (into `resources/`, outside the app tree):
- `ai-library/geniex` → `resources/geniex` — the portable GenieX CLI runtime
  (`geniex.exe`, `geniex.dll`, `llama_cpp/`, `qairt/`, ~255 MB). Bundling this
  means the reviewer/end user does **not** need to run GenieX's own Inno Setup
  installer. `registry.js` resolves `process.resourcesPath/geniex/geniex.exe`
  when `app.isPackaged`.

Not shipped (downloaded on first use): the ~3.2 GB Qwen3-4B NPU model weights,
pulled via `geniex pull` into GenieX's own cache the first time the user enables
on-device AI.

---

## 🧩 `asar: false`

The build sets `"asar": false` deliberately. The Next.js standalone server needs
`sharp` (a native `.node` binding) and the backend/GenieX executables must be
spawned as real files on disk — none of which run from inside an asar archive.
electron-builder prints an `asar usage is disabled — strongly not recommended`
warning on every build; **this is expected and can be ignored** for this project.
(Trade-off: the packaged app is many loose files rather than one archive.)

---

## 💻 Windows ARM64 Target (Portable ZIP)

### The NSIS/MSI silent-drop bug
Standard Windows installer builders (WiX/MSI and 32-bit NSIS) compile fine but,
on Windows 11 ARM64, the extraction engine silently drops the main
`Hushh Desktop.exe` and some `.dll` files — producing empty/broken installs.

### The fix
Target `zip` instead of an installer:
```json
"win": { "target": "zip" }
```
The OS's own extractor handles the archive correctly, keeping the executable
intact. The app is distributed as a portable, standalone folder.

---

## 🔐 Code Signing

Executables (`.exe`/`.dll`) are signed via `signtool.exe` during the assembly
phase (both `hushh-backend.exe` and `Hushh Desktop.exe`) to reduce SmartScreen
friction, before the portable ZIP is produced.

---

## 🏷️ Release artifact convention

The final artifact is `installer/Hushh Desktop-<version>-arm64-win.zip`. When
extracting a build for review/testing, name the folder with the stage, version,
and the **short commit hash** it was built from, e.g.:

```
installer/Hushh Desktop Beta 1.0.0 (b7d56e4a6)/
```

so any given build is traceable back to the exact source state.

---

## 🧪 Post-build smoke test (do this before handing off a build)

Building successfully does **not** prove the app runs — several past breakages
(stuck Loading screen, missing runtime) only surfaced at launch. Minimum checks:

1. Extract the zip fresh and launch `Hushh Desktop.exe`.
2. Confirm the UI renders past "Loading…" (proves static assets are in place).
3. Confirm sign-in / vault unlock works (proves backend booted + env injected).
4. If testing on-device AI: enable the toggle, let the model download, and
   confirm a chat message streams a real response from the NPU.
