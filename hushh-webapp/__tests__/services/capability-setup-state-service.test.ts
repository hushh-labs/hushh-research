import { describe, expect, it } from "vitest";

import {
  isCapabilitySetupActionable,
  isCapabilitySetupComplete,
  resolveAllCapabilitySetupStates,
  resolveCapabilitySetupState,
  shouldSkipCapabilityStep,
  type CapabilitySetupInputs,
} from "@/lib/services/capability-setup-state-service";
import type { KaiProfileV2 } from "@/lib/services/kai-profile-service";
import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";
import { ONE_CAPABILITIES } from "@/lib/onboarding/one-capabilities";

function makePreVaultState(overrides: Partial<PreVaultUserState> = {}): PreVaultUserState {
  return {
    userId: "uid-1",
    hasVault: true,
    vaultStatus: "active",
    firstLoginAt: 1,
    lastLoginAt: 2,
    loginCount: 3,
    setupCompleted: null,
    setupSkipped: null,
    setupCompletedAt: null,
    navSetupCompletedAt: null,
    navSetupSkippedAt: null,
    setupStateUpdatedAt: null,
    phoneVerified: null,
    setupCapabilityIds: [],
    setupCapabilitiesUpdatedAt: null,
    ...overrides,
  };
}

function makeKaiProfile(
  setup: Partial<KaiProfileV2["setup"]> = {}
): KaiProfileV2 {
  return {
    schema_version: 3,
    setup: {
      completed: false,
      completed_at: null,
      skipped_preferences: false,
      nav_completed_at: null,
      nav_skipped_at: null,
      version: 3,
      ...setup,
    },
    preferences: {
      investment_horizon: null,
      investment_horizon_selected_at: null,
      investment_horizon_anchor_at: null,
      drawdown_response: null,
      drawdown_response_selected_at: null,
      volatility_preference: null,
      volatility_preference_selected_at: null,
      risk_score: null,
      risk_profile: null,
      risk_profile_selected_at: null,
    },
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function baseInputs(overrides: Partial<CapabilitySetupInputs> = {}): CapabilitySetupInputs {
  return {
    isAuthenticated: true,
    isVaultUnlocked: false,
    preVaultState: null,
    kaiProfile: null,
    pendingConsents: 0,
    oauthConnections: {},
    ...overrides,
  };
}

describe("resolveCapabilitySetupState — authentication gate", () => {
  it("blocks every capability on auth when unauthenticated", () => {
    const inputs = baseInputs({ isAuthenticated: false });
    for (const cap of ONE_CAPABILITIES) {
      const status = resolveCapabilitySetupState(cap.id, inputs);
      expect(status.state).toBe("blocked");
      expect(status.prerequisite).toBe("auth");
    }
  });
});

describe("resolveCapabilitySetupState — finance", () => {
  it("is unknown (vault prerequisite) when locked and mirror unresolved", () => {
    const status = resolveCapabilitySetupState("finance", baseInputs());
    expect(status.state).toBe("unknown");
    expect(status.prerequisite).toBe("vault");
    expect(status.requiresUnlock).toBe(true);
  });

  it("never fabricates a default when the coarse mirror has not resolved", () => {
    const status = resolveCapabilitySetupState(
      "finance",
      baseInputs({ isVaultUnlocked: true, preVaultState: null, kaiProfile: null })
    );
    expect(status.state).toBe("unknown");
  });

  it("reads completed from the decrypted Kai profile", () => {
    const status = resolveCapabilitySetupState(
      "finance",
      baseInputs({
        isVaultUnlocked: true,
        kaiProfile: makeKaiProfile({ completed: true }),
      })
    );
    expect(status.state).toBe("completed");
  });

  it("reads skipped (distinct from completed) from the Kai profile", () => {
    const status = resolveCapabilitySetupState(
      "finance",
      baseInputs({
        isVaultUnlocked: true,
        kaiProfile: makeKaiProfile({ skipped_preferences: true }),
      })
    );
    expect(status.state).toBe("skipped");
  });

  it("falls back to the coarse pre-vault mirror before unlock", () => {
    const completed = resolveCapabilitySetupState(
      "finance",
      baseInputs({ preVaultState: makePreVaultState({ setupCompleted: true }) })
    );
    expect(completed.state).toBe("completed");

    const skipped = resolveCapabilitySetupState(
      "finance",
      baseInputs({ preVaultState: makePreVaultState({ setupSkipped: true }) })
    );
    expect(skipped.state).toBe("skipped");
  });

  it("marks not-started (requiresUnlock) when mirror resolved as neither", () => {
    const status = resolveCapabilitySetupState(
      "finance",
      baseInputs({
        preVaultState: makePreVaultState({
          setupCompleted: false,
          setupSkipped: false,
        }),
      })
    );
    expect(status.state).toBe("not-started");
    expect(status.requiresUnlock).toBe(true);
  });
});

describe("resolveCapabilitySetupState — consent (explore-only)", () => {
  it("is not-started when there are no pending requests and it has not been explored", () => {
    const status = resolveCapabilitySetupState("consent", baseInputs({ pendingConsents: 0 }));
    expect(status.state).toBe("not-started");
    expect(status.pendingCount).toBe(0);
  });

  it("is completed once explored with no pending requests", () => {
    const status = resolveCapabilitySetupState(
      "consent",
      baseInputs({ pendingConsents: 0, exploredCapabilityIds: new Set(["consent"]) })
    );
    expect(status.state).toBe("completed");
    expect(status.pendingCount).toBe(0);
  });

  it("needs attention with an accurate pending count regardless of explored state", () => {
    const status = resolveCapabilitySetupState(
      "consent",
      baseInputs({ pendingConsents: 3, exploredCapabilityIds: new Set(["consent"]) })
    );
    expect(status.state).toBe("needs-attention");
    expect(status.pendingCount).toBe(3);
  });

  it("clamps negative/fractional pending counts and stays explore-gated", () => {
    const status = resolveCapabilitySetupState("consent", baseInputs({ pendingConsents: -5 }));
    expect(status.state).toBe("not-started");
    expect(status.pendingCount).toBe(0);
  });
});

describe("resolveCapabilitySetupState — vault-gated (pkm)", () => {
  it("is unknown with vault prerequisite while locked", () => {
    const status = resolveCapabilitySetupState("pkm", baseInputs({ isVaultUnlocked: false }));
    expect(status.state).toBe("unknown");
    expect(status.prerequisite).toBe("vault");
    expect(status.requiresUnlock).toBe(true);
  });

  it("stays unknown (not fabricated) after unlock until a real signal is wired", () => {
    const status = resolveCapabilitySetupState("pkm", baseInputs({ isVaultUnlocked: true }));
    expect(status.state).toBe("unknown");
    expect(status.requiresUnlock).toBe(true);
  });
});

describe("resolveCapabilitySetupState — oauth-gated (gmail, connected-systems)", () => {
  it("blocks on oauth when no connection signal is supplied", () => {
    const status = resolveCapabilitySetupState("gmail", baseInputs());
    expect(status.state).toBe("blocked");
    expect(status.prerequisite).toBe("oauth");
  });

  it("is completed when connected", () => {
    const status = resolveCapabilitySetupState(
      "gmail",
      baseInputs({ oauthConnections: { gmail: true } })
    );
    expect(status.state).toBe("completed");
  });

  it("is not-started when explicitly disconnected", () => {
    const status = resolveCapabilitySetupState(
      "connected-systems",
      baseInputs({ oauthConnections: { "connected-systems": false } })
    );
    expect(status.state).toBe("not-started");
  });
});

describe("resolveCapabilitySetupState — vault-gated (email, location)", () => {
  it("is unknown with vault prerequisite while locked", () => {
    for (const id of ["email", "location"]) {
      const status = resolveCapabilitySetupState(id, baseInputs({ isVaultUnlocked: false }));
      expect(status.state).toBe("unknown");
      expect(status.prerequisite).toBe("vault");
      expect(status.requiresUnlock).toBe(true);
    }
  });

  it("stays unknown (not fabricated) after unlock until a real signal is wired", () => {
    for (const id of ["email", "location"]) {
      const status = resolveCapabilitySetupState(id, baseInputs({ isVaultUnlocked: true }));
      expect(status.state).toBe("unknown");
      expect(status.requiresUnlock).toBe(true);
    }
  });
});

describe("resolveAllCapabilitySetupStates", () => {
  it("returns one status per catalog capability, preserving order", () => {
    const statuses = resolveAllCapabilitySetupStates(baseInputs());
    expect(statuses.map((s) => s.id)).toEqual(ONE_CAPABILITIES.map((c) => c.id));
  });
});

describe("skip-vs-continue semantics", () => {
  it("skips only completed and skipped steps", () => {
    expect(shouldSkipCapabilityStep({ id: "x", state: "completed", pendingCount: 0, prerequisite: null, requiresUnlock: false })).toBe(true);
    expect(shouldSkipCapabilityStep({ id: "x", state: "skipped", pendingCount: 0, prerequisite: null, requiresUnlock: false })).toBe(true);
  });

  it("never silently skips unknown or blocked steps", () => {
    expect(shouldSkipCapabilityStep({ id: "x", state: "unknown", pendingCount: 0, prerequisite: "vault", requiresUnlock: true })).toBe(false);
    expect(shouldSkipCapabilityStep({ id: "x", state: "blocked", pendingCount: 0, prerequisite: "auth", requiresUnlock: false })).toBe(false);
  });

  it("treats not-started / in-progress / needs-attention as actionable", () => {
    expect(isCapabilitySetupActionable({ id: "x", state: "not-started", pendingCount: 0, prerequisite: null, requiresUnlock: false })).toBe(true);
    expect(isCapabilitySetupActionable({ id: "x", state: "in-progress", pendingCount: 0, prerequisite: null, requiresUnlock: false })).toBe(true);
    expect(isCapabilitySetupActionable({ id: "x", state: "needs-attention", pendingCount: 2, prerequisite: null, requiresUnlock: false })).toBe(true);
    expect(isCapabilitySetupActionable({ id: "x", state: "completed", pendingCount: 0, prerequisite: null, requiresUnlock: false })).toBe(false);
  });

  it("counts only completed/skipped as genuinely set up", () => {
    expect(isCapabilitySetupComplete({ id: "x", state: "completed", pendingCount: 0, prerequisite: null, requiresUnlock: false })).toBe(true);
    expect(isCapabilitySetupComplete({ id: "x", state: "skipped", pendingCount: 0, prerequisite: null, requiresUnlock: false })).toBe(true);
  });

  it("never counts blocked or unknown as set up (they still need the user)", () => {
    // The bug behind "5 of 7 ready" on a fresh account: blocked (needs an OAuth
    // connection) and unknown (needs a vault unlock) must NOT read as ready.
    expect(isCapabilitySetupComplete({ id: "x", state: "blocked", pendingCount: 0, prerequisite: "oauth", requiresUnlock: false })).toBe(false);
    expect(isCapabilitySetupComplete({ id: "x", state: "unknown", pendingCount: 0, prerequisite: "vault", requiresUnlock: true })).toBe(false);
    expect(isCapabilitySetupComplete({ id: "x", state: "not-started", pendingCount: 0, prerequisite: null, requiresUnlock: false })).toBe(false);
  });
});
