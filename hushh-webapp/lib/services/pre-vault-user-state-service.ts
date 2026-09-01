"use client";

import { Capacitor } from "@capacitor/core";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { apiJson } from "@/lib/services/api-client";
import { AuthService } from "@/lib/services/auth-service";
import {
  CacheService,
  CACHE_KEYS,
  CACHE_TTL,
} from "@/lib/services/cache-service";
import {
  normalizeOneSetupCapabilityId,
  ONE_CLOUD_SETUP_PREREQUISITE_ID,
  ONE_RUNTIME_SETUP_PREREQUISITE_ID,
} from "@/lib/onboarding/setup-capability-ids";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

export type VaultStatus = "placeholder" | "active";

/**
 * A resumable setup preference only. It deliberately never contains a Gemini
 * key, a credential reference, vault material, or an access token.
 */
export type OneRuntimeSetupChoice =
  | "hushh_managed_vertex"
  | "byok_pending_vault";

export type PreVaultUserState = {
  userId: string;
  /**
   * Whether this account owns a lock. `null` means the record carried no
   * answer — not that the answer is no.
   *
   * It has to be nullable because this record is not always read from the
   * backend. `primeSetupResolved` builds one locally when the cache is cold,
   * and that payload says nothing about locks. While this was a plain
   * `boolean`, `normalizeResponse` turned "said nothing" into a confident
   * `false`, `readBootstrapVaultCheck` served that as the answer, and
   * `VaultService.checkVault` pinned it into a 30-minute session hint —
   * so finishing setup could persist "this person has no lock" moments after
   * they made one. Every downstream reader already handles `null` by asking
   * again; the type was the only thing stopping it.
   */
  hasVault: boolean | null;
  vaultStatus: VaultStatus;
  firstLoginAt: number | null;
  lastLoginAt: number | null;
  loginCount: number;
  setupCompleted: boolean | null;
  setupSkipped: boolean | null;
  setupCompletedAt: number | null;
  navSetupCompletedAt: number | null;
  navSetupSkippedAt: number | null;
  // Per-capability setup mirror: ids the user has set up at least once. The
  // client local store (CapabilityTourService) is the source of truth; this is
  // the durable, cross-device echo. Always an array (never null) so callers can
  // treat absent as "nothing set up".
  setupCapabilityIds: string[];
  setupCapabilitiesUpdatedAt: number | null;
  setupStateUpdatedAt: number | null;
  oneRuntimeSetupChoice: OneRuntimeSetupChoice | null;
  onboardingJourneyVersion: number | null;
  onboardingPhase:
    | "anonymous_auth"
    | "phone_required"
    | "setup_hub"
    | "capability_setup"
    | "external_connector"
    | "root_completion"
    | null;
  onboardingActiveCapability: string | null;
  onboardingResumeRoute: "/one/setup" | null;
  onboardingCallbackState:
    "none" | "pending" | "succeeded" | "cancelled" | "failed" | null;
  /** Opaque external-connector attempt correlation; never an OAuth artifact. */
  onboardingCallbackAttemptId: string | null;
  onboardingJourneyUpdatedAt: number | null;
  // Verified-phone claim folded in from the backend bootstrap call. null means
  // "unknown" (older backend, or shadow lookup failed) so callers fall back to
  // their own identity read rather than treating it as unverified.
  phoneVerified: boolean | null;
};

type BootstrapStateResponse = Partial<PreVaultUserState>;

type PreVaultStateUpdatePayload = {
  setupCompleted?: boolean;
  setupSkipped?: boolean;
  setupCompletedAt?: number | null;
  navSetupCompletedAt?: number | null;
  navSetupSkippedAt?: number | null;
  setupCapabilityIds?: string[];
  oneRuntimeSetupChoice?: OneRuntimeSetupChoice | null;
  onboardingJourneyVersion?: 1;
  onboardingPhase?: PreVaultUserState["onboardingPhase"];
  onboardingActiveCapability?: string | null;
  onboardingResumeRoute?: "/one/setup";
  onboardingCallbackState?: PreVaultUserState["onboardingCallbackState"];
  onboardingCallbackAttemptId?: string;
  expectedOnboardingJourneyUpdatedAt?: number | null;
  expectedOnboardingCallbackAttemptId?: string;
};

const bootstrapInflight = new Map<string, Promise<PreVaultUserState>>();

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOnboardingJourneyVersion(value: unknown): 1 | null {
  return Number(value) === 1 ? 1 : null;
}

