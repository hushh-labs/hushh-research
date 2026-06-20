import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLocalStorage,
  getLocalItem,
  removeLocalItem,
  setLocalItem,
} from "@/lib/utils/session-storage";

describe("defensive local storage handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    clearLocalStorage();
  });

  it("preserves standard localStorage behavior when persistent storage is available", () => {
    setLocalItem("hushh:test:tracking-state", "enabled");

    expect(window.localStorage.getItem("hushh:test:tracking-state")).toBe("enabled");
    expect(getLocalItem("hushh:test:tracking-state")).toBe("enabled");

    removeLocalItem("hushh:test:tracking-state");

    expect(getLocalItem("hushh:test:tracking-state")).toBeNull();
  });

  it("falls back to memory when localStorage writes exceed quota", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(() => setLocalItem("hushh:test:tracking-state", "revoked")).not.toThrow();
    expect(getLocalItem("hushh:test:tracking-state")).toBe("revoked");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to memory when strict browser modes block storage access", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });

    try {
      expect(() => setLocalItem("hushh:test:tracking-state", "disabled")).not.toThrow();
      expect(getLocalItem("hushh:test:tracking-state")).toBe("disabled");
      removeLocalItem("hushh:test:tracking-state");
      expect(getLocalItem("hushh:test:tracking-state")).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "localStorage", descriptor);
      }
    }
  });

  it("clears memory fallback state when persistent clear is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "clear").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });

    setLocalItem("hushh:test:tracking-state", "pending");
    expect(getLocalItem("hushh:test:tracking-state")).toBe("pending");

    expect(() => clearLocalStorage()).not.toThrow();

    expect(getLocalItem("hushh:test:tracking-state")).toBeNull();
  });

  it("refuses to persist vault credential keys in persistent or fallback storage", () => {
    const sensitiveEntries = [
      ["vault_key", "vault-key-secret"],
      ["vaultOwnerToken", "vault-owner-token-secret"],
      ["vault_owner_token", "vault-owner-token-secret"],
    ];

    for (const [key, value] of sensitiveEntries) {
      expect(() => setLocalItem(key, value)).not.toThrow();
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(getLocalItem(key)).toBeNull();
    }
  });

  it("does not retain vault credential keys in memory fallback when persistent storage is blocked", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(() => setLocalItem("vault_key", "vault-key-secret")).not.toThrow();

    expect(getLocalItem("vault_key")).toBeNull();
    expect(window.localStorage.getItem("vault_key")).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
