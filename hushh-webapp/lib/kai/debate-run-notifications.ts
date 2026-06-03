"use client";

type DebateToastApi = {
  info?: (message: string, options?: Record<string, unknown>) => unknown;
  error?: (message: string, options?: Record<string, unknown>) => unknown;
  message?: (message: string, options?: Record<string, unknown>) => unknown;
};

type DebateAlreadyRunningOptions = {
  description?: string;
  action?: Record<string, unknown>;
  level?: "info" | "error";
};

const DEBATE_ALREADY_RUNNING_TOAST_DEBOUNCE_MS = 3500;
let lastDebateAlreadyRunningToastAt = 0;

export function showDebateAlreadyRunningToast(
  toastApi: DebateToastApi,
  options: DebateAlreadyRunningOptions = {},
): boolean {
  const now = Date.now();
  if (now - lastDebateAlreadyRunningToastAt < DEBATE_ALREADY_RUNNING_TOAST_DEBOUNCE_MS) {
    return false;
  }
  lastDebateAlreadyRunningToastAt = now;

  const method =
    options.level === "error"
      ? toastApi.error || toastApi.info || toastApi.message
      : toastApi.info || toastApi.message || toastApi.error;
  if (!method) return false;

  method("A debate is already running.", {
    description: options.description || "Open the active debate before starting a new one.",
    ...(options.action ? { action: options.action } : {}),
  });
  return true;
}
