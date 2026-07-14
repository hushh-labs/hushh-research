import type { KaiProfileV2 } from "@/lib/services/kai-profile-service";
import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";
import { resolveKaiOnboardingCompletion } from "@/lib/services/kai-profile-service";
import {
  ONE_CAPABILITIES,
  ONE_SETUP_CAPABILITY_IDS,
  getOneCapability,
} from "@/lib/onboarding/one-capabilities";

/**
 * CAPABILITY SETUP-STATE RESOLVER — single source of truth for "is this
 * capability set up for this person, and what should One do next?".
 *
 * WHY THIS EXISTS
 * The `/one` dashboard previously hardcoded per-tile status (e.g. gmail =
 * "Setup needed", pkm = "Ready") with no live signal, and the only two real
 * signals (finance onboarding completion, consent pending count) measured the
 * wrong axis (a finished questionnaire is not the same as a configured
 * capability). A first-time-user "Set up One" flow cannot decide skip-vs-
 * continue from fabricated state, so all per-capability state must funnel
 * through ONE resolver with explicit, honest states.
 *
 * DESIGN BOUNDARIES (deliberate)
 * - This module is PURE: it takes already-fetched inputs and returns derived
 *   state. It does NOT fetch, decrypt, or touch the network. Callers (services
 *   or hooks) own data acquisition so this stays trivially testable and never
 *   leaks plaintext sensitive data into an unencrypted path.
 * - `unknown` and `blocked` are first-class. When the vault is locked or a
 *   prerequisite is unmet, we say so instead of guessing "Ready"/"Setup
 *   needed". A network blip on the coarse mirror must never silently re-trigger
 *   a setup flow.
 * - `skipped` is distinct from `completed`. The user choosing "Not now" is a
 *   real, persisted decision (PreVault `setupSkipped` /
 *   KaiProfile `skipped_preferences`) and must not read as incomplete.
 */

export type CapabilitySetupState =
  /** Cannot determine yet (e.g. vault locked, coarse mirror unresolved). */
  | "unknown"
  /** A prerequisite is unmet (e.g. vault not created, not authenticated). */
  | "blocked"
  /** Determinable and confirmed not started. */
  | "not-started"
  /** Started but not finished (partial signal present). */
  | "in-progress"
  /** Set up / configured. */
  | "completed"
  /** User explicitly chose to set this up later ("Not now"). */
  | "skipped"
  /** Set up, but something needs the user's attention (e.g. pending consents). */
  | "needs-attention";

/**
 * A prerequisite that gates a capability. The flow uses this to render an
 * accurate, non-jargon reason ("Unlock your vault to continue") rather than a
 * misleading "Setup needed".
 */
export type CapabilityPrerequisite = "vault" | "auth" | "oauth";

export interface CapabilityStatus {
  /** Capability id from the shared `ONE_CAPABILITIES` catalog. */
  id: string;
  state: CapabilitySetupState;
  /**
   * Count of items needing attention (only meaningful for `needs-attention`,
   * e.g. pending consent requests). 0 otherwise.
   */
  pendingCount: number;
  /**
   * Unmet prerequisite, present only for `blocked` / `unknown` states where a
   * gate explains why we cannot resolve or proceed.
   */
  prerequisite: CapabilityPrerequisite | null;
  /**
   * Whether resolving the *real* state of this capability requires the vault to
   * be unlocked. The flow uses this to defer enrichment until after unlock and
   * to render an honest "Unlock to view" affordance instead of a fabricated
   * status.
   */
  requiresUnlock: boolean;
}

/**
 * Inputs the resolver derives from. Every field is something a caller already
 * has (or can cheaply obtain) so the resolver itself never fetches.
 */
