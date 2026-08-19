/**
 * The one authority that decides where a signed-in person belongs.
 *
 * Before this module the decision was spread across three guards
 * (OnboardingJourneyGuard, PhoneMandateGuard, VaultLockGuard), each resolving
 * its own async inputs and each redirecting on its own schedule. Three
 * independent deciders produce three failure modes users actually reported:
 *
 *  - a guard renders its screen from a default value, discovers the real state
 *    one tick later, and re-renders somewhere else (the lock-screen flash),
 *  - two guards decide at the same moment and both paint, because the vault
 *    surface is a portal and does not need to share a subtree to be visible,
 *  - an onboarding route stays reachable because no guard claimed it.
 *
 * The rule here is: nothing renders an onboarding surface until every input is
 * known. Unknown is a first-class value (`null`), not a falsy default, and any
 * unknown input resolves to `booting`. Exactly one step wins.
 *
 * Pure by design: no React, no network, no storage, no clock. Everything it
 * needs arrives as arguments, so every transition is directly testable.
 */

import {
  normalizeStaticExportPathname,
  ROUTES,
} from "@/lib/navigation/routes";

/**
 * The mutually exclusive states of the first-run journey. At most one is ever
 * active. `booting` means "not enough is known yet" and is the only state that
 * may render before the inputs settle.
 */
export type UserEntryStep =
  | "booting"
  | "auth"
  | "phone_auth"
  | "vault_setup"
  | "one_setup"
  | "main_app";

/** Which credential surface, if any, a step permits to be on screen. */
export type EntrySurface = "none" | "auth" | "phone" | "vault" | "setup";

export type UserEntryInputs = {
  /**
   * False until the host is known. The phone step is waived on localhost, so
   * deciding before the hostname settles treats a local session as remote for
   * one render — which is exactly one frame of the wrong screen.
   */
  environmentResolved: boolean;
  /** False while Firebase is still restoring a session from disk. */
  authResolved: boolean;
  /** The signed-in account, or null when definitively signed out. */
  userId: string | null;
  /** Verified phone claim. `null` means not yet known. */
  phoneVerified: boolean | null;
  /** Whether the account already owns a lock. `null` means not yet known. */
  hasVault: boolean | null;
  /** In-memory lock key present for this session. Never persisted. */
  vaultUnlocked: boolean;
  /** Root setup finished or skipped at least once. `null` means not yet known. */
  setupCompleted: boolean | null;
  /**
   * The phone step does not apply at all — local development on localhost, the
   * native route-audit bridge, and the RIA onboarding route each waive it. When
   * true the phone claim is not consulted and never blocks.
   */
  phoneMandateWaived: boolean;
};

export type UserEntryState = {
  step: UserEntryStep;
  /** True once every input the step depends on is known. */
  resolved: boolean;
  /** True when an account is definitively signed in. Unknown while booting. */
  signedIn: boolean;
  /** The single route this person belongs on right now. */
  destination: string;
  /** The only credential surface allowed to mount in this step. */
  surface: EntrySurface;
};

/**
 * Resolve the one step that wins.
 *
 * Order matters and mirrors the funnel: a person cannot verify a phone before
 * signing in, cannot set a lock before verifying a phone, and cannot finish
 * setup before setting a lock. Each gate consults only the inputs that its own
 * predecessors have already settled, so an unknown value further down the
 * funnel never holds up a decision that is already determined.
 */
