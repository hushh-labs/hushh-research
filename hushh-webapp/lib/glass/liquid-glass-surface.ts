"use client";

/**
 * liquid-glass-surface — single coordinator for the @ybouane/liquidglass
 * WebGL engine on the pre-auth surfaces ("/" welcome, "/login").
 *
 * WHY A SINGLETON STORE (not React context): the agent bar is mounted from
 * app/providers.tsx in a different subtree than the route screens, yet its
 * pill must join the SAME LiquidGlass instance as the screen's own glass
 * elements. The library only refracts sibling content inside one root, and
 * glass elements must be DIRECT children of that root, so all consumers
 * meet here: the screen registers its <main> as the root, and every glass
 * consumer (CTA, action sheet, agent pill) registers its element.
 *
 * WHY DESTROY + RE-INIT: LiquidGlass.init() takes a fixed glassElements
 * set; elements cannot be added to a live instance. Registration changes
 * are debounced (INIT_SETTLE_MS, matching the layout-settle delay the
 * welcome CTA always used) and rebuild the instance with the full set.
 *
 * WHY DYNAMIC import(): "use client" components still server-render; a
 * top-level import would evaluate the WebGL/DOM bundle during SSR. The
 * engine only ever loads in the browser, inside the debounced rebuild.
 */

import { useSyncExternalStore } from "react";
import type { GlassConfig } from "@ybouane/liquidglass";

interface LiquidGlassInstance {
  destroy(): void;
}

const INIT_SETTLE_MS = 250;

interface GlassSurfaceStore {
  root: HTMLElement | null;
  elements: Set<HTMLElement>;
  instance: LiquidGlassInstance | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Bumped on every rebuild/teardown so stale async inits self-destroy. */
  generation: number;
  listeners: Set<() => void>;
}

const store: GlassSurfaceStore = {
  root: null,
  elements: new Set(),
  instance: null,
  timer: null,
  generation: 0,
  listeners: new Set(),
};

function emit(): void {
  for (const listener of store.listeners) listener();
}

function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

function teardownInstance(): void {
  store.generation += 1;
  if (store.timer !== null) {
    clearTimeout(store.timer);
    store.timer = null;
  }
  store.instance?.destroy();
  store.instance = null;
}

async function rebuild(): Promise<void> {
  const generation = ++store.generation;
  store.instance?.destroy();
  store.instance = null;

  const root = store.root;
  if (!root || !root.isConnected) return;

  // The library itself warns-and-skips nested elements; filtering here keeps
  // a mis-parented consumer from silently shrinking the working set later.
  const glassElements = [...store.elements].filter(
    (el) => el.isConnected && el.parentElement === root,
  );
  if (glassElements.length === 0) return;

  try {
    const { LiquidGlass } = await import("@ybouane/liquidglass");
    const instance = await LiquidGlass.init({ root, glassElements });
    if (generation !== store.generation) {
      // A newer registration change or teardown superseded this init.
      instance.destroy();
      return;
    }
    store.instance = instance;
  } catch (err) {
    console.error("liquid-glass-surface: init failed:", err);
  }
}

function schedule(): void {
  if (typeof window === "undefined") return;
  if (store.timer !== null) clearTimeout(store.timer);
  store.timer = setTimeout(() => {
    store.timer = null;
    void rebuild();
  }, INIT_SETTLE_MS);
}

/**
 * Register the screen's glass root (the positioned container whose direct
 * children are refracted). Returns a cleanup that tears the surface down.
 * One root at a time: a new registration supersedes the previous one.
 */
export function registerGlassRoot(el: HTMLElement): () => void {
  teardownInstance();
  store.root = el;
  emit();
  schedule();
  return () => {
    if (store.root !== el) return;
    teardownInstance();
    store.root = null;
    emit();
  };
}

/**
 * Stock presets lifted verbatim from the library demo site's float panels
 * ("Frosted Glass" / "Dark Glass"). These are the ONLY sanctioned tunings
 * for the pre-auth surfaces: light theme uses FROSTED, dark theme uses
 * DARK. Per-element geometry (cornerRadius, button) is layered on by the
 * caller when writing data-config.
 */
export const GLASS_PRESET_FROSTED: Partial<GlassConfig> = {
  blurAmount: 0.5,
};

export const GLASS_PRESET_DARK: Partial<GlassConfig> = {
  brightness: -0.3,
  blurAmount: 0.4,
};

/**
 * Register a glass element (MUST be rendered as a direct child of the
 * registered root). Tuning goes through the element's data-config (the
 * engine's official MutationObserver-watched channel), which callers own:
 * set it before/after registration freely, including theme swaps. An
 * optional initial config is written here as a convenience. Returns a
 * cleanup.
 */
export function registerGlassElement(
  el: HTMLElement,
  config?: Partial<GlassConfig>,
): () => void {
  if (config) {
    el.dataset.config = JSON.stringify(config);
  }
  store.elements.add(el);
  schedule();
  return () => {
    if (!store.elements.delete(el)) return;
    delete el.dataset.config;
    schedule();
  };
}

/**
 * Subscribe to the currently registered glass root. The agent bar uses this
 * to portal its pill into the screen's root as a direct child.
 */
export function useGlassSurfaceRoot(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => store.root,
    () => null,
  );
}
