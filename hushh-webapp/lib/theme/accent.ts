"use client";

/**
 * App accent preference: "blue" (iOS Blue, default) or "gold" (Molten Gold).
 *
 * Mirrors the next-themes pattern for a single custom axis:
 * - persisted in localStorage under ACCENT_STORAGE_KEY
 * - projected onto <html data-accent="..."> (absent for the default)
 * - applied pre-hydration by the inline no-FOUC script in app/layout.tsx
 *
 * The accent is PRESENTATION ONLY. It never reaches the backend, the voice
 * wire contract, or any policy/validation path (see Morphy AX governance:
 * assessment validation must not branch on accent).
 */

import { useSyncExternalStore } from "react";

export type AppAccent = "blue" | "gold";

export const ACCENT_STORAGE_KEY = "hushh.app.accent.v1";
export const DEFAULT_ACCENT: AppAccent = "blue";
export const ACCENT_CHANGED_EVENT = "hushh:accent-changed";

const ACCENT_VALUES: readonly AppAccent[] = ["blue", "gold"];

export function normalizeAccent(value: unknown): AppAccent {
  return ACCENT_VALUES.includes(value as AppAccent)
    ? (value as AppAccent)
    : DEFAULT_ACCENT;
}

export function readAccent(): AppAccent {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  try {
    return normalizeAccent(window.localStorage.getItem(ACCENT_STORAGE_KEY));
  } catch {
    return DEFAULT_ACCENT;
  }
}

function applyAccentAttribute(accent: AppAccent): void {
  if (typeof document === "undefined") return;
  if (accent === DEFAULT_ACCENT) {
    document.documentElement.removeAttribute("data-accent");
  } else {
    document.documentElement.setAttribute("data-accent", accent);
  }
}

export function writeAccent(value: AppAccent): AppAccent {
  const accent = normalizeAccent(value);
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    // Private mode / storage denied: still apply for this session.
  }
  applyAccentAttribute(accent);
  window.dispatchEvent(
    new CustomEvent(ACCENT_CHANGED_EVENT, { detail: accent }),
  );
  return accent;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(ACCENT_CHANGED_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(ACCENT_CHANGED_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

/** Reactive accent value for preference UI. */
export function useAccent(): AppAccent {
  return useSyncExternalStore(subscribe, readAccent, () => DEFAULT_ACCENT);
}

/**
 * Inline script body for app/layout.tsx <head>: applies the persisted accent
 * before first paint so a gold-preference user never flashes blue.
 * Kept dependency-free and try/catch-safe for SSR string embedding.
 */
export const ACCENT_NO_FOUC_SCRIPT = `try{var a=localStorage.getItem(${JSON.stringify(
  ACCENT_STORAGE_KEY,
)});if(a==="gold"){document.documentElement.setAttribute("data-accent","gold");}}catch(e){}`;
