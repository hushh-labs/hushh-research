import { describe, expect, it } from "vitest";

import {
  isEntryExemptRoute,
  isOnboardingComplete,
  isOnboardingRoute,
  isSurfaceAllowed,
  resolveUserEntryState,
  type UserEntryInputs,
} from "@/lib/onboarding/user-entry-state";

/**
 * Every input known, funnel finished. Individual cases override one field at a
 * time so a failure names the single fact that changed the outcome.
 */
function completedUser(overrides: Partial<UserEntryInputs> = {}): UserEntryInputs {
  return {
    environmentResolved: true,
    authResolved: true,
    userId: "user-1",
    phoneVerified: true,
    hasVault: true,
    vaultUnlocked: true,
    setupCompleted: true,
    phoneMandateWaived: false,
    ...overrides,
  };
}

describe("resolveUserEntryState — unknown inputs never render a guess", () => {
  it("boots while the session is still being restored", () => {
    const state = resolveUserEntryState(
      completedUser({ authResolved: false, userId: null }),
    );
    expect(state.step).toBe("booting");
    expect(state.resolved).toBe(false);
  });

  it("boots until the host is known, so localhost is never treated as remote", () => {
    const state = resolveUserEntryState(
      completedUser({ environmentResolved: false }),
    );
    expect(state.step).toBe("booting");
  });

  it("boots while the phone claim is unknown, instead of assuming unverified", () => {
    const state = resolveUserEntryState(completedUser({ phoneVerified: null }));
    expect(state.step).toBe("booting");
  });

  it("boots while setup completion is unknown, instead of assuming incomplete", () => {
    const state = resolveUserEntryState(completedUser({ setupCompleted: null }));
    expect(state.step).toBe("booting");
  });

  it("boots while lock ownership is unknown for an unfinished user", () => {
    const state = resolveUserEntryState(
      completedUser({ setupCompleted: false, hasVault: null }),
    );
    expect(state.step).toBe("booting");
  });

  it("does not wait on lock ownership once setup is finished", () => {
    // A finished person belongs in the app. Whether their lock is open in this
    // session is answered later, by the routes that need a key.
    const state = resolveUserEntryState(
      completedUser({ hasVault: null, vaultUnlocked: false }),
    );
    expect(state.step).toBe("main_app");
    expect(state.resolved).toBe(true);
  });

  it("no unresolved state ever names a credential surface", () => {
    const unresolvedShapes: Partial<UserEntryInputs>[] = [
      { environmentResolved: false },
      { authResolved: false },
      { phoneVerified: null },
      { setupCompleted: null },
      { setupCompleted: false, hasVault: null },
    ];
    for (const shape of unresolvedShapes) {
      const state = resolveUserEntryState(completedUser(shape));
      expect(state.resolved).toBe(false);
      expect(state.surface).toBe("none");
    }
  });
});

describe("resolveUserEntryState — the funnel, in order", () => {
  it("sends a signed-out visitor to sign-in", () => {
    const state = resolveUserEntryState(
      completedUser({ userId: null, phoneVerified: null, setupCompleted: null }),
    );
    expect(state.step).toBe("auth");
    expect(state.destination).toBe("/login");
  });

  it("sends a signed-in person with no verified phone to phone verification", () => {
    const state = resolveUserEntryState(
      completedUser({ phoneVerified: false, setupCompleted: null, hasVault: null }),
    );
    expect(state.step).toBe("phone_auth");
    expect(state.destination).toBe("/register-phone");
  });

  it("sends a verified person with no lock to setup, in the lock step", () => {
    const state = resolveUserEntryState(
      completedUser({ setupCompleted: false, hasVault: false, vaultUnlocked: false }),
    );
    expect(state.step).toBe("vault_setup");
    expect(state.destination).toBe("/one/setup");
  });

  it("keeps a person with a lock they have not opened in the lock step", () => {
    const state = resolveUserEntryState(
      completedUser({ setupCompleted: false, hasVault: true, vaultUnlocked: false }),
    );
    expect(state.step).toBe("vault_setup");
  });

  it("moves to the setup hub once the lock is open and setup is unfinished", () => {
    const state = resolveUserEntryState(completedUser({ setupCompleted: false }));
    expect(state.step).toBe("one_setup");
    expect(state.destination).toBe("/one/setup");
  });

  it("sends a finished person to the app", () => {
    const state = resolveUserEntryState(completedUser());
    expect(state.step).toBe("main_app");
    expect(state.destination).toBe("/one");
    expect(isOnboardingComplete(state)).toBe(true);
  });
});

