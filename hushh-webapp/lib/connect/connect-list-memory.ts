"use client";

import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { getAppScrollRoot } from "@/lib/navigation/use-scroll-reset";

type Entry = { owner: string; generation: number | null; savedAt: number; value: unknown };
const entries = new Map<string, Entry>();
let subscribed = false;

/** Short-lived navigation memory, never persisted or shared between accounts. */
export function readConnectListMemory<T>(owner: string | null | undefined, key: string): T | null {
  if (typeof window === "undefined" || !owner) return null;
  const entry = entries.get(key);
  if (!entry || entry.owner !== owner || entry.generation !== getAuthSessionGeneration() || Date.now() - entry.savedAt > 15 * 60_000) return null;
  return entry.value as T;
}

export function saveConnectListMemory<T>(owner: string | null | undefined, key: string, value: T): void {
  if (typeof window === "undefined" || !owner) return;
  if (!subscribed) {
    subscribeAuthSessionGeneration(() => entries.clear());
    subscribed = true;
  }
  entries.delete(key);
  entries.set(key, { owner, generation: getAuthSessionGeneration(), savedAt: Date.now(), value });
  if (entries.size > 8) entries.delete(entries.keys().next().value!);
}

export function connectListScrollTop(): number {
  return getAppScrollRoot()?.scrollTop ?? window.scrollY;
}

/** Shell and feature resets each settle on the next frame; restore afterwards. */
export function restoreConnectListScroll(top: number): () => void {
  let frame = 0;
  let remaining = 3;
  const restore = () => {
    if (--remaining > 0) { frame = requestAnimationFrame(restore); return; }
    const root = getAppScrollRoot();
    if (root) root.scrollTop = top;
    else window.scrollTo({ top, behavior: "instant" });
  };
  frame = requestAnimationFrame(restore);
  return () => cancelAnimationFrame(frame);
}
