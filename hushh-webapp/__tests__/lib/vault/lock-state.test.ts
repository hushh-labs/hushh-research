import { describe, expect, it } from "vitest";

import {
  isLockReady,
  isLockRequiredError,
  lockActionLabel,
  lockBlockedSummary,
  LockRequiredError,
  needsLockPrompt,
  resolveLockState,
  resolveVaultAvailabilityState,
  type LockState,
  type LockStateInputs,
} from "@/lib/vault/vault-access-policy";

/**
 * The five states must stay distinct.
 *
 * Every reported symptom of the lock regression is two of these collapsed into
 * one: a person with no lock told to "Unlock One", a person who is merely
 * locked offered first-run setup, a screen painting a verdict before anything
 * was read, and a failed request read as an account with no lock. Each `it`
 * below pins one of those apart.
 */

const settled: LockStateInputs = {
  hasVault: null,
  isVaultUnlocked: false,
  authLoading: false,
};

function state(overrides: Partial<LockStateInputs>): LockState {
  return resolveLockState({ ...settled, ...overrides });
}

describe("resolveLockState — unknown is never a verdict", () => {
  it("waits while auth is still restoring, even with a known lock", () => {
    expect(state({ authLoading: true, hasVault: true })).toBe("loading");
  });

  it("waits while auth is still restoring, even with no lock on record", () => {
    // The dangerous direction: `false` here would render "Set a lock" at
    // somebody who is signed in and holds one.
    expect(state({ authLoading: true, hasVault: false })).toBe("loading");
  });

  it("waits while lock ownership has not been read", () => {
    expect(state({ hasVault: null })).toBe("loading");
  });

  it("treats an absent value the same as an explicit unknown", () => {
    expect(state({ hasVault: undefined })).toBe("loading");
  });

  it("never reports unconfigured before the answer is in", () => {
    const unresolved: LockState[] = [
      state({ hasVault: null }),
      state({ hasVault: null, authLoading: true }),
      state({ hasVault: undefined }),
    ];
    expect(unresolved.every((value) => value === "loading")).toBe(true);
  });
});

describe("resolveLockState — a failed read is not an absent lock", () => {
  it("reports error, not unconfigured, when the presence check failed", () => {
    expect(state({ presenceFailed: true, hasVault: null })).toBe("error");
  });

  it("still reports error when a stale negative is sitting in hasVault", () => {
    expect(state({ presenceFailed: true, hasVault: false })).toBe("error");
  });

  it("lets a live key override a failed presence read", () => {
    // The key in memory is proof. A background check that fell over cannot
    // relock somebody who is demonstrably unlocked.
    expect(
      state({
        presenceFailed: true,
        isVaultUnlocked: true,
        vaultOwnerToken: "token",
      }),
    ).toBe("unlocked");
  });
});

describe("resolveLockState — configured, locked and unlocked stay apart", () => {
  it("reports unconfigured only for a settled, successful, negative read", () => {
    expect(state({ hasVault: false })).toBe("unconfigured");
  });

  it("reports locked for an account that owns a lock with no key in memory", () => {
    expect(state({ hasVault: true })).toBe("locked");
  });

  it("does not call a locked account unconfigured", () => {
    // The headline regression, stated as an assertion.
    expect(state({ hasVault: true })).not.toBe("unconfigured");
  });

  it("reports unlocked from the owner token alone", () => {
    expect(state({ hasVault: true, vaultOwnerToken: "token" })).toBe("unlocked");
  });

  it("reports unlocked from the context's own boolean alone", () => {
    // A caller holding only `useVault().isVaultUnlocked` is as entitled to the
    // answer as one holding the token.
    expect(state({ hasVault: true, isVaultUnlocked: true })).toBe("unlocked");
  });

  it("ignores a whitespace-only token", () => {
    expect(state({ hasVault: true, vaultOwnerToken: "   " })).toBe("locked");
  });

  it("returns exactly one state for every input combination", () => {
    const valid: LockState[] = [
      "loading",
      "unconfigured",
      "locked",
      "unlocked",
      "error",
    ];
    for (const hasVault of [true, false, null] as const) {
      for (const isVaultUnlocked of [true, false]) {
        for (const authLoading of [true, false]) {
          for (const presenceFailed of [true, false]) {
            const resolved = resolveLockState({
              hasVault,
              isVaultUnlocked,
              authLoading,
              presenceFailed,
            });
            expect(valid).toContain(resolved);
          }
        }
      }
    }
  });
});

describe("the words each state is owed", () => {
  it("offers setup only to somebody with no lock", () => {
    expect(lockActionLabel("unconfigured")).toBe("Set a lock");
  });

  it("offers unlock to somebody whose lock is merely shut", () => {
    expect(lockActionLabel("locked")).toBe("Unlock One");
  });

  it("never offers setup to a locked account", () => {
    expect(lockActionLabel("locked")).not.toBe(lockActionLabel("unconfigured"));
  });

  it("keeps every visible label inside the four-word budget", () => {
    for (const value of ["unconfigured", "locked"] as const) {
      expect(lockActionLabel(value).split(/\s+/).length).toBeLessThanOrEqual(4);
    }
  });

  it("asks somebody to wait rather than blaming them, while loading", () => {
    expect(lockBlockedSummary("loading")).toBe("Still checking");
  });

  it("names the fault on error instead of claiming there is no lock", () => {
    expect(lockBlockedSummary("error")).toBe("Couldn't check your lock");
    expect(lockBlockedSummary("error")).not.toBe(
      lockBlockedSummary("unconfigured"),
    );
  });

  it("says nothing when the action may simply run", () => {
    expect(lockBlockedSummary("unlocked")).toBe("");
  });
});