describe("resolveUserEntryState — the phone step can be waived", () => {
  it("skips the phone step entirely when it does not apply", () => {
    const state = resolveUserEntryState(
      completedUser({ phoneVerified: false, phoneMandateWaived: true }),
    );
    expect(state.step).toBe("main_app");
  });

  it("does not stall on an unknown phone claim when the step is waived", () => {
    const state = resolveUserEntryState(
      completedUser({ phoneVerified: null, phoneMandateWaived: true }),
    );
    expect(state.step).toBe("main_app");
    expect(state.resolved).toBe(true);
  });
});

describe("exactly one step wins", () => {
  const allInputCombinations: UserEntryInputs[] = [];
  for (const authResolved of [true, false]) {
    for (const userId of ["user-1", null]) {
      for (const phoneVerified of [true, false, null]) {
        for (const hasVault of [true, false, null]) {
          for (const vaultUnlocked of [true, false]) {
            for (const setupCompleted of [true, false, null]) {
              for (const phoneMandateWaived of [true, false]) {
                allInputCombinations.push({
                  environmentResolved: true,
                  authResolved,
                  userId,
                  phoneVerified,
                  hasVault,
                  vaultUnlocked,
                  setupCompleted,
                  phoneMandateWaived,
                });
              }
            }
          }
        }
      }
    }
  }

  it("returns exactly one step for every reachable combination of inputs", () => {
    expect(allInputCombinations.length).toBe(432);
    for (const inputs of allInputCombinations) {
      const state = resolveUserEntryState(inputs);
      expect(state.step).toBeTypeOf("string");
      expect(state.destination.startsWith("/")).toBe(true);
    }
  });

  it("never allows the lock surface and the phone surface at the same time", () => {
    for (const inputs of allInputCombinations) {
      const state = resolveUserEntryState(inputs);
      const both =
        isSurfaceAllowed(state, "vault") && isSurfaceAllowed(state, "phone");
      expect(both).toBe(false);
    }
  });

  it("allows no credential surface at all while booting", () => {
    for (const inputs of allInputCombinations) {
      const state = resolveUserEntryState(inputs);
      if (state.resolved) continue;
      for (const surface of ["auth", "phone", "vault", "setup"] as const) {
        expect(isSurfaceAllowed(state, surface)).toBe(false);
      }
    }
  });

  it("permits the lock only in the lock step and inside the app", () => {
    for (const inputs of allInputCombinations) {
      const state = resolveUserEntryState(inputs);
      expect(isSurfaceAllowed(state, "vault")).toBe(
        state.step === "vault_setup" || state.step === "main_app",
      );
    }
  });

  it("never permits the phone surface once the funnel is behind the person", () => {
    for (const inputs of allInputCombinations) {
      const state = resolveUserEntryState(inputs);
      if (state.step !== "main_app") continue;
      expect(isSurfaceAllowed(state, "phone")).toBe(false);
    }
  });
});

describe("onboarding routes are a closed set", () => {
  it("names every screen of the funnel", () => {
    for (const route of [
      "/getting-started",
      "/login",
      "/register-phone",
      "/one/setup",
    ]) {
      expect(isOnboardingRoute(route)).toBe(true);
    }
  });

  it("matches the static-export shape the native shell serves", () => {
    expect(isOnboardingRoute("/register-phone/")).toBe(true);
    expect(isOnboardingRoute("/one/setup/index.html")).toBe(true);
  });

  it("leaves ordinary product routes alone", () => {
    for (const route of [
      "/one",
      "/one/location",
      "/one/profile",
      "/one/profile/security",
      "/welcome",
      "/",
    ]) {
      expect(isOnboardingRoute(route)).toBe(false);
    }
  });

  it("keeps the ways out of a broken session exempt", () => {
    // Profile is the only route that can sign out, delete the account, or
    // recover a lock. A failed bootstrap must never trap anyone away from it.
    expect(isEntryExemptRoute("/one/profile")).toBe(true);
    expect(isEntryExemptRoute("/one/profile/security")).toBe(true);
    expect(isEntryExemptRoute("/logout")).toBe(true);
  });

  it("keeps shared location links exempt so a stranger can open one", () => {
    expect(isEntryExemptRoute("/one/location/request/abc123")).toBe(true);
  });

  it("does not exempt the funnel's own routes", () => {
    for (const route of ["/login", "/register-phone", "/one/setup"]) {
      expect(isEntryExemptRoute(route)).toBe(false);
    }
  });
});
