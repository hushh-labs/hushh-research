"use client";

import { morphyToast } from "@/lib/morphy-ux/morphy";

export const SANDBOX_CUTOVER_PILL_STORAGE_KEY = "hussh:sandbox-cutover-pill";

let lastCutoverToastAtMs = 0;

export function emitSandboxCutoverReadyToast(options?: {
  backgroundCleanupQueued?: boolean;
}): void {
  const now = Date.now();
  if (now - lastCutoverToastAtMs < 1500) return;
  lastCutoverToastAtMs = now;
  morphyToast.success("Personal Sandbox is ready", {
    description: options?.backgroundCleanupQueued
      ? "Prior cloud cleanup is finishing in the background."
      : undefined,
    duration: 4000,
  });
}

export function __resetSandboxCutoverToastForTests(): void {
  lastCutoverToastAtMs = 0;
}
