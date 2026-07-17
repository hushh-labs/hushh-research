"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app } = require("electron");

// Must match OneWindows.Daemon/Program.cs's `McpPort` constant. Fixed (not
// dynamically allocated like frontend/backend) so external MCP clients
// (Hermes, Claude Desktop, etc.) have one address to configure once,
// mirroring the Mac reference daemon's own fixed loopback port choice.
const DAEMON_PORT = 31070;
const DAEMON_HEALTH_URL = `http://127.0.0.1:${DAEMON_PORT}/health`;

const DESKTOP_DIR = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * Resolves the OneWindows.Daemon executable. Packaged builds ship a
 * `dotnet publish` output under resources/windows-daemon (see
 * package.json's extraResources -- built via `npm run build:daemon`
 * before packaging), mirroring exactly how GenieX's own exe is bundled
 * (see ModelRegistry._getGenieXExePath). Dev runs use the same publish
 * output in place, at windows-daemon/publish/OneWindows.Daemon.
 * @returns {string}
 */
function getDaemonExePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "windows-daemon", "OneWindows.Daemon.exe");
  }
  return path.resolve(DESKTOP_DIR, "windows-daemon", "publish", "OneWindows.Daemon", "OneWindows.Daemon.exe");
}

/**
 * @returns {Promise<boolean>}
 */
async function isDaemonHealthy() {
  try {
    const response = await fetch(DAEMON_HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort: starts the OneWindows MCP daemon if it isn't already
 * reachable. Deliberately NOT part of the app's required startup path --
 * unlike backend/frontend, this never blocks or fails app launch, and it
 * is spawned detached + unref'd so its lifetime is independent of
 * Electron's. The daemon is meant to keep serving other local MCP clients
 * (Hermes, etc.) even after this app window closes, matching the Mac
 * reference daemon's "runs in the background regardless of the GUI app"
 * design -- so shutdownServices() intentionally does not touch it.
 *
 * @returns {Promise<void>}
 */
async function ensureDaemonRunning() {
  if (process.platform !== "win32") return;

  if (await isDaemonHealthy()) {
    console.log("[daemon] OneWindows daemon already running, leaving it alone.");
    return;
  }

  const daemonExe = getDaemonExePath();
  if (!fs.existsSync(daemonExe)) {
    console.warn(
      `[daemon] OneWindows.Daemon.exe not found at ${daemonExe} -- skipping. ` +
      "Build it with `npm run build:daemon` if you want it available."
    );
    return;
  }

  console.log("[daemon] Starting OneWindows daemon...");
  const daemonProc = spawn(daemonExe, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  daemonProc.on("error", (err) => {
    console.warn("[daemon] Failed to spawn OneWindows.Daemon.exe:", err);
  });
  daemonProc.unref();

  // Kestrel start-up took ~600-700ms in local testing; poll briefly rather
  // than judging health off a single immediate check.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isDaemonHealthy()) {
      console.log("[daemon] OneWindows daemon responding.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.warn("[daemon] OneWindows daemon spawned but did not respond within 10s.");
}

module.exports = {
  ensureDaemonRunning,
};
