"use client";

export type HapticPattern = number | number[];

const DEFAULT_TOGGLE_HAPTIC_PATTERN_MS = 10;

function normalizeHapticPattern(pattern: HapticPattern): HapticPattern | null {
  if (typeof pattern === "number") {
    return Number.isFinite(pattern) && pattern >= 0 ? pattern : null;
  }

  if (!Array.isArray(pattern)) {
    return null;
  }

  const normalized = pattern.filter(
    (value) => Number.isFinite(value) && value >= 0
  );

  return normalized.length > 0 ? normalized : null;
}

function isBrowserVibrationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.vibrate === "function"
  );
}

export function triggerToggleHaptic(
  pattern: HapticPattern = DEFAULT_TOGGLE_HAPTIC_PATTERN_MS
): boolean {
  if (!isBrowserVibrationSupported()) {
    return false;
  }

  const normalizedPattern = normalizeHapticPattern(pattern);
  if (normalizedPattern === null) {
    return false;
  }

  try {
    return navigator.vibrate(normalizedPattern);
  } catch {
    return false;
  }
}
