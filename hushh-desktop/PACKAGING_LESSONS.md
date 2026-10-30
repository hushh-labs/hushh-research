# Packaging Lessons for Hushh Desktop (Alpha)

Documenting the challenges and solutions encountered while building the first packaged Alpha release of the Hushh Desktop app.

## ARM64 Packaging Quirks & Installer Issues
- **MSI/WiX Issues on ARM64**: The initial attempts to build an MSI installer using `electron-builder` with WiX failed or produced non-functional installers on Windows 11 ARM64.
- **NSIS Silent Drop Bug**: Switching to NSIS (`.exe`) compiled successfully, but the installer would silently drop/fail to extract the actual executable (`Hushh Desktop.exe`) and some `.dll` files into the `AppData/Local/Programs` folder during installation on ARM64. 
- **The Solution**: We bypassed installers entirely for the Alpha by changing the `electron-builder` target to `zip`. This produces a portable, standalone folder where the executable is safely extracted by the OS without NSIS interference.

## .env Handling in Next.js Standalone Mode
- **The Problem**: While `npm run dev` magically loads `.env.local`, the Next.js `standalone` production build does *not* automatically parse `.env` files. This caused the backend to miss `FIREBASE_ADMIN_CREDENTIALS_JSON`, leading to `401 Unauthorized` errors when unlocking the Vault.
- **The Solution**: We added a custom, lightweight `.env` parser directly into the Electron `launcher.js` script. Before the Node.js server or Python backend spawns, `launcher.js` reads `.env.local` and `.env.production` manually and injects them into `process.env`.

## Electron Preload Path Gotchas
- **The Problem**: When moving from development to a packaged production build, the relative directory structure (`__dirname`) changes. Our `main.js` was referencing `path.resolve(__dirname, "..", "..", "preload", "preload.js")`.
- **The Consequence**: This resulted in an `ENOENT` (File Not Found) error for `preload.js`. Because `preload.js` failed to load, Capacitor's native bridge broke, and native plugins (`HushhAuth`, `HushhVault`) fell back to web mode. This caused "Missing Firebase ID Token" errors because the web mode lacked the native auth session.
- **The Solution**: Corrected the path in `main.js` to `path.resolve(__dirname, "..", "preload", "preload.js")`, correctly matching the unpacked `resources/app/electron/` structure.

## Python Packaging Requirements
- **The Problem**: By default, `electron-builder` ignores non-JS files unless explicitly told otherwise. Our Python backend scripts were being stripped out of the final package.
- **The Solution**: We had to update the `build.files` array in `package.json` to explicitly include all Python files (`"**/*.py"`, `"!venv/**/*"`). We also ensured that the backend process was spawned safely with the exact available ports and environment variables passed down from the Electron launcher.
- **Zombie Process Warning**: Standard `child_process.spawn` does not guarantee cleanup of the Python subprocess on Windows if Electron is forcefully killed. We had to write manual cleanup loops (and occasionally run `Stop-Process` during dev iterations) to free up port 8000. Future builds need a more robust process supervisor.
