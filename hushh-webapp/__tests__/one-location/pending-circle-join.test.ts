import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingCircleJoin,
  normalizeCircleCode,
  readPendingCircleJoin,
  rememberPendingCircleJoin,
} from "@/lib/one-location/pending-circle-join";

afterEach(() => {
  window.localStorage.clear();
});

describe("pending circle join", () => {
  it("survives the gap between accepting a code and the vault existing", () => {
    expect(rememberPendingCircleJoin("user_a", "ABCD-EFGH-JKLM")).toBe(true);

    // The whole point: a first-run joiner accepts during onboarding and the
    // vault that can redeem it does not exist until the wizard finishes.
    expect(readPendingCircleJoin("user_a")).toBe("ABCDEFGHJKLM");
  });

  it("stores a pasted code and a hand-typed one identically", () => {
    rememberPendingCircleJoin("user_a", " abcd-efgh-jklm ");
    expect(readPendingCircleJoin("user_a")).toBe("ABCDEFGHJKLM");
    expect(normalizeCircleCode("aB cd_ef.gh-jklm")).toBe("ABCDEFGHJKLM");
  });

  it("never lets one account inherit another's pending join", () => {
    rememberPendingCircleJoin("user_a", "ABCDEFGHJKLM");

    // Two accounts on one device is ordinary, and joining a circle you were
    // never invited to would be a real leak rather than a cosmetic bug.
    expect(readPendingCircleJoin("user_b")).toBeNull();
  });

  it("clears only the account it was asked to clear", () => {
    rememberPendingCircleJoin("user_a", "ABCDEFGHJKLM");
    rememberPendingCircleJoin("user_b", "MNPQRSTUVWXY");

    clearPendingCircleJoin("user_a");

    expect(readPendingCircleJoin("user_a")).toBeNull();
    expect(readPendingCircleJoin("user_b")).toBe("MNPQRSTUVWXY");
  });

  it("refuses an empty code rather than parking a redeem that cannot work", () => {
    expect(rememberPendingCircleJoin("user_a", "   ")).toBe(false);
    expect(rememberPendingCircleJoin("", "ABCDEFGHJKLM")).toBe(false);
    expect(readPendingCircleJoin("user_a")).toBeNull();
  });

  it("reports failure instead of throwing when storage is unavailable", () => {
    // jsdom's localStorage is a proxy, so the write has to be intercepted on
    // Storage.prototype -- assigning to the instance is silently ignored and
    // the test would pass against the real implementation.
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      // Private mode must degrade to "not remembered" so the caller can tell
      // the person to join from Circles, rather than crashing onboarding.
      expect(rememberPendingCircleJoin("user_a", "ABCDEFGHJKLM")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("reads and clears without throwing when storage is unavailable", () => {
    const getSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const removeSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    try {
      expect(readPendingCircleJoin("user_a")).toBeNull();
      expect(() => clearPendingCircleJoin("user_a")).not.toThrow();
    } finally {
      getSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});
