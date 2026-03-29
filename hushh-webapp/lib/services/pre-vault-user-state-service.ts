"use client";

import { Capacitor } from "@capacitor/core";
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
  preOnboardingCompleted: boolean | null;
  preOnboardingSkipped: boolean | null;
  preOnboardingCompletedAt: number | null;
  preNavTourCompletedAt: number | null;
  preNavTourSkippedAt: number | null;
  preStateUpdatedAt: number | null;
};

type BootstrapStateResponse = Partial<PreVaultUserState>;

type PreVaultStateUpdatePayload = {
  preOnboardingCompleted?: boolean;
  preOnboardingSkipped?: boolean;
  preOnboardingCompletedAt?: number | null;
  preNavTourCompletedAt?: number | null;
  preNavTourSkippedAt?: number | null;
};

const bootstrapInflight = new Map<string, Promise<PreVaultUserState>>();

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    preOnboardingCompleted: toNullableBool(payload.preOnboardingCompleted),
    preOnboardingSkipped: toNullableBool(payload.preOnboardingSkipped),
    preOnboardingCompletedAt: toMillis(payload.preOnboardingCompletedAt),
    preNavTourCompletedAt: toMillis(payload.preNavTourCompletedAt),
    preNavTourSkippedAt: toMillis(payload.preNavTourSkippedAt),
    preStateUpdatedAt: toMillis(payload.preStateUpdatedAt),
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

  static isOnboardingResolved(state: PreVaultUserState | null | undefined): boolean {
    if (!state) return false;
    if (state.preOnboardingCompletedAt !== null) return true;
    return state.preOnboardingCompleted === true;
  }

  static isNavTourResolved(state: PreVaultUserState | null | undefined): boolean {
    if (!state) return false;
    return Boolean(state.preNavTourCompletedAt || state.preNavTourSkippedAt);
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
    });
  }
}