export interface CapabilitySetupInputs {
  /** Authenticated user present. When false, most capabilities are `blocked`. */
  isAuthenticated: boolean;
  /** Vault key currently held in memory (i.e. vault unlocked this session). */
  isVaultUnlocked: boolean;
  /**
   * Coarse, non-sensitive pre-vault mirror. Readable before unlock. `null` when
   * the bootstrap call has not resolved (yields `unknown`, never a default).
   */
  preVaultState: PreVaultUserState | null;
  /**
   * Decrypted Kai profile. Only available post-unlock; `null`/`undefined`
   * pre-unlock. Held in memory by the caller — never persisted unencrypted.
   */
  kaiProfile?: KaiProfileV2 | null;
  /** Live count of pending consent requests (0 when none / unknown). */
  pendingConsents: number;
  /**
   * OAuth-connection booleans the caller already knows, keyed by capability id
   * (e.g. `{ gmail: true }`). Absent keys mean "not connected / unknown" and
   * are treated per the capability's own prerequisite rules.
   */
  oauthConnections?: Partial<Record<string, boolean>>;
  /**
   * Ids of explore-only capabilities (those that collect nothing) the user has
   * explored at least once. An explore-only capability is `not-started`
   * ("Explore") until its id appears here, then `completed` ("Explored"). Absent
   * means "nothing explored yet".
   */
  exploredCapabilityIds?: ReadonlySet<string>;
  /**
   * Location readiness signal: whether the user has a location recipient key
   * (their live location is set up). Only knowable post-unlock (it lives behind
   * the vault). `true` → set up, `false` → not set up, `undefined` → not fetched
   * yet (or vault locked). Fed by a lightweight `getState` fetch when unlocked.
   */
  locationRecipientKeyReady?: boolean;
  /**
   * RIA readiness signal: whether the user has an onboarded RIA profile (a
   * `ria_profiles` row exists, which the backend creates only on onboarding
   * submit — never for a partial license check). `true` → onboarded, `false` →
   * no profile, `undefined` → not fetched yet. Fed by a lightweight
   * `getOnboardingStatus` fetch. Unlike location this does not require the vault,
   * so an onboarded RIA reads as complete even before unlock.
   */
  riaOnboarded?: boolean;
}

/** Capabilities that require an OAuth connection to a third party. */
const OAUTH_GATED = new Set<string>(["gmail"]);
const TERMINAL_SETUP_IDS = new Set<string>(ONE_SETUP_CAPABILITY_IDS);

function blocked(
  id: string,
  prerequisite: CapabilityPrerequisite,
): CapabilityStatus {
  return {
    id,
    state: "blocked",
    pendingCount: 0,
    prerequisite,
    requiresUnlock: false,
  };
}

function unknown(
  id: string,
  prerequisite: CapabilityPrerequisite | null,
  requiresUnlock: boolean,
): CapabilityStatus {
  return {
    id,
    state: "unknown",
    pendingCount: 0,
    prerequisite,
    requiresUnlock,
  };
}

function simple(id: string, state: CapabilitySetupState): CapabilityStatus {
  return {
    id,
    state,
    pendingCount: 0,
    prerequisite: null,
    requiresUnlock: false,
  };
}

/**
 * Resolve the finance capability. Real state lives in the encrypted Kai
 * profile, with a coarse pre-unlock signal in the pre-vault mirror so we can
 * render *something* honest before unlock.
 */
function resolveFinance(inputs: CapabilitySetupInputs): CapabilityStatus {
  const { kaiProfile, preVaultState, isVaultUnlocked } = inputs;

  // Capability completion is its own durable boundary. Root onboarding flags
  // and a completed preferences questionnaire do not prove that Finance setup
  // reached its terminal acknowledgement (portfolio source choice + Finish).
  if (preVaultState?.setupCapabilityIds.includes("finance")) {
    return simple("finance", "completed");
  }

  if (kaiProfile) {
    const { completed, skippedPreferences } =
      resolveKaiOnboardingCompletion(kaiProfile);
    if (completed || skippedPreferences)
      return simple("finance", "in-progress");
    return simple("finance", "not-started");
  }

  // No decrypted profile yet. The journey mirror may prove that Finance is in
  // progress, but account-wide setupCompleted/setupSkipped are deliberately
  // ignored: they describe the root journey, not this capability.
  if (preVaultState) {
    if (preVaultState.onboardingActiveCapability === "finance") {
      return simple("finance", "in-progress");
    }
    return {
      id: "finance",
      state: "not-started",
      pendingCount: 0,
      prerequisite: null,
      requiresUnlock: !isVaultUnlocked,
    };
  }

  // Mirror unresolved → we do not know. Never default to a status.
  return unknown("finance", isVaultUnlocked ? null : "vault", !isVaultUnlocked);
}