describe("who may be prompted", () => {
  it("prompts a locked and an unconfigured person", () => {
    expect(needsLockPrompt("locked")).toBe(true);
    expect(needsLockPrompt("unconfigured")).toBe(true);
  });

  it("never prompts while the answer is still unknown", () => {
    // Prompting here accuses somebody of being locked during a frame of our
    // own bookkeeping.
    expect(needsLockPrompt("loading")).toBe(false);
  });

  it("never hides a failed read behind a credential sheet", () => {
    expect(needsLockPrompt("error")).toBe(false);
  });

  it("lets only an unlocked state proceed", () => {
    expect(isLockReady("unlocked")).toBe(true);
    for (const value of [
      "loading",
      "unconfigured",
      "locked",
      "error",
    ] as const) {
      expect(isLockReady(value)).toBe(false);
    }
  });
});

describe("resolveVaultAvailabilityState — the booleans agree with the state", () => {
  it("does not claim creation is needed while the read is unresolved", () => {
    const availability = resolveVaultAvailabilityState({
      hasVault: null,
      isVaultUnlocked: false,
    });
    expect(availability.state).toBe("loading");
    expect(availability.needsVaultCreation).toBe(false);
    expect(availability.vaultUnknown).toBe(true);
  });

  it("does not claim creation is needed when the read failed", () => {
    const availability = resolveVaultAvailabilityState({
      hasVault: false,
      isVaultUnlocked: false,
      presenceFailed: true,
    });
    expect(availability.state).toBe("error");
    expect(availability.needsVaultCreation).toBe(false);
    expect(availability.vaultCheckFailed).toBe(true);
  });

  it("claims creation only for a settled negative", () => {
    const availability = resolveVaultAvailabilityState({
      hasVault: false,
      isVaultUnlocked: false,
    });
    expect(availability.state).toBe("unconfigured");
    expect(availability.needsVaultCreation).toBe(true);
    expect(availability.needsUnlock).toBe(false);
  });

  it("claims unlock for a lock that exists and is shut", () => {
    const availability = resolveVaultAvailabilityState({
      hasVault: true,
      isVaultUnlocked: false,
    });
    expect(availability.state).toBe("locked");
    expect(availability.needsUnlock).toBe(true);
    expect(availability.needsVaultCreation).toBe(false);
  });

  it("keeps the capability booleans intact for the decrypt question", () => {
    const availability = resolveVaultAvailabilityState({
      hasVault: true,
      isVaultUnlocked: true,
      vaultKey: "key",
      vaultOwnerToken: "token",
    });
    expect(availability.state).toBe("unlocked");
    expect(availability.canMutateSecureData).toBe(true);
    expect(availability.canReadSecureData).toBe(true);
  });

  it("exposes exactly one true state flag at a time", () => {
    const combos: LockStateInputs[] = [
      { hasVault: null, isVaultUnlocked: false },
      { hasVault: false, isVaultUnlocked: false },
      { hasVault: true, isVaultUnlocked: false },
      { hasVault: true, isVaultUnlocked: true, vaultOwnerToken: "t" },
      { hasVault: false, isVaultUnlocked: false, presenceFailed: true },
    ];
    for (const combo of combos) {
      const availability = resolveVaultAvailabilityState(combo);
      const flags = [
        availability.vaultUnknown,
        availability.needsVaultCreation,
        availability.needsUnlock,
        availability.vaultCheckFailed,
        availability.state === "unlocked",
      ].filter(Boolean);
      expect(flags).toHaveLength(1);
    }
  });
});

describe("LockRequiredError", () => {
  it("carries the state so a caller opens the right sheet", () => {
    expect(new LockRequiredError("unconfigured").lockState).toBe("unconfigured");
    expect(new LockRequiredError("locked").lockState).toBe("locked");
  });

  it("speaks the state's own words by default", () => {
    // One Voice reads this verbatim, so it must not say "unlock" to somebody
    // who has nothing to unlock.
    expect(new LockRequiredError("unconfigured").message).toBe(
      "Set a lock first",
    );
    expect(new LockRequiredError("locked").message).toBe("Unlock One first");
  });

  it("is recognisable across a module boundary", () => {
    const plain = { lockRequired: true };
    expect(isLockRequiredError(new LockRequiredError())).toBe(true);
    expect(isLockRequiredError(plain)).toBe(true);
    expect(isLockRequiredError(new Error("server said no"))).toBe(false);
    expect(isLockRequiredError(null)).toBe(false);
  });
});
