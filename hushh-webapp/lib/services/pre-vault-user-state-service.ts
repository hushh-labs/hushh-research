"use client";

import { Capacitor } from "@capacitor/core";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { apiJson } from "@/lib/services/api-client";
import { AuthService } from "@/lib/services/auth-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";

export type VaultStatus = "placeholder" | "active";

export type PreVaultUserState = {
  userId: string;
  hasVault: boolean;
  vaultStatus: VaultStatus;
  firstLoginAt: number | null;
  lastLoginAt: number | null;
  loginCount: number;
  setupCompleted: boolean | null;
  setupSkipped: boolean | null;
  setupCompletedAt: number | null;
  preOnboardingCompleted: boolean | null;
  preOnboardingSkipped: boolean | null;
  preOnboardingCompletedAt: number | null;
  navSetupCompletedAt: number | null;
  navSetupSkippedAt: number | null;
  // Per-capability setup mirror: ids the user has set up at least once. The
  // client local store (CapabilityTourService) is the source of truth; this is
  // the durable, cross-device echo. Always an array (never null) so callers can
  // treat absent as "nothing set up".
  setupCapabilityIds: string[];
  setupCapabilitiesUpdatedAt: number | null;
  setupStateUpdatedAt: number | null;
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
  preOnboardingCompleted?: boolean;
  preOnboardingSkipped?: boolean;
  preOnboardingCompletedAt?: number | null;
  navSetupCompletedAt?: number | null;
  navSetupSkippedAt?: number | null;
  setupCapabilityIds?: string[];
};

const bootstrapInflight = new Map<string, Promise<PreVaultUserState>>();

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeResponse(userId: string, payload: BootstrapStateResponse): PreVaultUserState {
  const status = (payload.vaultStatus || "placeholder") as VaultStatus;
  return {
    userId: String(payload.userId || userId),
    hasVault: Boolean(payload.hasVault) || status === "active",
    vaultStatus: status,
    firstLoginAt: toMillis(payload.firstLoginAt),
    lastLoginAt: toMillis(payload.lastLoginAt),
    loginCount: Number(payload.loginCount || 0),
    setupCompleted: toNullableBool(payload.setupCompleted),
    setupSkipped: toNullableBool(payload.setupSkipped),
    setupCompletedAt: toMillis(payload.setupCompletedAt),
    preOnboardingCompleted: toNullableBool(
      payload.preOnboardingCompleted ?? payload.setupCompleted,
    ),
    preOnboardingSkipped: toNullableBool(
      payload.preOnboardingSkipped ?? payload.setupSkipped,
    ),
    preOnboardingCompletedAt: toMillis(
      payload.preOnboardingCompletedAt ?? payload.setupCompletedAt,
    ),
    navSetupCompletedAt: toMillis(payload.navSetupCompletedAt),
    navSetupSkippedAt: toMillis(payload.navSetupSkippedAt),
    setupCapabilityIds: toStringArray(payload.setupCapabilityIds),
    setupCapabilitiesUpdatedAt: toMillis(payload.setupCapabilitiesUpdatedAt),
    setupStateUpdatedAt: toMillis(payload.setupStateUpdatedAt),
    phoneVerified: toNullableBool(payload.phoneVerified),
  };
}

function resolvePreVaultPath(path: "bootstrap-state" | "pre-vault-state"): string {
  // Native builds call backend directly via ApiService.apiFetch, so these routes
  // must use backend paths instead of Next.js proxy paths.
  if (Capacitor.isNativePlatform()) {
    return `/db/vault/${path}`;
  }
  return `/api/vault/${path}`;
}

async function getAuthHeader(): Promise<string> {
  const token = await AuthService.getIdToken();
  if (!token) {
    throw new Error("Unable to authenticate request: missing Firebase ID token");
  }
  return `Bearer ${token}`;
}

export class PreVaultUserStateService {
  static async bootstrapState(
    userId: string,
    options?: { force?: boolean }
  ): Promise<PreVaultUserState> {
    const cacheKey = CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId);
    if (!options?.force) {
      const cached = CacheService.getInstance().get<PreVaultUserState>(cacheKey);
      if (cached) {
        return cached;
      }
      const inflight = bootstrapInflight.get(cacheKey);
      if (inflight) {
        return inflight;
      }
    }

    const authorization = await getAuthHeader();
    const request = apiJson<BootstrapStateResponse>(resolvePreVaultPath("bootstrap-state"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({ userId }),
    })
      .then((payload) => {
        const normalized = normalizeResponse(userId, payload);
        // Pre-vault bootstrap state changes infrequently and is updated by this service,
        // so keeping it warm for the session reduces repeated heavy bootstrap requests.
        CacheService.getInstance().set(cacheKey, normalized, CACHE_TTL.SESSION);
        // Fold the verified-phone hint from this same call into a cold identity
        // cache so the phone-mandate guard can resolve without a separate
        // identity/refresh round-trip on first paint.
        AccountIdentityService.primeVerifiedPhoneHint(userId, normalized.phoneVerified);
        return normalized;
      })
      .finally(() => {
        if (bootstrapInflight.get(cacheKey) === request) {
          bootstrapInflight.delete(cacheKey);
        }
      });

    bootstrapInflight.set(cacheKey, request);
    return request;
  }

  static async updatePreVaultState(
    userId: string,
    updates: PreVaultStateUpdatePayload
  ): Promise<PreVaultUserState> {
    const authorization = await getAuthHeader();
    const payload = await apiJson<BootstrapStateResponse>(resolvePreVaultPath("pre-vault-state"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({ userId, ...updates }),
    });
    const normalized = normalizeResponse(userId, payload);
    CacheService.getInstance().set(
      CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId),
      normalized,
      CACHE_TTL.SESSION
    );
    return normalized;
  }

  static isSetupResolved(state: PreVaultUserState | null | undefined): boolean {
    if (!state) return false;
    return state.setupCompleted === true;
  }

  static isOnboardingResolved(state: PreVaultUserState | null | undefined): boolean {
    if (!state) return false;
    return state.preOnboardingCompleted === true || state.setupCompleted === true;
  }

  static isNavSetupResolved(state: PreVaultUserState | null | undefined): boolean {
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
    setupCapabilityIds: readonly string[]
  ): Promise<PreVaultUserState> {
    return this.updatePreVaultState(userId, {
      setupCapabilityIds: toStringArray([...setupCapabilityIds]),
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
        params.completed && Number.isFinite(completedAtMs) ? completedAtMs : Date.now(),
    });
  }

  static async syncKaiOnboardingState(params: {
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
      preOnboardingCompleted: params.completed,
      preOnboardingSkipped: params.skipped,
      preOnboardingCompletedAt:
        params.completed && Number.isFinite(completedAtMs) ? completedAtMs : Date.now(),
      setupCompleted: params.completed,
      setupSkipped: params.skipped,
      setupCompletedAt:
        params.completed && Number.isFinite(completedAtMs) ? completedAtMs : Date.now(),
    });
  }
}