/**
 * Resolve the consent capability. Pending requests always win as
 * `needs-attention` (there is something to act on right now). With nothing
 * pending it is an explore-only review surface: `not-started` ("Explore") until
 * the person has looked once, then `completed` ("Explored"). This avoids a fresh
 * account fabricating a "Ready" badge for a tab the user has never opened.
 */
function resolveConsent(inputs: CapabilitySetupInputs): CapabilityStatus {
  const pending = Math.max(0, Math.trunc(inputs.pendingConsents || 0));
  if (pending > 0) {
    return {
      id: "consent",
      state: "needs-attention",
      pendingCount: pending,
      prerequisite: null,
      requiresUnlock: false,
    };
  }
  return resolveExploreOnly("consent", inputs);
}

/**
 * Resolve an explore-only capability (one that collects nothing from the user).
 * Its "setup" is a one-time look: `not-started` ("Explore") until the user has
 * explored it once, then `completed` ("Explored"). Keeping un-explored tabs
 * `not-started` makes the "N of M ready" count honest — an unseen tab is
 * genuinely "left to set up", never a fabricated "Ready".
 */
function resolveExploreOnly(
  id: string,
  inputs: CapabilitySetupInputs,
): CapabilityStatus {
  const explored = inputs.exploredCapabilityIds?.has(id) === true;
  return simple(id, explored ? "completed" : "not-started");
}

/**
 * Resolve a vault-gated capability (finance handled separately). Without an
 * unlocked vault we cannot read real state, so we report `unknown` with the
 * vault prerequisite rather than guessing.
 */
function resolveVaultGated(
  id: string,
  inputs: CapabilitySetupInputs,
): CapabilityStatus {
  if (inputs.preVaultState?.onboardingActiveCapability === id) {
    return {
      id,
      state: "in-progress",
      pendingCount: 0,
      prerequisite: null,
      requiresUnlock: !inputs.isVaultUnlocked,
    };
  }
  if (!inputs.isVaultUnlocked) {
    return unknown(id, "vault", true);
  }
  // Once the durable mirror is known, absence of the terminal acknowledgement
  // means setup is still available. Vault access alone never fabricates Ready.
  return inputs.preVaultState
    ? simple(id, "not-started")
    : unknown(id, null, true);
}

/**
 * Resolve the location (Onepoint) capability. "Set up" means the user has a
 * location recipient key, which lives behind the vault. Locked → we cannot read
 * it, so keep the honest vault-prerequisite `unknown` ("Unlock to view").
 * Unlocked → `completed` ("Ready") when the key exists, `not-started`
 * ("Set up location") when it doesn't, and `unknown`/"Checking…" while the
 * one-shot fetch is still in flight.
 */
function resolveLocation(inputs: CapabilitySetupInputs): CapabilityStatus {
  if (!inputs.isVaultUnlocked) {
    return unknown("location", "vault", true);
  }
  const ready = inputs.locationRecipientKeyReady;
  if (ready === true) return simple("location", "completed");
  if (ready === false) return simple("location", "not-started");
  return unknown("location", null, false);
}

/**
 * Resolve the RIA capability. "Set up" means the user has an onboarded RIA
 * profile (an existing `ria_profiles` row). When that live signal says onboarded
 * we mark it `completed` regardless of vault state — the profile exists whether
 * or not the vault is unlocked this session. Otherwise fall back to the generic
 * vault-gated behaviour (locked → "Unlock to view", active journey →
 * "in-progress", unlocked-but-none → "Set up RIA") so nothing is fabricated and
 * the durable "Finish RIA setup" terminal id still completes it.
 */
function resolveRia(inputs: CapabilitySetupInputs): CapabilityStatus {
  if (inputs.riaOnboarded === true) return simple("ria", "completed");
  return resolveVaultGated("ria", inputs);
}