function normalizeOneRuntimeSetupChoice(
  value: unknown,
): OneRuntimeSetupChoice | null {
  return value === "hushh_managed_vertex" || value === "byok_pending_vault"
    ? value
    : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return Array.from(seen).sort();
}

function toNullableBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "1") return true;
    if (lowered === "false" || lowered === "0") return false;
  }
  return null;
}

/**
 * Whether the payload actually reported lock ownership, and what it said.
 *
 * Three cases, and only the third is new:
 *
 *  - the payload states `hasVault` — believe it. The backend consulted the
 *    wrapper rows to answer (`check_vault_exists`), so it is better informed
 *    than the status string, and an explicit `false` beside an "active" status
 *    means a header row with no usable unlock method. ORing the two, as this
 *    used to, threw that answer away.
 *  - the payload states only a status — derive from it, as before.
 *  - the payload states neither — the record is a locally built one that knows
 *    nothing about locks. Return `null` so the readers ask, instead of
 *    inventing a "no".
 */
function resolveReportedHasVault(
  payload: BootstrapStateResponse,
): boolean | null {
  const reported = toNullableBool(payload.hasVault);
  if (reported !== null) return reported;
  const status =
    typeof payload.vaultStatus === "string" ? payload.vaultStatus.trim() : "";
  if (!status) return null;
  return status === "active";
}

function normalizeResponse(
  userId: string,
  payload: BootstrapStateResponse,
): PreVaultUserState {
  const status = (payload.vaultStatus || "placeholder") as VaultStatus;
  return {
    userId: String(payload.userId || userId),
    hasVault: resolveReportedHasVault(payload),
    vaultStatus: status,
    firstLoginAt: toMillis(payload.firstLoginAt),
    lastLoginAt: toMillis(payload.lastLoginAt),
    loginCount: Number(payload.loginCount || 0),
    setupCompleted: toNullableBool(payload.setupCompleted),
    setupSkipped: toNullableBool(payload.setupSkipped),
    setupCompletedAt: toMillis(payload.setupCompletedAt),
    navSetupCompletedAt: toMillis(payload.navSetupCompletedAt),
    navSetupSkippedAt: toMillis(payload.navSetupSkippedAt),
    setupCapabilityIds: toStringArray(payload.setupCapabilityIds),
    setupCapabilitiesUpdatedAt: toMillis(payload.setupCapabilitiesUpdatedAt),
    setupStateUpdatedAt: toMillis(payload.setupStateUpdatedAt),
    oneRuntimeSetupChoice: normalizeOneRuntimeSetupChoice(
      payload.oneRuntimeSetupChoice,
    ),
    onboardingJourneyVersion: normalizeOnboardingJourneyVersion(
      payload.onboardingJourneyVersion,
    ),
    onboardingPhase: normalizeOnboardingPhase(payload.onboardingPhase),
    // Legacy records may contain capabilities that no longer belong to account
    // setup. Fail closed to the hub instead of manufacturing a retired dynamic
    // route such as `/one/setup/pkm?finish=1`.
    onboardingActiveCapability: normalizeOneSetupCapabilityId(
      payload.onboardingActiveCapability,
    ),
    onboardingResumeRoute:
      payload.onboardingResumeRoute === "/one/setup" ? "/one/setup" : null,
    onboardingCallbackState: normalizeCallbackState(
      payload.onboardingCallbackState,
    ),
    onboardingCallbackAttemptId: normalizeCallbackAttemptId(
      payload.onboardingCallbackAttemptId,
    ),
    onboardingJourneyUpdatedAt: toMillis(payload.onboardingJourneyUpdatedAt),
    phoneVerified: toNullableBool(payload.phoneVerified),
  };
}

function syncSetupCompletionHint(state: PreVaultUserState): void {
  if (state.setupCompleted === true) {
    OneSetupCompletionHintService.markResolved(state.userId);
  }
  // Do NOT clear the latch on a `false`/null read. The completion latch is a
  // sticky, monotonic "onboarding dismissed" signal. Clearing it on routine or
  // racing `setupCompleted === false` reads — which happen on every forced
  // bootstrap a sub-agent makes before a slow/failed durable write has landed —
  // is exactly what let the onboarding guard re-force `/one/setup` on
  // back-navigation after onboarding. The latch is cleared ONLY by an explicit
  // sign-out / account reset via UserLocalStateService.clearForUser.
}

