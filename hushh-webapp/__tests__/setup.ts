/// <reference types="node" />

/**
 * Vitest Test Setup
 *
 * Configures mock environment for API route testing and JSDOM compatibility.
 */

import "@testing-library/jest-dom";
import { vi, beforeEach } from "vitest";

// Mock environment variables for testing
// The 'process' object is now recognized thanks to the node reference above
process.env.NEXT_PUBLIC_APP_ENV = "development";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY =
  "AIzaSyDummylocaltestkey000000000000000000";
process.env.BACKEND_URL = "http://localhost:8000";
process.env.NODE_ENV = "test";

// Mock fetch globally using globalThis for better compatibility across environments
globalThis.fetch = vi.fn();

// Mock matchMedia for JSDOM environments
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // Deprecated
      removeListener: vi.fn(), // Deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

class MemoryStorage implements Storage {
  #store = new Map<string, string>();

  get length() {
    return this.#store.size;
  }

  clear() {
    for (const key of Array.from(this.#store.keys())) {
      this.removeItem(key);
    }
  }

  getItem(key: string) {
    const normalizedKey = String(key);
    return this.#store.has(normalizedKey) ? this.#store.get(normalizedKey)! : null;
  }

  key(index: number) {
    return Array.from(this.#store.keys())[index] ?? null;
  }

  removeItem(key: string) {
    const normalizedKey = String(key);
    this.#store.delete(normalizedKey);
    delete (this as unknown as Record<string, unknown>)[normalizedKey];
  }

  setItem(key: string, value: string) {
    const normalizedKey = String(key);
    const normalizedValue = String(value);

    this.#store.set(normalizedKey, normalizedValue);

    if (
      normalizedKey !== "length" &&
      !Object.prototype.hasOwnProperty.call(MemoryStorage.prototype, normalizedKey)
    ) {
      Object.defineProperty(this, normalizedKey, {
        configurable: true,
        enumerable: true,
        get: () => this.#store.get(normalizedKey),
        set: (nextValue: string) => {
          this.setItem(normalizedKey, nextValue);
        },
      });
    }
  }
}

function installMemoryStorageConstructor() {
  if (typeof window === "undefined") {
    return;
  }

  const storageConstructor = MemoryStorage as unknown as typeof Storage;

  Object.defineProperty(window, "Storage", {
    configurable: true,
    value: storageConstructor,
  });
  Object.defineProperty(globalThis, "Storage", {
    configurable: true,
    value: storageConstructor,
  });
}

function ensureWebStorage(name: "localStorage" | "sessionStorage") {
  if (typeof window === "undefined") {
    return;
  }

  let storage: Storage | undefined;

  try {
    storage = window[name];
  } catch {
    storage = undefined;
  }

  if (!storage) {
    installMemoryStorageConstructor();
    storage = new Storage();
    Object.defineProperty(window, name, {
      configurable: true,
      value: storage,
    });
  }

  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: storage,
  });
}

ensureWebStorage("localStorage");
ensureWebStorage("sessionStorage");

// JSDOM has no ResizeObserver. cmdk (used by the Command/CommandList
// primitives) observes its list element on mount, so any test that renders a
// cmdk-based component needs this polyfill or React logs an unhandled
// ReferenceError from the passive effect.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverMock {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}

// JSDOM has no IntersectionObserver. embla-carousel-react (SwipeViews' swipe
// engine) initializes a SlidesInView plugin on mount that requires it, so any
// test rendering a SwipeViews-based page needs this polyfill or React logs an
// unhandled ReferenceError from the passive effect.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class IntersectionObserverMock {
    root = null;
    rootMargin = "";
    thresholds: ReadonlyArray<number> = [];
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
  }
  globalThis.IntersectionObserver =
    IntersectionObserverMock as unknown as typeof IntersectionObserver;
}

// JSDOM also has no scrollIntoView. cmdk calls this on the selected item's
// layout effect to keep it in view, which throws in JSDOM without a stub.
if (typeof window !== "undefined" && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

/**
 * Reset all mocks between tests to prevent state leakage.
 * This ensures each test starts with a clean slate.
 */
beforeEach(() => {
  vi.clearAllMocks();
});
