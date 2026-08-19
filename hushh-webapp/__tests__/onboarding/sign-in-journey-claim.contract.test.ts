import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hasExplicitIncompleteSetup } from "@/lib/onboarding/setup-admission";
import { isOneSetupSurfaceRoute, ROUTES } from "@/lib/navigation/routes";
import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";

/**
 * Signing in settles the CALLBACK. It is not evidence about whether root setup
 * is finished, and it must never be written as though it were.
 *
 * The regression this file exists to prevent
 * ------------------------------------------
 * `AuthStep` used to record `phase: "setup_hub"` for every post-sign-in
 * destination that was not phone verification — including `/one`, the app
 * itself. `hasExplicitIncompleteSetup` reads `onboardingJourneyVersion === 1`
 * together with any phase other than `root_completion` as the record stating,
 * in so many words, that the funnel is unfinished.
 *
 * For an established account whose `setup_completed` column is NULL — 029
 * renamed the setup columns and backfilled no value, and `_ensure_user_entry_sync`
 * never sets one — signing in therefore MANUFACTURED the evidence that the
 * person had not finished. Durably, and on every device. The entry resolver
 * then sent them to `/one/setup`, whose terminal step is the lock, so an
 * already-onboarded person was asked to set up a lock they already owned, and
 * had to re-finish the whole funnel to clear it.
 *
 * Two halves are pinned below: the rule that makes the write dangerous, and the
 * call site that must stop making the claim.
 */

const EMPTY: PreVaultUserState = {
  userId: "user-1",
  hasVault: null,
  vaultStatus: "placeholder",
  firstLoginAt: null,
  lastLoginAt: null,
  loginCount: 0,
  setupCompleted: null,
  setupSkipped: null,
  setupCompletedAt: null,
  navSetupCompletedAt: null,
  navSetupSkippedAt: null,
  setupCapabilityIds: [],
  setupCapabilitiesUpdatedAt: null,
  setupStateUpdatedAt: null,
  oneRuntimeSetupChoice: null,
  onboardingJourneyVersion: null,
  onboardingPhase: null,
  onboardingActiveCapability: null,
  onboardingResumeRoute: null,
  onboardingCallbackState: null,
  onboardingCallbackAttemptId: null,
  onboardingJourneyUpdatedAt: null,
  phoneVerified: null,
};

describe("a legacy account is not evidence of an unfinished funnel", () => {
  it("treats an account that predates the journey mirror as established", () => {
    expect(hasExplicitIncompleteSetup(EMPTY)).toBe(false);
  });

  it("still treats an explicit backend false as unfinished", () => {
    expect(
      hasExplicitIncompleteSetup({ ...EMPTY, setupCompleted: false }),
    ).toBe(true);
  });

  it("treats a completed account as finished whatever the phase says", () => {
    expect(
      hasExplicitIncompleteSetup({
        ...EMPTY,
        setupCompleted: true,
        onboardingJourneyVersion: 1,
        onboardingPhase: "setup_hub",
      }),
    ).toBe(false);
  });

  it("DOES read a version-1 setup_hub phase as unfinished — which is exactly why sign-in must not write one", () => {
    // This is the rule, unchanged. It is correct when the hub wrote the phase.
    // It is catastrophic when authentication wrote it, which is what the
    // contract below prevents.
    expect(
      hasExplicitIncompleteSetup({
        ...EMPTY,
        onboardingJourneyVersion: 1,
        onboardingPhase: "setup_hub",
      }),
    ).toBe(true);
  });
});

describe("AuthStep does not claim a funnel phase it has no evidence for", () => {
  const source = readFileSync(
    join(process.cwd(), "components/onboarding/AuthStep.tsx"),
    "utf8",
  );

  it("no longer writes setup_hub for every non-phone destination", () => {
    // The exact expression that shipped the regression.
    expect(source).not.toContain(
      'nextPath === ROUTES.PHONE_MANDATE ? "phone_required" : "setup_hub"',
    );
  });

  it("decides the phase from where the person is actually being sent", () => {
    expect(source).toContain(
      "const entersPhoneStep = nextPathname === ROUTES.PHONE_MANDATE;",
    );
    expect(source).toContain(
      "const entersSetupFunnel = isOneSetupSurfaceRoute(nextPathname);",
    );
  });

  it("settles only the callback when the destination is not in the funnel", () => {
    expect(source).toContain("onboardingCallbackState: \"succeeded\"");
    expect(source).toContain("PreVaultUserStateService.updatePreVaultState(");
  });

  it("still records the phone step when that is where sign-in leads", () => {
    expect(source).toContain('phase: "phone_required"');
  });

  it("still records the setup hub when sign-in genuinely lands there", () => {
    expect(source).toContain('phase: "setup_hub"');
  });

  it("classifies on the path, not the whole href", () => {
    // `PostAuthRouteService` hands back `/one/setup?return_to=…` for somebody
    // who genuinely needs the funnel with a redirect to resume, and
    // `normalizeStaticExportPathname` strips a trailing slash and an index
    // document but NOT a query string. Testing the whole href would classify a
    // real funnel entry as "not the funnel" and quietly stop recording it.
    expect(source).toContain("const nextPathname = nextPath.split(/[?#]/)[0]");
    expect(source).toContain("isOneSetupSurfaceRoute(nextPathname)");
    expect(source).not.toContain("isOneSetupSurfaceRoute(nextPath)");
  });
});

describe("the route predicate this contract depends on", () => {
  it("does not strip a query string, which is why the split above is needed", () => {
    // Pinned as a fact, not an assumption. If `isOneSetupSurfaceRoute` ever
    // starts handling query strings itself, this fails and the split can go.
    expect(isOneSetupSurfaceRoute(ROUTES.ONE_SETUP)).toBe(true);
    expect(isOneSetupSurfaceRoute(`${ROUTES.ONE_SETUP}?return_to=%2Fone`)).toBe(
      false,
    );
  });

  it("accepts the setup path once the query is removed", () => {
    const href = `${ROUTES.ONE_SETUP}?return_to=%2Fone%2Flocation`;
    expect(isOneSetupSurfaceRoute(href.split(/[?#]/)[0] ?? href)).toBe(true);
  });
});
