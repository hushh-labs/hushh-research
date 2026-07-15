# Hushh Desktop Developer Guide

Welcome to the development guide for the Hushh Desktop client. This document outlines how to set up, run, and debug the desktop environment locally, as well as how to extend it.

---

## 🛠️ Prerequisites & Setup

Ensure you have the following installed on your machine:
- **Node.js** (v18+ recommended)
- **Python** (3.10+ recommended)
- **Git**

### Installation
1. Clone the repository and navigate to the desktop directory:
   ```bash
   cd hushh-desktop
   ```
2. Install npm dependencies:
   ```bash
   npm install
   ```
3. Set up the Python virtual environment for the backend:
   ```bash
   cd backend
   python -m venv .venv
   # Windows:
   .venv\Scripts\activate
   # macOS/Linux:
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

---

## 🚀 Running the App in Development Mode

Unlike a web app, the desktop app requires starting multiple servers simultaneously:
1. The **FastAPI Python Backend** (port 8000)
2. The **Next.js Standalone server** (port 3001)
3. The **Electron container** (which wraps the webview and injects native APIs)

To run the full dev loop:
```bash
npm start
```

### Process Lifecycle Manager (`launcher.js`)
When you start the application, Electron executes `electron/main/launcher.js` which acts as our process supervisor. It performs the following sequence:
1. **Reads Environment Variables**: It parses `.env.local` and `.env.production` manually, merging them into `process.env`.
2. **Launches the Python Backend**: Spawns `uvicorn server:app` on port 8000.
3. **Launches the Next.js Standalone server**: Spawns the compiled `server.js` frontend.
4. **Bootstraps Electron**: Creates the `BrowserWindow` pointing to localhost and loads `preload.js` to bridge communications.

---

## ☠️ Handling Zombie Processes

Because the Python backend runs as a child process spawned by Node, if the Electron window is closed forcefully (e.g. via task manager or IDE crashes), the Python server may remain running in the background as an orphan ("zombie") process. 

This locks port `8000` and will prevent subsequent startup attempts (showing `ECONNREFUSED` or port-conflict errors).

### Releasing the Port
If the server fails to boot because the port is in use:
- **Windows (PowerShell)**:
  ```powershell
  Stop-Process -Name "python", "uvicorn", "node" -Force
  ```
- **macOS/Linux**:
  ```bash
  killall python uvicorn node
  ```

---

## 🌉 IPC & Capacitor Preload Bridge

The frontend communicates with Electron using Capacitor plugins. Under the hood, these are bridged using Electron's `contextBridge` inside `electron/preload/preload.js`.

### How to Add a Native API Hook
1. **Define IPC Handler in Electron** (`electron/main/ipc/`):
   ```javascript
   const { ipcMain } = require('electron');
   ipcMain.handle('my-custom-action', async (event, args) => {
     // Run native Node.js or OS operations here
     return { success: true };
   });
   ```
2. **Bridge in Preload Script** (`electron/preload/preload.js`):
   ```javascript
   contextBridge.exposeInMainWorld('MyCapacitorPlugin', {
     customAction: (args) => ipcRenderer.invoke('my-custom-action', args)
   });
   ```
3. **Invoke in Frontend**:
   ```typescript
   if (window.MyCapacitorPlugin) {
     const result = await window.MyCapacitorPlugin.customAction(args);
   }
   ```
