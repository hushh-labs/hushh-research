# Changelog

## [desktop-alpha-v0.1.0] - 2026-06-30

### 🚀 Desktop Alpha Release

This release marks the first alpha version of the Hushh Desktop application, bringing the web app and Python backend into a single, cohesive, offline-capable desktop environment.

### 🏗️ New Desktop Architecture
- **Unified Executable**: Packaged the Next.js frontend, Python FastAPI backend, and Capacitor native plugins into a single, double-clickable portable executable using Electron.
- **Embedded Python**: The backend is securely embedded within the Electron application bundle, spinning up silently on an available port at startup and securely injecting its port into the frontend environment.
- **Native Context Bridge**: Leveraged Capacitor and Electron's `contextBridge` via `preload.js` to securely expose native APIs (like `HushhAuth`, `HushhVault`, and `HushhConsent`) directly to the Next.js React frontend, replacing web-only fallbacks.

### 📦 Packaging Approach
- **Portable ZIP for ARM64**: We moved away from MSI and standard NSIS executable installers for Windows ARM64 platforms due to an installer extraction bug. We are currently shipping the app as a portable, standalone `.zip` folder. When extracted, the internal `.exe` runs perfectly natively on ARM64 processors without requiring Rosetta/emulation or a heavy installer.
- **Environment Injection**: Next.js standalone builds do not automatically read `.env` files in production. We successfully engineered a lightweight custom environment parser in the Electron `launcher.js` to inject all necessary Firebase credentials and configurations into both the Node.js and Python processes before they spawn.

### 🛡️ Graceful Offline Handling
- Implemented `VaultNetworkError` circuit breakers across the Vault and Authentication surfaces. If the Python backend fails or the host goes offline, the UI now displays a graceful "Server Unreachable" fallback rather than infinitely looping or spamming console errors.

### ⚠️ Known Limitations
- The Python backend relies on standard process management (`child_process.spawn`). Zombie Python processes can occasionally survive an ungraceful Electron exit.
- Firebase Push Notifications (FCM) are currently unsupported in the desktop environment (throws harmless VAPID warnings).
- Native installer features (desktop shortcuts, Start Menu entries, auto-updaters) are unavailable in the portable ZIP build.

### 💻 Tested Windows Versions
- **Windows 11 ARM64** (Native execution confirmed)

### 🔮 Future Beta Goals
- Implement a foolproof, zero-zombie background process manager for the Python backend.
- Resolve the NSIS extraction bug upstream or build a custom lightweight installer for ARM64.
- Integrate Electron Auto-Updater.
- Enable full native push notifications using Electron's desktop notification bridge instead of FCM.
