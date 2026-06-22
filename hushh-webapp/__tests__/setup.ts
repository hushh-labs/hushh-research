/// <reference types="node" />

/**
 * Vitest Test Setup
 *
 * Configures mock environment for API route testing and JSDOM compatibility.
 */

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

  class LocalStorageMock {
    private store: Record<string, string> = {};

    clear() {
      this.store = {};
    }

    getItem(key: string) {
      return this.store[key] || null;
    }

    setItem(key: string, value: string) {
      this.store[key] = String(value);
    }

    removeItem(key: string) {
      delete this.store[key];
    }

    get length() {
      return Object.keys(this.store).length;
    }

    key(i: number) {
      const keys = Object.keys(this.store);
      return keys[i] || null;
    }
  }

  // Mock localStorage
  Object.defineProperty(window, "localStorage", {
    value: new LocalStorageMock(),
    writable: true,
  });

  // Mock sessionStorage
  Object.defineProperty(window, "sessionStorage", {
    value: new LocalStorageMock(),
    writable: true,
  });
}

/**
 * Reset all mocks between tests to prevent state leakage.
 * This ensures each test starts with a clean slate.
 */
beforeEach(() => {
  vi.clearAllMocks();
});
