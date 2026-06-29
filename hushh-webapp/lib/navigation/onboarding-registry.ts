/**
 * One Onboarding Registry — the single declarative source of truth for the
 * app's onboarding hierarchy.
 *
 * ARCHITECTURE: "One first, then downstream."
 *
 *   One onboarding  = the ROOT onboarding. Runs exactly ONCE per account and is
 *                     the gate into the app. It only re-appears after an account
 *                     delete/reset (see `resetScope: "account"`). This is the
 *                     orchestrator layer — the same way One is the orchestrating
 *                     agent above every sub-agent.
 *
 *   Sub-onboardings = downstream, agent/surface-specific flows that live UNDER
 *                     One (Kai investor profile, RIA advisor verification, KYC).
 *                     Each can be entered, skipped, resumed, and re-run on its
 *                     own surface independently of the One gate. Completing or
 *                     skipping a sub-onboarding never re-locks the One gate, and
 *                     the One gate being satisfied never force-completes a
 *                     sub-onboarding.
 *
 * This registry is intentionally declarative: routing guards, reset flows, and
 * docs all read from ONE place so the hierarchy can never silently drift. Do not
 * hand-roll per-flow onboarding gating outside this contract — add/extend an
 * `OnboardingDefinition` instead. See
 * `docs/reference/quality/one-onboarding-architecture.md`.
 */

import {
  ROUTES,
  isOneSetupSurfaceRoute,
  isOneSetupWizardRoute,
  isRiaOnboardingRoute,
} from "@/lib/navigation/routes";

/** Stable identifiers for every onboarding flow in the app. */
export type OnboardingId = "one" | "kai" | "ria" | "kyc";

/**
 * Where a flow sits in the hierarchy.
 * - `root`: the One gate (once per account).
 * - `sub`: a downstream agent/surface onboarding under One.
 */
export type OnboardingTier = "root" | "sub";

/**
 * What a "reset" of this flow is scoped to.
 * - `account`: only re-appears after account delete/reset (the One root gate).
 * - `surface`: can be reset/re-run independently from its own surface at any
 *   time without touching the account-level One gate.
 */
export type OnboardingResetScope = "account" | "surface";

/**
 * How completion/skip state is persisted. Mirrors the audited store map; kept
 * here so docs + guards agree on the source of truth per flow.
 */
export type OnboardingStateStore =
  /** Server pre-vault state (authoritative for no-vault / locked-vault users). */
  | "server-pre-vault"
  /** Encrypted vault profile (authoritative once the vault is unlocked). */
  | "vault-profile"
  /** Capacitor Preferences + localStorage fallback (offline/native bridge). */
  | "local-preferences"
  /** Server-side RIA onboarding status record. */
  | "server-ria-status"
  /** Per-tab sessionStorage fast-path hint (cache only, never authoritative). */
  | "session-hint";

export type OnboardingDefinition = {
  id: OnboardingId;
  /** Human label used in docs/telemetry, plain-language for consumers. */
  label: string;
  tier: OnboardingTier;
  /** Parent flow id; `null` only for the One root. */
  parent: OnboardingId | null;
  /** Canonical entry route for this flow. */
  route: string;
  /** True when a pathname belongs to this flow (sub-routes included). */
  matchesRoute: (pathname: string) => boolean;
  /** Authoritative + fallback stores, in trust order (first = source of truth). */
  stores: OnboardingStateStore[];
  resetScope: OnboardingResetScope;
  /**
   * Resume semantics: when re-entering a half-finished flow, restore to the
   * last saved step from the listed draft store(s). Empty = no resumable draft.
   */
  resumable: boolean;
  /**
   * Skip semantics: a skipped flow is treated as "satisfied for now" so the
   * user is not bounced back, but it can be re-run later from its surface.
   */
  skippable: boolean;
};

/**
 * The One root gate. Completing OR skipping it satisfies the account-level gate
 * once; it only returns after account delete/reset. The canonical surface is the
 * `/one/setup` capability hub; the Kai investor-profile wizard opens from the
 * hub's finance tile at `/one/setup/kai`. `matchesRoute` spans both so the gate
 * treats the hub and the wizard as one setup surface.
 */
const ONE: OnboardingDefinition = {
  id: "one",
  label: "One setup",
  tier: "root",
  parent: null,
  route: ROUTES.ONE_SETUP,
  matchesRoute: isOneSetupSurfaceRoute,
  stores: ["server-pre-vault", "vault-profile", "local-preferences", "session-hint"],
  resetScope: "account",
  resumable: true,
  skippable: true,
};

/**
 * Kai investor-profile sub-onboarding. Its steps render as the wizard at
 * `/one/setup/kai`, opened from the One setup hub's finance tile. Modeled as a
 * distinct sub so downstream Kai surfaces can reason about (and re-run) just the
 * investor-profile portion without implying a second account gate.
 */
const KAI: OnboardingDefinition = {
  id: "kai",
  label: "Kai investor profile",
  tier: "sub",
  parent: "one",
  route: ROUTES.ONE_SETUP_KAI,
  matchesRoute: isOneSetupWizardRoute,
  stores: ["server-pre-vault", "vault-profile", "local-preferences"],
  resetScope: "surface",
  resumable: true,
  skippable: true,
};

/** RIA advisor verification sub-onboarding. Fully independent surface flow. */
const RIA: OnboardingDefinition = {
  id: "ria",
  label: "Advisor verification",
  tier: "sub",
  parent: "one",
  route: ROUTES.RIA_ONBOARDING,
  matchesRoute: isRiaOnboardingRoute,
  stores: ["server-ria-status", "local-preferences"],
  resetScope: "surface",
  resumable: true,
  skippable: false,
};

/** KYC sub-onboarding. Independent surface flow under One. */
const KYC: OnboardingDefinition = {
  id: "kyc",
  label: "Identity verification",
  tier: "sub",
  parent: "one",
  route: ROUTES.ONE_KYC,
  matchesRoute: (pathname: string) =>
    pathname === ROUTES.ONE_KYC || pathname.startsWith(`${ROUTES.ONE_KYC}/`),
  stores: ["server-pre-vault"],
  resetScope: "surface",
  resumable: false,
  skippable: false,
};

export const ONBOARDING_REGISTRY: Readonly<Record<OnboardingId, OnboardingDefinition>> = {
  one: ONE,
  kai: KAI,
  ria: RIA,
  kyc: KYC,
} as const;

/** The single account-level root gate. */
export const ROOT_ONBOARDING: OnboardingDefinition = ONE;

/** All downstream sub-onboardings, in declaration order. */
export const SUB_ONBOARDINGS: readonly OnboardingDefinition[] = [KAI, RIA, KYC];

export function getOnboardingDefinition(id: OnboardingId): OnboardingDefinition {
  return ONBOARDING_REGISTRY[id];
}

/**
 * Resolve which onboarding flow a pathname belongs to, root preferred. Returns
 * `null` for non-onboarding routes. Used by guards/chrome to reason about the
 * active flow without scattering route checks.
 */
export function resolveOnboardingForPath(
  pathname: string,
): OnboardingDefinition | null {
  if (ROOT_ONBOARDING.matchesRoute(pathname)) return ROOT_ONBOARDING;
  for (const sub of SUB_ONBOARDINGS) {
    if (sub.route !== ROOT_ONBOARDING.route && sub.matchesRoute(pathname)) {
      return sub;
    }
  }
  return null;
}

/** True only for the account-level One root gate route. */
export function isRootOnboardingRoute(pathname: string): boolean {
  return ROOT_ONBOARDING.matchesRoute(pathname);
}