export function resolveUserEntryState(
  inputs: UserEntryInputs,
): UserEntryState {
  if (!inputs.environmentResolved || !inputs.authResolved) {
    return booting();
  }

  if (!inputs.userId) {
    return {
      step: "auth",
      resolved: true,
      signedIn: false,
      destination: ROUTES.LOGIN,
      surface: "auth",
    };
  }

  if (!inputs.phoneMandateWaived) {
    if (inputs.phoneVerified === null) {
      return booting();
    }
    if (inputs.phoneVerified === false) {
      return {
        step: "phone_auth",
        resolved: true,
        signedIn: true,
        destination: ROUTES.PHONE_MANDATE,
        surface: "phone",
      };
    }
  }

  // Setup completion is checked before lock ownership on purpose. A person who
  // already finished the funnel belongs in the app; whether their lock is open
  // in THIS session is a session question, not an onboarding one, and is
  // answered by the lock gate on the routes that need a key.
  if (inputs.setupCompleted === null) {
    return booting();
  }
  if (inputs.setupCompleted === true) {
    return {
      step: "main_app",
      resolved: true,
      signedIn: true,
      destination: ROUTES.ONE_HOME,
      surface: "none",
    };
  }

  if (inputs.hasVault === null) {
    return booting();
  }

  // The lock step is the terminal step of the setup hub rather than a route of
  // its own, so both unfinished states share `/one/setup`. They stay distinct
  // steps because they permit different surfaces: only `vault_setup` may show
  // the lock.
  if (inputs.hasVault === false || !inputs.vaultUnlocked) {
    return {
      step: "vault_setup",
      resolved: true,
      signedIn: true,
      destination: ROUTES.ONE_SETUP,
      surface: "setup",
    };
  }

  return {
    step: "one_setup",
    resolved: true,
    signedIn: true,
    destination: ROUTES.ONE_SETUP,
    surface: "setup",
  };
}

function booting(): UserEntryState {
  return {
    step: "booting",
    resolved: false,
    signedIn: false,
    destination: ROUTES.ONE_HOME,
    surface: "none",
  };
}

/** True once the funnel is behind this person for good. */
export function isOnboardingComplete(state: UserEntryState): boolean {
  return state.step === "main_app";
}

/**
 * Every route that belongs to the first-run funnel and to nothing else.
 *
 * A completed person must never see one of these, by any arrival path: back
 * button, back gesture, deep link, typed URL, or a stale history entry left by
 * a document navigation the app does not control (the sign-in provider's own
 * redirect, for one).
 */
const ONBOARDING_ROUTES: readonly string[] = [
  ROUTES.GETTING_STARTED,
  ROUTES.LOGIN,
  ROUTES.PHONE_MANDATE,
  ROUTES.ONE_SETUP,
];

export function isOnboardingRoute(pathname: string): boolean {
  const normalized = normalizeStaticExportPathname(pathname);
  return ONBOARDING_ROUTES.includes(normalized);
}

/**
 * Routes that carry no onboarding meaning and must never be redirected by this
 * resolver: public reading surfaces, shared location links, sign-out, and
 * Profile.
 *
 * Profile is deliberately here. It is the only way out of a broken session —
 * sign out, delete the account, recover a lock — so a failed bootstrap must
 * never be able to trap somebody away from it.
 */
export function isEntryExemptRoute(pathname: string): boolean {
  const normalized = normalizeStaticExportPathname(pathname);
  return (
    normalized === ROUTES.HOME ||
    normalized === ROUTES.WELCOME ||
    normalized === ROUTES.DEVELOPERS ||
    normalized === ROUTES.RESEARCH ||
    normalized.startsWith(`${ROUTES.RESEARCH}/`) ||
    normalized === ROUTES.BLOG ||
    normalized.startsWith(`${ROUTES.BLOG}/`) ||
    normalized === ROUTES.LOGOUT ||
    normalized === ROUTES.RIA_CLAIM ||
    normalized === ROUTES.PROFILE ||
    normalized.startsWith(`${ROUTES.PROFILE}/`) ||
    normalized.startsWith(`${ROUTES.ONE_LOCATION}/request/`)
  );
}

/**
 * Whether a credential surface may mount right now.
 *
 * The lock surface is a portal painted at z-712 over an opaque backdrop, so it
 * does not need to share a subtree with the phone screen to cover it — guard
 * nesting alone cannot keep the two apart. This predicate is what keeps them
 * mutually exclusive: a surface asks whether its step is the winning one, and
 * a surface whose step did not win does not render at all.
 */
export function isSurfaceAllowed(
  state: UserEntryState,
  surface: Exclude<EntrySurface, "none">,
): boolean {
  if (!state.resolved) return false;
  if (surface === "vault") {
    // The lock is reachable from the setup hub's terminal step and from any
    // in-app route that needs a key once the funnel is behind the person.
    return state.step === "vault_setup" || state.step === "main_app";
  }
  return state.surface === surface;
}
