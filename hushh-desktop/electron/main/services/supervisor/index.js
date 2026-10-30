"use strict";

const { spawn } = require("child_process");
const waitOn = require("wait-on");
const { getRuntimeContext } = require("../runtime");
const { startBackend, startFrontend } = require("../launcher");

/** @type {import("child_process").ChildProcess | null} */
let frontendProc = null;
/** @type {import("child_process").ChildProcess | null} */
let backendProc = null;

// Track crash counts to prevent infinite restart loops
let backendCrashCount = 0;
let frontendCrashCount = 0;
const MAX_RESTARTS = 3;

/**
 * Kill a process tree.
 * @param {import("child_process").ChildProcess | null} proc
 * @param {string} label
 */
function killTree(proc, label) {
  if (!proc || proc.exitCode !== null) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    console.log(`[supervisor] Sent taskkill to ${label} (pid ${proc.pid})`);
  } else {
    proc.kill("SIGTERM");
    console.log(`[supervisor] Sent SIGTERM to ${label} (pid ${proc.pid})`);
  }
}

/**
 * Monitors child process exits and triggers recovery.
 * @param {import("child_process").ChildProcess} proc
 * @param {string} name
 * @param {() => import("child_process").ChildProcess} restartFn
 */
function registerLifecycleMonitor(proc, name, restartFn) {
  proc.on("exit", (code, signal) => {
    if (code !== null && code !== 0 && signal !== "SIGTERM") {
      console.error(`[supervisor] ⚠ ${name} exited unexpectedly (code=${code}, signal=${signal})`);
      
      // Attempt recovery
      if (name === "BACKEND" && backendCrashCount < MAX_RESTARTS) {
        backendCrashCount++;
        const delay = backendCrashCount * 2000;
        console.log(`[supervisor] Recovering ${name} in ${delay}ms... (Attempt ${backendCrashCount}/${MAX_RESTARTS})`);
        setTimeout(() => {
          backendProc = restartFn();
          registerLifecycleMonitor(backendProc, name, restartFn);
        }, delay);
      } else if (name === "FRONTEND" && frontendCrashCount < MAX_RESTARTS) {
        frontendCrashCount++;
        const delay = frontendCrashCount * 2000;
        console.log(`[supervisor] Recovering ${name} in ${delay}ms... (Attempt ${frontendCrashCount}/${MAX_RESTARTS})`);
        setTimeout(() => {
          frontendProc = restartFn();
          registerLifecycleMonitor(frontendProc, name, restartFn);
        }, delay);
      } else {
        console.error(`[supervisor] ❌ ${name} reached max crash restarts. Halting recovery.`);
      }
    } else {
      console.log(`[supervisor] ${name} exited cleanly (code=${code}, signal=${signal})`);
    }
  });
}

/**
 * Spawns both frontend and backend child processes and begins monitoring.
 */
function spawnProcesses() {
  console.log("[supervisor] Spawning services...");
  
  backendProc = startBackend();
  registerLifecycleMonitor(backendProc, "BACKEND", startBackend);
  
  frontendProc = startFrontend();
  registerLifecycleMonitor(frontendProc, "FRONTEND", startFrontend);
}

/**
 * Wait until both services respond on their expected ports.
 * @returns {Promise<void>}
 */
async function waitForServices() {
  const context = getRuntimeContext();
  console.log(`[supervisor] Waiting for backend  → ${context.backendURL}/docs`);
  console.log(`[supervisor] Waiting for frontend → ${context.frontendURL}`);

  await waitOn({
    resources: [
      `http-get://127.0.0.1:${context.backendPort}/docs`,
      `http-get://localhost:${context.frontendPort}`,
    ],
    interval: 500,     // poll every 500 ms
    timeout: 180_000,  // give up after 3 minutes
    validateStatus: (status) => status < 400,
    strictSSL: false,
  });

  console.log("[supervisor] ✓ Both services are ready.");
}

/**
 * Gracefully terminate both child process trees.
 */
function shutdownServices() {
  console.log("[supervisor] Shutting down child processes...");
  
  // Clear crash recovery thresholds
  backendCrashCount = MAX_RESTARTS;
  frontendCrashCount = MAX_RESTARTS;
  
  killTree(frontendProc, "FRONTEND");
  killTree(backendProc,  "BACKEND");
  
  frontendProc = null;
  backendProc  = null;
}

module.exports = {
  spawnProcesses,
  waitForServices,
  shutdownServices,
};