/** Resolve an OAuth-gated capability from caller-supplied connection booleans. */
function resolveOauthGated(
  id: string,
  inputs: CapabilitySetupInputs,
): CapabilityStatus {
  const connected = inputs.oauthConnections?.[id];
  // A live connection proves useful work happened, but setup completes only
  // after the explicit capability terminal is acknowledged.
  if (connected === true) return simple(id, "in-progress");
  if (connected === false) return simple(id, "not-started");
  // No signal supplied → blocked on the OAuth connection (honest, actionable).
  return blocked(id, "oauth");
}

/** Resolve a single capability by id. */
export function resolveCapabilitySetupState(
  id: string,
  inputs: CapabilitySetupInputs,
): CapabilityStatus {
  if (!inputs.isAuthenticated) {
    return blocked(id, "auth");
  }

  if (
    TERMINAL_SETUP_IDS.has(id) &&
    inputs.preVaultState?.setupCapabilityIds.includes(id)
  ) {
    return simple(id, "completed");
  }

  if (id === "finance") return resolveFinance(inputs);
  if (id === "consent") return resolveConsent(inputs);
  if (id === "location") return resolveLocation(inputs);
  if (id === "ria") return resolveRia(inputs);
  if (OAUTH_GATED.has(id)) return resolveOauthGated(id, inputs);

  const capability = getOneCapability(id);

  // Explore-only capabilities (e.g. consent fallthrough): no data to collect, so
  // their "setup" is a one-time look. `not-started` ("Explore") until explored
  // once, then `completed` ("Explored"). Declared via the catalog
  // `isExploreOnly` flag so the set is explicit and testable.
  if (capability?.isExploreOnly === true) {
    return resolveExploreOnly(id, inputs);
  }

  // Vault-backed capabilities (finance handled separately above): their real
  // configuration lives behind the encrypted vault. Without an unlocked vault we
  // cannot read real state, so report `unknown` with the vault prerequisite
  // rather than fabricating "Ready". Declared via the catalog `requiresVault`
  // flag so the set is explicit and testable (finance, gmail, email, location,
  // pkm, connected-systems). Note gmail/connected-systems are handled by the
  // OAuth branch above, so this covers email, location, and pkm.
  if (capability?.requiresVault === true) {
    return resolveVaultGated(id, inputs);
  }

  // No backend setup gate and not declared explore-only or vault-backed: treat
  // as usable once authenticated. Kept explicit so adding a real gate later is a
  // deliberate change, not an accident.
  return simple(id, "completed");
}

/** Resolve every capability in the shared catalog, preserving catalog order. */
export function resolveAllCapabilitySetupStates(
  inputs: CapabilitySetupInputs,
): CapabilityStatus[] {
  return ONE_CAPABILITIES.map((cap) =>
    resolveCapabilitySetupState(cap.id, inputs),
  );
}

/** True when a capability still needs the user to do something to set it up. */
export function isCapabilitySetupActionable(status: CapabilityStatus): boolean {
  return (
    status.state === "not-started" ||
    status.state === "in-progress" ||
    status.state === "needs-attention"
  );
}

/**
 * True when a capability is GENUINELY set up — i.e. the person has nothing left
 * to do for it. This is the honest basis for any "N of M ready" summary.
 *
 * Deliberately NOT the inverse of {@link isCapabilitySetupActionable}: a tile
 * can be non-actionable yet still un-ready (`blocked` needs an OAuth connection,
 * `unknown` needs an unlock to even resolve). Those must read as "left to set
 * up", never as "ready", or the headline count contradicts the per-tile badge
 * ("Connect to set up" / "Unlock to view").
 */
export function isCapabilitySetupComplete(status: CapabilityStatus): boolean {
  return status.state === "completed" || status.state === "skipped";
}

/**
 * Decide whether a guided onboarding step for this capability should be SKIPPED
 * (auto-advance) or shown to the user (CONTINUE). `unknown`/`blocked` are NOT
 * skippable — they must be surfaced honestly, never silently bypassed.
 */
export function shouldSkipCapabilityStep(status: CapabilityStatus): boolean {
  return status.state === "completed" || status.state === "skipped";
}
