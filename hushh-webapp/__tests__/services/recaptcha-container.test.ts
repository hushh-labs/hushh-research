import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before vi.mock() calls
// ---------------------------------------------------------------------------

const { mockAuth, mockRecaptchaVerifierInstance, MockRecaptchaVerifier } =
  vi.hoisted(() => {
    const mockInstance = {
      render: vi.fn().mockResolvedValue(42), // widget ID
      clear: vi.fn(),
    };

    // Wrap in a real function so `new MockCtor(...)` works as a constructor.
    // Arrow functions cannot be called with `new`.
    const MockCtor = vi.fn(function MockRecaptchaVerifier() {
      return mockInstance;
    });

    return {
      mockAuth: { settings: {} },
      mockRecaptchaVerifierInstance: mockInstance,
      MockRecaptchaVerifier: MockCtor,
    };
  });

vi.mock("@/lib/firebase/config", async () => {
  // We want to test the REAL module functions, but with Firebase mocked out.
  // Import the actual module through the test re-export below.
  return {
    auth: mockAuth,
  };
});

vi.mock("firebase/app", () => ({
  initializeApp: vi.fn(),
  getApps: vi.fn(() => [{ name: "test" }]),
  getApp: vi.fn(() => ({ name: "test" })),
}));

vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(() => mockAuth),
  RecaptchaVerifier: MockRecaptchaVerifier,
}));

vi.mock("@/lib/observability/env", () => ({
  resolveAnalyticsMeasurementId: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// We can't import the config module directly because it's mocked above.
// Instead, we import the real implementation via importActual.
// ---------------------------------------------------------------------------

let getRecaptchaVerifier: typeof import("@/lib/firebase/config").getRecaptchaVerifier;
let prepareRecaptchaVerifier: typeof import("@/lib/firebase/config").prepareRecaptchaVerifier;
let resetRecaptcha: typeof import("@/lib/firebase/config").resetRecaptcha;

beforeEach(async () => {
  // Import the real module (bypassing the mock) so we can test the actual
  // getRecaptchaVerifier / resetRecaptcha implementations.
  const real = await vi.importActual<typeof import("@/lib/firebase/config")>(
    "@/lib/firebase/config"
  );
  getRecaptchaVerifier = real.getRecaptchaVerifier;
  prepareRecaptchaVerifier = real.prepareRecaptchaVerifier;
  resetRecaptcha = real.resetRecaptcha;
});

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function createContainer(id = "recaptcha-container"): HTMLDivElement {
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const div = document.createElement("div");
  div.id = id;
  div.classList.add("mt-6", "min-h-0");
  document.body.appendChild(div);
  return div;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reCAPTCHA container lifecycle", () => {
  afterEach(() => {
    // Clean up DOM
    const el = document.getElementById("recaptcha-container");
    if (el) el.remove();

    vi.clearAllMocks();
  });

  describe("getRecaptchaVerifier", () => {
    it("throws when container does not exist in DOM", () => {
      expect(() => getRecaptchaVerifier("nonexistent-container")).toThrow(
        "reCAPTCHA container 'nonexistent-container' not found in DOM"
      );
    });

    it("creates a RecaptchaVerifier on first call", () => {
      createContainer();

      const verifier = getRecaptchaVerifier("recaptcha-container");

      expect(MockRecaptchaVerifier).toHaveBeenCalledOnce();
      expect(verifier).toBe(mockRecaptchaVerifierInstance);
    });

    it("replaces the container DOM element with a fresh node", () => {
      const original = createContainer();
      const originalRef = original;

      getRecaptchaVerifier("recaptcha-container");

      const current = document.getElementById("recaptcha-container");
      // The element in the DOM should be a NEW element, not the same reference
      expect(current).not.toBe(originalRef);
      expect(current).toBeTruthy();
      expect(current!.id).toBe("recaptcha-container");
    });

    it("preserves CSS classes when replacing the container", () => {
      createContainer();

      getRecaptchaVerifier("recaptcha-container");

      const current = document.getElementById("recaptcha-container");
      expect(current!.classList.contains("mt-6")).toBe(true);
      expect(current!.classList.contains("min-h-0")).toBe(true);
    });

    it("clears previous verifier before creating a new one on second call", () => {
      createContainer();

      // First call
      getRecaptchaVerifier("recaptcha-container");
      expect(MockRecaptchaVerifier).toHaveBeenCalledTimes(1);
      const clearCountAfterFirst = mockRecaptchaVerifierInstance.clear.mock.calls.length;

      // Second call — should clear the previous verifier at least once more
      getRecaptchaVerifier("recaptcha-container");
      expect(mockRecaptchaVerifierInstance.clear.mock.calls.length).toBeGreaterThan(clearCountAfterFirst);
      expect(MockRecaptchaVerifier).toHaveBeenCalledTimes(2);
    });

    it("replaces the container element on every call (prevents double-render)", () => {
      createContainer();

      // First call — swaps the container
      getRecaptchaVerifier("recaptcha-container");
      const afterFirst = document.getElementById("recaptcha-container");

      // Second call — should swap again, producing a different element reference
      getRecaptchaVerifier("recaptcha-container");
      const afterSecond = document.getElementById("recaptcha-container");

      expect(afterFirst).not.toBe(afterSecond);
    });

    it("handles .clear() throwing without crashing", () => {
      createContainer();

      // First call to set up state
      getRecaptchaVerifier("recaptcha-container");

      // Make .clear() throw on second call
      mockRecaptchaVerifierInstance.clear.mockImplementationOnce(() => {
        throw new Error("clear failed");
      });

      // Should not throw
      expect(() => getRecaptchaVerifier("recaptcha-container")).not.toThrow();
      expect(MockRecaptchaVerifier).toHaveBeenCalledTimes(2);
    });
  });

  describe("prepareRecaptchaVerifier", () => {
    it("creates verifier and calls render()", async () => {
      createContainer();

      const verifier = await prepareRecaptchaVerifier("recaptcha-container");

      expect(verifier).toBe(mockRecaptchaVerifierInstance);
      expect(mockRecaptchaVerifierInstance.render).toHaveBeenCalledOnce();
    });
  });

  describe("resetRecaptcha", () => {
    it("replaces the recaptcha-container DOM element", () => {
      createContainer();

      // Set up verifier state first
      getRecaptchaVerifier("recaptcha-container");
      const afterVerifier = document.getElementById("recaptcha-container");

      // Reset should produce yet another fresh element
      resetRecaptcha();
      const afterReset = document.getElementById("recaptcha-container");

      expect(afterReset).not.toBe(afterVerifier);
      expect(afterReset!.id).toBe("recaptcha-container");
    });

    it("preserves CSS classes during reset", () => {
      createContainer();
      getRecaptchaVerifier("recaptcha-container");

      resetRecaptcha();

      const current = document.getElementById("recaptcha-container");
      expect(current!.classList.contains("mt-6")).toBe(true);
      expect(current!.classList.contains("min-h-0")).toBe(true);
    });

    it("does not throw when no container exists in DOM", () => {
      // No container in DOM, no prior verifier state
      expect(() => resetRecaptcha()).not.toThrow();
    });

    it("calls grecaptcha.reset() with widget ID when available", async () => {
      createContainer();
      const mockReset = vi.fn();
      (window as any).grecaptcha = { reset: mockReset };

      // Prepare sets the widget ID
      await prepareRecaptchaVerifier("recaptcha-container");

      resetRecaptcha();

      expect(mockReset).toHaveBeenCalledWith(42); // widget ID from render()
      delete (window as any).grecaptcha;
    });
  });
});
