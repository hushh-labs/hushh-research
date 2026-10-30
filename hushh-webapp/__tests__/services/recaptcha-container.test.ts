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
    const MockCtor = vi.fn(function MockRecaptchaVerifier(..._args: unknown[]) {
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
    resetRecaptcha();
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

    it("preserves the React-owned host and gives the SDK a private child", () => {
      const original = createContainer();
      const originalRef = original;

      getRecaptchaVerifier("recaptcha-container");

      const current = document.getElementById("recaptcha-container");
      expect(current).toBe(originalRef);
      const sdkTarget = MockRecaptchaVerifier.mock.calls[0][1];
      expect(sdkTarget).toBeInstanceOf(HTMLElement);
      expect(sdkTarget).not.toBe(originalRef);
      expect(current!.firstElementChild).toBe(sdkTarget);
    });

    it("preserves host CSS classes when preparing the SDK target", () => {
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

    it("uses a fresh SDK target on every call without replacing the React host", () => {
      const host = createContainer();

      getRecaptchaVerifier("recaptcha-container");
      const firstTarget = MockRecaptchaVerifier.mock.calls[0][1];

      getRecaptchaVerifier("recaptcha-container");
      const secondTarget = MockRecaptchaVerifier.mock.calls[1][1];

      expect(firstTarget).not.toBe(secondTarget);
      expect(document.getElementById("recaptcha-container")).toBe(host);
      expect(host.firstElementChild).toBe(secondTarget);
      expect((firstTarget as HTMLElement).isConnected).toBe(false);
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
    it("releases the SDK target while keeping the React-owned host", () => {
      const host = createContainer();

      // Set up verifier state first
      getRecaptchaVerifier("recaptcha-container");
      const sdkTarget = host.firstElementChild;

      resetRecaptcha();
      const afterReset = document.getElementById("recaptcha-container");

      expect(afterReset).toBe(host);
      expect(host.childElementCount).toBe(0);
      expect(sdkTarget?.isConnected).toBe(false);
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