// Cross-device durability self-heal. If this device holds the sticky "dismissed"
// latch but the backend has not (yet) recorded setupCompleted=true — e.g. a
// dismissal-time write failed offline — re-push it once so every device
// converges. Account reset clears the latch, so this never fires post-reset.
const setupCompletionHealInFlight = new Set<string>();

function maybeHealSetupCompletion(state: PreVaultUserState): void {
  // Only heal an EXPLICIT mismatch: the backend says setupCompleted === false
  // while this device holds the sticky "dismissed" latch. A null/unknown
  // backend is the legacy fail-open case and must not trigger a write.
  if (state.setupCompleted !== false) return;
  if (!state.userId) return;
  if (!OneSetupCompletionHintService.isResolved(state.userId)) return;
  if (setupCompletionHealInFlight.has(state.userId)) return;
  setupCompletionHealInFlight.add(state.userId);
  void PreVaultUserStateService.syncKaiSetupState({
    userId: state.userId,
    completed: true,
    skipped: state.setupSkipped === true,
  })
    .catch(() => {
      // Best-effort: the sticky latch keeps THIS device out of setup regardless;
      // a later bootstrap will retry the heal.
    })
    .finally(() => {
      setupCompletionHealInFlight.delete(state.userId);
    });
}

function normalizeOnboardingPhase(
  value: unknown,
): PreVaultUserState["onboardingPhase"] {
  return [
    "anonymous_auth",
    "phone_required",
    "setup_hub",
    "capability_setup",
    "external_connector",
    "root_completion",
  ].includes(String(value))
    ? (value as NonNullable<PreVaultUserState["onboardingPhase"]>)
    : null;
}

function normalizeCallbackState(
  value: unknown,
): PreVaultUserState["onboardingCallbackState"] {
  return ["none", "pending", "succeeded", "cancelled", "failed"].includes(
    String(value),
  )
    ? (value as NonNullable<PreVaultUserState["onboardingCallbackState"]>)
    : null;
}

function normalizeCallbackAttemptId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 96 ? trimmed : null;
}

function resolvePreVaultPath(
  path: "bootstrap-state" | "pre-vault-state",
): string {
  // Native builds call backend directly via ApiService.apiFetch, so these routes
  // must use backend paths instead of Next.js proxy paths.
  if (Capacitor.isNativePlatform()) {
    return `/db/vault/${path}`;
  }
  return `/api/vault/${path}`;
}

async function getAuthHeader(idToken?: string): Promise<string> {
  // A just-completed native Apple flow already owns an authoritative Firebase
  // ID token. Reuse it during post-auth settlement instead of racing the JS
  // SDK, FirebaseAuthentication, and the native keychain for the same token.
  const token = idToken || (await AuthService.getIdToken());
  if (!token) {
    throw new Error(
      "Unable to authenticate request: missing Firebase ID token",
    );
  }
  return `Bearer ${token}`;
}

