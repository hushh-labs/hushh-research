# Packaging & Distribution Pipeline Guide

This document describes how the Hushh Desktop app compiles, packages, and distributes production binaries, with focus on Windows ARM64 compatibility.

---

## 🏗️ The Build Pipeline

Packaging the application consists of three main phases:
1. **Frontend Compilation**: Compiles the Next.js React frontend into a standalone build.
2. **Backend Bundling**: Prepares the FastAPI python scripts and dependency manifests.
3. **Electron Builder Assembly**: Bundles Next.js, Python, Node, Chromium, and native node modules into a final archive/installer.

### Build Commands
To run the full production compilation loop:
```bash
npm run dist
```
This triggers the `electron-builder` script defined in `package.json`.

---

## 📦 Standalone Next.js Build
In standard Next.js, page serving relies on dynamic Node.js compilation. For a lightweight desktop client, we compile Next.js in **standalone mode**:
- Configured in `next.config.ts`: `output: 'standalone'`.
- Next.js automatically bundles all necessary server files, node modules, and routing configs into a single `server.js` file and a `.next/standalone/` output folder.
- This standalone output is copied directly into Electron's resource workspace and executed by `launcher.js` at runtime.

---

## 🐍 Embedding Python
To ensure the user doesn't need to install Python separately:
- **File Bundling**: The `build.files` array in `package.json` includes `"**/*.py"` and `"!venv/**/*"`. This packages your complete FastAPI python backend codebase directly into Electron's `appDir`.
- **Runtime Virtual Environment**: The production build extracts the Python files into a local folder on the user's filesystem and resolves the system-level python interpreter. (Future iterations will bundle a fully self-contained, pre-compiled Python binary to eliminate system interpreter dependencies).

---

## 💻 Windows ARM64 Target (Portable ZIP)

During development of the Desktop Alpha, we resolved a critical packaging bug native to Windows 11 running on ARM64 processors.

### The NSIS/MSI Silent Drop Bug
- **The Issue**: Standard Windows installer builders (WiX/MSI and 32-bit NSIS installers) would compile successfully, but during installation on Windows 11 ARM64, the extraction engine would silently drop the main `Hushh Desktop.exe` and some associated `.dll` files. This resulted in empty installation folders or missing executables.
- **The Solution**: We switched the default target of `electron-builder` from `nsis` (installer `.exe`) to `zip` for Windows ARM64 builds:
  ```json
  "win": {
    "target": "zip",
    "arch": ["arm64"]
  }
  ```
- **Portable Distribution**: The app is distributed as a portable, standalone `.zip` file. When extracted by the user, the operating system's native extraction mechanism handles the files correctly, ensuring the `Hushh Desktop.exe` is fully intact and ready to launch.

---

## 🔐 Code Signing

For production distribution, we code sign all executables (`.exe` and `.dll` binaries) to avoid Windows SmartScreen blockages:
- Configured via signtool path overrides in the `electron-builder` pipeline.
- Signs the `Hushh Desktop.exe` during the package assembly phase before generating the portable ZIP file.
