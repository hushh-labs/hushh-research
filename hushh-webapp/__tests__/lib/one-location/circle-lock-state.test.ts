import { describe, expect, it } from "vitest";

import {
  isOneLocationLockRequiredError,
  OneLocationLockRequiredError,
  resolveOneLocationLockState,
} from "@/lib/one-location/circle-lock-state";

describe("resolveOneLocationLockState", () => {
  it("is ready whenever an owner token is in memory", () => {
    expect(
      resolveOneLocationLockState({
        authLoading: false,
        userId: "user-1",
        vaultOwnerToken: "HCT:token",
      }),
    ).toBe("ready");
  });

  it("stays ready even mid-settle — a token in hand outranks a pending identity", () => {
    // The token can only exist for the matched identity in the first place
    // (vault-context nulls it across a transition), so holding one is proof
    // enough. Downgrading to "resolving" here would stall a working screen.
    expect(
      resolveOneLocationLockState({
        authLoading: true,
        userId: null,
        vaultOwnerToken: "HCT:token",
      }),
    ).toBe("ready");
  });

  it("treats an unsettled identity as unknown, never as locked", () => {
    // This is the whole point of the type. `vaultOwnerToken` reads null while
    // auth is settling for reasons that have nothing to do with the lock, and
    // calling that "locked" is what produced a dead-end message for people who
    // were perfectly well unlocked.
    expect(
      resolveOneLocationLockState({
        authLoading: true,
        userId: null,
        vaultOwnerToken: null,
      }),
    ).toBe("resolving");

    expect(
      resolveOneLocationLockState({
        authLoading: false,
        userId: null,
        vaultOwnerToken: null,
      }),
    ).toBe("resolving");

    expect(
      resolveOneLocationLockState({
        authLoading: true,
        userId: "user-1",
        vaultOwnerToken: null,
      }),
    ).toBe("resolving");
  });

  it("is locked only once identity has settled and there is still no token", () => {
    expect(
      resolveOneLocationLockState({
        authLoading: false,
        userId: "user-1",
        vaultOwnerToken: null,
      }),
    ).toBe("locked");
  });

  it("treats an empty-string token as no token", () => {
    expect(
      resolveOneLocationLockState({
        authLoading: false,
        userId: "user-1",
        vaultOwnerToken: "",
      }),
    ).toBe("locked");
  });
});

describe("OneLocationLockRequiredError", () => {
  it("is recognisable without matching on the sentence", () => {
    // The UI must be able to tell "you need to unlock" from "the server said
    // no" by type. Matching on message text is how a copy edit silently turns a
    // lock prompt into an error toast.
    const error = new OneLocationLockRequiredError();
    expect(isOneLocationLockRequiredError(error)).toBe(true);
    expect(isOneLocationLockRequiredError(new Error(error.message))).toBe(false);
    expect(isOneLocationLockRequiredError(null)).toBe(false);
  });

  it("carries copy short enough to read aloud", () => {
    // One Voice speaks this verbatim, so it stays a plain instruction rather
    // than a description of our internals.
    const message = new OneLocationLockRequiredError().message;
    expect(message).toBe("Unlock One first");
    expect(message.split(/\s+/)).toHaveLength(3);
    expect(message.toLowerCase()).not.toContain("vault");
    expect(message.toLowerCase()).not.toContain("token");
  });
});
