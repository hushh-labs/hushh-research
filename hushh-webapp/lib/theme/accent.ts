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

/**
 * The accent, resolved to a literal colour.
 *
 * For consumers that cannot resolve a CSS custom property at all. The app's
 * own surfaces should never need this — they take `var(--app-accent)` and the
 * cascade does the work — but two kinds of consumer live outside the cascade:
 *
 * - a native bridge. `@capacitor/google-maps` hands circle and polyline
 *   options straight to `new google.maps.Circle` on web, which falls back to
 *   its OWN defaults on an unparseable colour, and to `UIColor(hex:) ?? .blue`
 *   on iOS. Both failures look deliberate, which is how a check-in radius ring
 *   shipped in Google's default black-on-grey for as long as it did.
 * - an email body. Mail clients strip custom properties (see the SOS mail
 *   renderer, allowlisted in `scripts/design/verify-accent-tokens.mjs` for the
 *   same reason).
 *
 * Reading the computed value rather than hardcoding a hex is what keeps the
 * accent PREFERENCE working: under `html[data-accent="gold"]` the token is a
 * different colour, and a literal would quietly ignore that.
 *
 * The fallback is only reachable off the browser, before first paint, or if
 * the token resolves to something that is not a literal colour — a `var()`
 * chain or an empty string. It is written from the palette rather than typed
 * as a hex so this module stays the single place either palette is named.
 */
const ACCENT_FALLBACK_CHANNELS: Readonly<Record<AppAccent, readonly [number, number, number]>> =
  {
    blue: [0, 122, 255],
    gold: [212, 165, 116],
  };

function channelsToHex([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** `--app-accent` as a literal `#rrggbb`, for a consumer outside the cascade. */
export function resolvedAccentHex(): string {
  const fallback = () => channelsToHex(ACCENT_FALLBACK_CHANNELS[readAccent()]);
  if (typeof window === "undefined" || typeof document === "undefined") {
    return channelsToHex(ACCENT_FALLBACK_CHANNELS[DEFAULT_ACCENT]);
  }
  try {
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue("--app-accent")
      .trim();
    // Only a literal colour is useful downstream. A token that resolves to
    // another var(), or to nothing during first paint, must not reach a
    // consumer that cannot resolve it either.
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(resolved)
      ? resolved
      : fallback();
  } catch {
    return fallback();
  }
}
