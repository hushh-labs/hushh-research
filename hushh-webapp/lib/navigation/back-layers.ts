"use client";

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

type BackLayer = { pathname: string; depth: number; query?: Readonly<Record<string, string>>; back: () => boolean };
const layers: BackLayer[] = [];
const listeners = new Set<() => void>();
let revision = 0;
function changed() { revision++; listeners.forEach(listener => listener()); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function matching(pathname: string, query: { get(name: string): string | null } | null | undefined) {
  return layers.filter(layer => layer.pathname === pathname && Object.entries(layer.query ?? {}).every(([key, value]) => query?.get(key) === value));
}
export function useBackLayerAvailable(pathname: string, query?: { get(name: string): string | null }): boolean {
  useSyncExternalStore(subscribe, () => revision, () => 0);
  return matching(pathname, query).length > 0;
}

/** Route-scoped, process-local UI callbacks; never persist private feature state. */
export function registerBackLayer(layer: BackLayer): () => void {
  if (!Number.isInteger(layer.depth) || layer.depth < 1) throw new Error("Back depth must be a positive integer");
  layers.push(layer);
  changed();
  return () => {
    const index = layers.indexOf(layer);
    if (index >= 0) { layers.splice(index, 1); changed(); }
  };
}

export function unwindBackLayer(pathname: string, query?: { get(name: string): string | null } | null): boolean {
  const active = matching(pathname, query)
    .sort((a, b) => b.depth - a.depth || layers.indexOf(b) - layers.indexOf(a));
  for (const layer of active) if (layer.back()) return true;
  return false;
}

export function useBackLayer(pathname: string, depth: number, back: () => boolean, query?: Readonly<Record<string, string>>): void {
  const current = useRef(back);
  useLayoutEffect(() => { current.current = back; }, [back]);
  const queryKey = JSON.stringify(query ?? {});
  useEffect(() => {
    if (depth < 1) return;
    return registerBackLayer({ pathname, depth, query: JSON.parse(queryKey), back: () => current.current() });
  }, [pathname, depth, queryKey]);
}

/** Dispatch Escape through the owning overlay so dismissal refusal stays authoritative. */
export function dismissTopmostOverlay(doc: Document = document): boolean {
  const open = doc.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
  const top = open[open.length - 1];
  if (!top) return false;
  const active = doc.activeElement;
  const target = active instanceof HTMLElement && top.contains(active) ? active : top;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  return true;
}