export class PreVaultUserStateService {
  /**
   * Return only the session-safe bootstrap record already held in the shared
   * cache. Callers use this to render a same-session route immediately, then
   * reconcile against the backend in the background when needed.
   */
  static getCachedBootstrapState(userId: string): PreVaultUserState | null {
    return (
      CacheService.getInstance().get<PreVaultUserState>(
        CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId),
      ) ?? null
    );
  }

  static async bootstrapState(
    userId: string,
    options?: { force?: boolean; idToken?: string },
  ): Promise<PreVaultUserState> {
    const cacheKey = CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId);
    if (!options?.force) {
      const cached =
        CacheService.getInstance().get<PreVaultUserState>(cacheKey);
      if (cached) {
        return cached;
      }
      const inflight = bootstrapInflight.get(cacheKey);
      if (inflight) {
        return inflight;
      }
    }

    // Register the complete async chain before obtaining the Firebase header.
    // Multiple guards mount in the same client commit; registering only after
    // `await getAuthHeader()` leaves a cold-start window where each guard sends
    // its own bootstrap request. Forced callers intentionally stay outside this
    // coalescing path because callback/terminal settlement requires freshness.
    const request = (async () => {
      const authorization = await getAuthHeader(options?.idToken);
      const payload = await apiJson<BootstrapStateResponse>(
        resolvePreVaultPath("bootstrap-state"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authorization,
          },
          body: JSON.stringify({ userId }),
        },
      );
      const normalized = normalizeResponse(userId, payload);
      syncSetupCompletionHint(normalized);
      maybeHealSetupCompletion(normalized);
      // Pre-vault bootstrap state changes infrequently and is updated by this service,
      // so keeping it warm for the session reduces repeated heavy bootstrap requests.
      CacheService.getInstance().set(cacheKey, normalized, CACHE_TTL.SESSION);
      // Fold the verified-phone hint from this same call into a cold identity
      // cache so the phone-mandate guard can resolve without a separate
      // identity/refresh round-trip on first paint.
      AccountIdentityService.primeVerifiedPhoneHint(
        userId,
        normalized.phoneVerified,
      );
      return normalized;
    })();

    if (!options?.force) {
      bootstrapInflight.set(cacheKey, request);
      void request.then(
        () => {
          if (bootstrapInflight.get(cacheKey) === request) {
            bootstrapInflight.delete(cacheKey);
          }
        },
        () => {
          if (bootstrapInflight.get(cacheKey) === request) {
            bootstrapInflight.delete(cacheKey);
          }
        },
      );
    }

    return request;
  }

  static async updatePreVaultState(
    userId: string,
    updates: PreVaultStateUpdatePayload,
    options?: { idToken?: string },
  ): Promise<PreVaultUserState> {
    const authorization = await getAuthHeader(options?.idToken);
    const payload = await apiJson<BootstrapStateResponse>(
      resolvePreVaultPath("pre-vault-state"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: JSON.stringify({ userId, ...updates }),
      },
    );
    const normalized = normalizeResponse(userId, payload);
    syncSetupCompletionHint(normalized);
    CacheService.getInstance().set(
      CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId),
      normalized,
      CACHE_TTL.SESSION,
    );
    return normalized;
  }

  static isSetupResolved(state: PreVaultUserState | null | undefined): boolean {
    if (!state) return false;
    return state.setupCompleted === true;
  }

  static isNavSetupResolved(
    state: PreVaultUserState | null | undefined,
  ): boolean {
    if (!state) return false;
    return Boolean(state.navSetupCompletedAt || state.navSetupSkippedAt);
  }

  /**
   * Mirror the per-capability setup set to the durable backend store. The
   * caller passes the FULL desired set (already merged with the local copy);
   * the backend replaces its stored value. Best-effort at the call site — a
   * failed mirror leaves the local copy authoritative for this device.
   */
  static async syncSetupCapabilities(
    userId: string,
    setupCapabilityIds: readonly string[],
  ): Promise<PreVaultUserState> {
    return this.updatePreVaultState(userId, {
      setupCapabilityIds: toStringArray([...setupCapabilityIds]),
    });
  }

  static hasOneRuntimeChoice(
    state: PreVaultUserState | null | undefined,
  ): boolean {
    return Boolean(
      state?.setupCapabilityIds.includes(ONE_RUNTIME_SETUP_PREREQUISITE_ID),
    );
  }

  /**
   * Has this person connected their own cloud, and has hushh PROVEN it can reach it?
   *
   * There is deliberately no `markOneCloudReady` beside `markOneRuntimeChoice`. The AI
   * choice is a preference the client legitimately asserts; a cloud is an
   * infrastructure fact hushh must verify, so this marker is written SERVER-SIDE by
   * `POST /api/one/runtime/byoc/project/save` only after it has minted a token against
   * the person's bootstrap account. A cloud marker a client could set would be a gate
   * that does nothing -- the person would pass the step without hushh being able to
   * build anything in their project, and the failure would surface much later, during
   * provisioning, in their own cloud.
   */
  static hasOneCloudProject(
    state: PreVaultUserState | null | undefined,
  ): boolean {
    return Boolean(
      state?.setupCapabilityIds.includes(ONE_CLOUD_SETUP_PREREQUISITE_ID),
    );
  }

  /**
   * Persist the explicit, non-secret choice that makes Connections a satisfied
   * root-setup prerequisite. The selected BYOK credential remains encrypted in
   * the vault; this marker only records that the person made a choice.
   */
  static async markOneRuntimeChoice(
    userId: string,
    choice: OneRuntimeSetupChoice,
  ): Promise<PreVaultUserState> {
    const current =
      this.getCachedBootstrapState(userId) ??
      (await this.bootstrapState(userId));
    const setupCapabilityIds = this.hasOneRuntimeChoice(current)
      ? current.setupCapabilityIds
      : [...current.setupCapabilityIds, ONE_RUNTIME_SETUP_PREREQUISITE_ID];

    // A user can reconsider managed Gemini versus BYOK before finishing setup.
    // Keep that choice resumable without ever placing a credential in pre-vault
    // state. `byok_pending_vault` means no key has been entered or stored.
    if (
      this.hasOneRuntimeChoice(current) &&
      current.oneRuntimeSetupChoice === choice
    ) {
      return current;
    }
    return this.updatePreVaultState(userId, {
      setupCapabilityIds: toStringArray(setupCapabilityIds),
      oneRuntimeSetupChoice: choice,
    });
  }

  /** Persist the minimal resumable goal; never a transcript or private content. */
  static async syncOnboardingJourney(params: {
    userId: string;
    phase: NonNullable<PreVaultUserState["onboardingPhase"]>;
    activeCapability?: string | null;
    callbackState?: NonNullable<PreVaultUserState["onboardingCallbackState"]>;
    callbackAttemptId?: string;
    expectedJourneyUpdatedAt?: number | null;
    expectedCallbackAttemptId?: string;
    idToken?: string;
  }): Promise<PreVaultUserState> {
    return this.updatePreVaultState(
      params.userId,
      {
        onboardingJourneyVersion: 1,
        onboardingPhase: params.phase,
        onboardingActiveCapability: params.activeCapability ?? null,
        onboardingResumeRoute: "/one/setup",
        onboardingCallbackState: params.callbackState ?? "none",
        ...(params.callbackAttemptId
          ? { onboardingCallbackAttemptId: params.callbackAttemptId }
          : {}),
        expectedOnboardingJourneyUpdatedAt:
          params.expectedJourneyUpdatedAt ?? undefined,
        ...(params.expectedCallbackAttemptId
          ? { expectedOnboardingCallbackAttemptId: params.expectedCallbackAttemptId }
          : {}),
      },
      { idToken: params.idToken },
    );
  }

  /** Atomically settles the active setup goal against the observed journey. */
  static async settleOnboardingCapability(params: {
    userId: string;
    capabilityId: string;
    completedCapabilityIds?: readonly string[];
    expectedJourneyUpdatedAt: number | null;
    callbackState: NonNullable<PreVaultUserState["onboardingCallbackState"]>;
    expectedCallbackAttemptId?: string;
  }): Promise<PreVaultUserState> {
    return this.updatePreVaultState(params.userId, {
      ...(params.completedCapabilityIds
        ? { setupCapabilityIds: toStringArray([...params.completedCapabilityIds]) }
        : {}),
      onboardingJourneyVersion: 1,
      onboardingPhase: "setup_hub",
      onboardingActiveCapability: null,
      onboardingResumeRoute: "/one/setup",
      onboardingCallbackState: params.callbackState,
      expectedOnboardingJourneyUpdatedAt:
        params.expectedJourneyUpdatedAt ?? undefined,
      ...(params.expectedCallbackAttemptId
        ? { expectedOnboardingCallbackAttemptId: params.expectedCallbackAttemptId }
        : {}),
    });
  }

  static async syncKaiSetupState(params: {
    userId: string;
    completed: boolean;
    skipped: boolean;
    completedAt?: string | number | null;
  }): Promise<PreVaultUserState> {
    const completedAtMs =
      typeof params.completedAt === "number"
        ? params.completedAt
        : typeof params.completedAt === "string" && params.completedAt.trim()
          ? Date.parse(params.completedAt)
          : Date.now();

    return this.updatePreVaultState(params.userId, {
      setupCompleted: params.completed,
      setupSkipped: params.skipped,
      setupCompletedAt:
        params.completed && Number.isFinite(completedAtMs)
          ? completedAtMs
          : Date.now(),
    });
  }

  static primeSetupResolved(params: {
    userId: string;
    skipped: boolean;
    completedAt?: number | null;
  }): PreVaultUserState {
    const cacheKey = CACHE_KEYS.PRE_VAULT_BOOTSTRAP(params.userId);
    const existing =
      CacheService.getInstance().get<PreVaultUserState>(cacheKey);
    const completedAt = params.completedAt ?? Date.now();
    const next: PreVaultUserState = existing
      ? {
          ...existing,
          setupCompleted: true,
          setupSkipped: params.skipped,
          setupCompletedAt: completedAt,
          setupStateUpdatedAt: completedAt,
        }
      : normalizeResponse(params.userId, {
          userId: params.userId,
          setupCompleted: true,
          setupSkipped: params.skipped,
          setupCompletedAt: completedAt,
          setupStateUpdatedAt: completedAt,
        });
    CacheService.getInstance().set(cacheKey, next, CACHE_TTL.SESSION);
    OneSetupCompletionHintService.markResolved(params.userId);
    return next;
  }
}
