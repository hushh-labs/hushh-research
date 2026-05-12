// __tests__/setup.ts

import { vi, beforeEach } from "vitest";

// Mock environment variables for testing
process.env.NEXT_PUBLIC_APP_ENV = "development";
process.env.BACKEND_URL = "http://localhost:8000";
process.env.NODE_ENV = "test";

// Mock fetch globally
global.fetch = vi.fn();

// Mock matchMedia for JSDOM environments
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
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

// Reset mocks between tests to prevent state leakage
beforeEach(() => {
  vi.clearAllMocks();
});