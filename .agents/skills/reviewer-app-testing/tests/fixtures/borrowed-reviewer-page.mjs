/** Minimal fake browser with owner-generation and per-client route ownership. */
import assert from "node:assert/strict";

export function borrowedPage(appOrigin) {
  const priorWindow = globalThis.window;
  const state = { ownerMatches: true, authReady: true, unlocked: true, authGeneration: 1, vaultEpoch: 2 };
  const events = new Map(), routes = new Set(["another-agent-handler"]);
  const frame = { parentFrame: () => null };
  const absent = { isVisible: async () => false, first() { return this; } };
  globalThis.window = { location: new URL(appOrigin + "/one"), dispatchEvent(event) {
    if (event.type === "hushh:native-test-config-updated" && window.__HUSHH_NATIVE_TEST__) {
      const bridge = window.__HUSHH_NATIVE_TEST__;
      bridge.reviewerSessionSnapshot = () => ({ ...state });
      bridge.bootstrapUserId = "synthetic-owner"; bridge.bootstrapState = "vault_unlocked";
    }
    if (event.type === "app-internal-navigation-requested") {
      window.location = new URL(event.detail.href, appOrigin);
      for (const handler of events.get("framenavigated") || []) handler(frame);
    }
  } };
  const page = {
    isClosed: () => false, url: () => window.location.href, mainFrame: () => frame,
    route: async (_pattern, handler) => routes.add(handler), unroute: async (_pattern, handler) => routes.delete(handler),
    on(name, handler) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(handler); },
    off(name, handler) { events.get(name)?.delete(handler); },
    evaluate: async (fn, args) => fn(args),
    evaluateHandle: async (fn, args) => { const cleanup = fn(args); return { evaluate: async fn => fn(cleanup), dispose: async () => {} }; },
    waitForFunction: async (fn, args) => { assert.ok(fn(args)); },
    locator: () => absent, getByRole: () => absent,
    goto() { throw new Error("Borrowed page must never load a document"); },
    close() { throw new Error("Borrowed page must never close"); },
  };
  return { page, state, routes, events, restore() { globalThis.window = priorWindow; } };
}
