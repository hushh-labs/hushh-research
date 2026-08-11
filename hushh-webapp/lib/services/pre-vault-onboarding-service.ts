"use client";

import { Preferences } from "@capacitor/preferences";
import {
  getLocalItem,
  removeLocalItem,
} from "@/lib/utils/session-storage";
import type {
  DrawdownResponse,
  InvestmentHorizon,
  RiskProfile,
  VolatilityPreference,
} from "@/lib/services/kai-profile-service";
import { setOnboardingRequiredCookie } from "@/lib/services/onboarding-route-cookie";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

const KEY_PREFIX = "kai_pre_vault_onboarding_v1";
const VERSION = 1 as const;
const FALLBACK_STORAGE_PREFIX = `${KEY_PREFIX}:fallback`;
const VAULT_HANDOFF_RESOURCE_KEY = "pre_vault_onboarding:vault_handoff:v1";
const VAULT_HANDOFF_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// New onboarding information is intentionally memory-only until Finish setup.
// The legacy Preferences/localStorage records below are read solely to migrate
// an older install through an encrypted handoff, then deleted.
const volatileDrafts = new Map<string, PreVaultOnboardingState>();

export type PreVaultOnboardingAnswers = {
  investment_horizon: InvestmentHorizon | null;
  drawdown_response: DrawdownResponse | null;
  volatility_preference: VolatilityPreference | null;
};

export type PreVaultOnboardingState = {
  version: 1;
  completed: boolean;
  skipped: boolean;
  completed_at: string | null;
  answers: PreVaultOnboardingAnswers;
  risk_score: number | null;
  risk_profile: RiskProfile | null;
  synced_to_vault_at: string | null;
  updated_at: string;
};

type DraftUpdate = {
  answers?: Partial<PreVaultOnboardingAnswers>;
  risk_score?: number | null;
  risk_profile?: RiskProfile | null;
};

type VaultHandoffRecord = {
  version: 1;
  source: "pre_vault_onboarding";
  state: PreVaultOnboardingState;
  committedAt: string | null;
};

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function defaultAnswers(): PreVaultOnboardingAnswers {
  return {
    investment_horizon: null,
    drawdown_response: null,
    volatility_preference: null,
  };
}

function createDefaultState(now?: Date): PreVaultOnboardingState {
  const iso = nowIso(now);
  return {
    version: VERSION,
    completed: false,
    skipped: false,
    completed_at: null,
    answers: defaultAnswers(),
    risk_score: null,
    risk_profile: null,
    synced_to_vault_at: null,
    updated_at: iso,
  };
}

function isInvestmentHorizon(value: unknown): value is InvestmentHorizon {
  return value === "short_term" || value === "medium_term" || value === "long_term";
}

function isDrawdownResponse(value: unknown): value is DrawdownResponse {
  return value === "reduce" || value === "stay" || value === "buy_more";
}

function isVolatilityPreference(value: unknown): value is VolatilityPreference {
  return value === "small" || value === "moderate" || value === "large";
}

function isRiskProfile(value: unknown): value is RiskProfile {
  return value === "conservative" || value === "balanced" || value === "aggressive";
}

function normalizeState(raw: unknown): PreVaultOnboardingState {
  const fallback = createDefaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  const answersRaw =
    record.answers && typeof record.answers === "object" && !Array.isArray(record.answers)
      ? (record.answers as Record<string, unknown>)
      : {};

  const riskScoreRaw =
    typeof record.risk_score === "number" && Number.isFinite(record.risk_score)
      ? record.risk_score
      : null;

  return {
    version: VERSION,
    completed: record.completed === true,
    skipped: record.skipped === true,
    completed_at:
      typeof record.completed_at === "string" && record.completed_at.trim().length > 0
        ? record.completed_at
        : null,
    answers: {
      investment_horizon: isInvestmentHorizon(answersRaw.investment_horizon)
        ? answersRaw.investment_horizon
        : null,
      drawdown_response: isDrawdownResponse(answersRaw.drawdown_response)
        ? answersRaw.drawdown_response
        : null,
      volatility_preference: isVolatilityPreference(answersRaw.volatility_preference)
        ? answersRaw.volatility_preference
        : null,
    },
    risk_score:
      riskScoreRaw !== null && riskScoreRaw >= 0 && riskScoreRaw <= 6 ? riskScoreRaw : null,
    risk_profile: isRiskProfile(record.risk_profile) ? record.risk_profile : null,
    synced_to_vault_at:
      typeof record.synced_to_vault_at === "string" && record.synced_to_vault_at.trim().length > 0
        ? record.synced_to_vault_at
        : null,
    updated_at:
      typeof record.updated_at === "string" && record.updated_at.trim().length > 0
        ? record.updated_at
        : fallback.updated_at,
  };
}

function normalizeVaultHandoff(raw: unknown): VaultHandoffRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || record.source !== "pre_vault_onboarding") {
    return null;
  }
  if (!record.state || typeof record.state !== "object" || Array.isArray(record.state)) {
    return null;
  }

  const state = normalizeState(record.state);
  const committedAt =
    typeof record.committedAt === "string" && record.committedAt.trim().length > 0
      ? record.committedAt
      : null;

  return {
    version: VERSION,
    source: "pre_vault_onboarding",
    state,
    committedAt,
  };
}

function keyForUser(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

function fallbackKeyForUser(userId: string): string {
  return `${FALLBACK_STORAGE_PREFIX}:${userId}`;
}

function retainVolatileDraft(userId: string, state: PreVaultOnboardingState): void {
  volatileDrafts.set(userId, state);
  setOnboardingRequiredCookie(!state.completed);
}

export class PreVaultOnboardingService {
  static keyForUser(userId: string): string {
    return keyForUser(userId);
  }

  static async load(userId: string): Promise<PreVaultOnboardingState | null> {
    const volatile = volatileDrafts.get(userId);
    if (volatile) return volatile;

    // Compatibility read only. Never write a new pre-vault record to either
    // browser persistence surface: a refresh intentionally discards fresh
    // setup answers until the private vault is finalized.
    try {
      const { value } = await Preferences.get({ key: keyForUser(userId) });
      if (!value) return null;
      return normalizeState(JSON.parse(value));
    } catch {
      // Fall through to localStorage fallback for WKWebView/plugin hiccups.
    }

    if (typeof window !== "undefined") {
      try {
        const fallback = getLocalItem(fallbackKeyForUser(userId));
        if (!fallback) return null;
        return normalizeState(JSON.parse(fallback));
      } catch (error) {
        console.warn("[PreVaultOnboardingService] Failed to load fallback state:", error);
        return null;
      }
    }

    return null;
  }

  static async saveDraft(
    userId: string,
    update: DraftUpdate,
    now?: Date
  ): Promise<PreVaultOnboardingState> {
    const current = (await this.load(userId)) ?? createDefaultState(now);
    const iso = nowIso(now);

    const next: PreVaultOnboardingState = {
      ...current,
      completed: false,
      skipped: false,
      completed_at: null,
      synced_to_vault_at: null,
      answers: {
        ...current.answers,
        ...(update.answers ?? {}),
      },
      risk_score:
        update.risk_score === undefined ? current.risk_score : update.risk_score,
      risk_profile:
        update.risk_profile === undefined ? current.risk_profile : update.risk_profile,
      updated_at: iso,
    };

    retainVolatileDraft(userId, next);
    return next;
  }

  static async markCompleted(
    userId: string,
    params: {
      skipped: boolean;
      answers?: Partial<PreVaultOnboardingAnswers>;
      risk_score?: number | null;
      risk_profile?: RiskProfile | null;
    },
    now?: Date
  ): Promise<PreVaultOnboardingState> {
    const current = (await this.load(userId)) ?? createDefaultState(now);
    const iso = nowIso(now);

    const next: PreVaultOnboardingState = {
      ...current,
      completed: true,
      skipped: params.skipped,
      completed_at: iso,
      answers: {
        ...current.answers,
        ...(params.answers ?? {}),
      },
      risk_score:
        params.risk_score === undefined ? current.risk_score : params.risk_score,
      risk_profile:
        params.risk_profile === undefined ? current.risk_profile : params.risk_profile,
      updated_at: iso,
    };

    retainVolatileDraft(userId, next);
    return next;
  }

  static async markSynced(userId: string, now?: Date): Promise<PreVaultOnboardingState | null> {
    const current = await this.load(userId);
    if (!current) return null;

    const iso = nowIso(now);
    const next: PreVaultOnboardingState = {
      ...current,
      synced_to_vault_at: iso,
      updated_at: iso,
    };

    retainVolatileDraft(userId, next);
    return next;
  }

  /**
   * Check for a prior encrypted handoff whose PKM commit has already succeeded,
   * then finish removing the legacy browser source. This is intentionally
   * idempotent: a failed cleanup leaves only the encrypted handoff plus the
   * original source, so the next unlocked session retries deletion without
   * writing the domain again.
   */
  static async finalizeKnownVaultCommit(params: {
    userId: string;
    vaultKey: string;
  }): Promise<boolean> {
    const encrypted = normalizeVaultHandoff(
      await SecureResourceCacheService.read<unknown>({
        userId: params.userId,
        resourceKey: VAULT_HANDOFF_RESOURCE_KEY,
        vaultKey: params.vaultKey,
      }),
    );

    if (encrypted?.committedAt) {
      await this.clearAfterVaultCommit(params.userId);
      await SecureResourceCacheService.invalidateResource(
        params.userId,
        VAULT_HANDOFF_RESOURCE_KEY,
      );
      return true;
    }

    // Earlier clients recorded a plaintext completion timestamp only after the
    // encrypted PKM write returned successfully. Convert that narrow legacy
    // receipt into an encrypted handoff before retiring the plaintext copy.
    const legacy = await this.load(params.userId);
    if (!legacy?.synced_to_vault_at) {
      return false;
    }

    await this.completeAfterVaultCommit({
      userId: params.userId,
      vaultKey: params.vaultKey,
      state: legacy,
      committedAt: legacy.synced_to_vault_at,
    });
    return true;
  }

  /**
   * Store a temporary encrypted receipt and then remove the pre-vault source.
   * Call this only after the authoritative PKM write has completed. If either
   * encrypted receipt write or source cleanup fails, the source remains for a
   * later unlocked retry; no user answer is discarded on a partial migration.
   */
  static async completeAfterVaultCommit(params: {
    userId: string;
    vaultKey: string;
    state?: PreVaultOnboardingState | null;
    committedAt?: string;
  }): Promise<boolean> {
    const state = params.state ?? (await this.load(params.userId));
    if (!state) {
      return false;
    }

    const handoff: VaultHandoffRecord = {
      version: VERSION,
      source: "pre_vault_onboarding",
      state,
      committedAt: params.committedAt ?? nowIso(),
    };

    await SecureResourceCacheService.writeRequired({
      userId: params.userId,
      resourceKey: VAULT_HANDOFF_RESOURCE_KEY,
      value: handoff,
      ttlMs: VAULT_HANDOFF_TTL_MS,
      vaultKey: params.vaultKey,
    });

    await this.clearAfterVaultCommit(params.userId);
    await SecureResourceCacheService.invalidateResource(
      params.userId,
      VAULT_HANDOFF_RESOURCE_KEY,
    );
    return true;
  }

  /**
   * Strict cleanup for the post-commit path. Unlike ordinary account cleanup,
   * a storage failure is observable so the encrypted receipt can retry this on
   * the next unlock instead of silently claiming the legacy source was removed.
   */
  private static async clearAfterVaultCommit(userId: string): Promise<void> {
    volatileDrafts.delete(userId);
    await Preferences.remove({ key: keyForUser(userId) });
    removeLocalItem(fallbackKeyForUser(userId));
    setOnboardingRequiredCookie(false);
  }

  static async clear(userId: string): Promise<void> {
    volatileDrafts.delete(userId);
    try {
      await Preferences.remove({ key: keyForUser(userId) });
    } catch (error) {
      console.warn("[PreVaultOnboardingService] Failed to clear state:", error);
    } finally {
      setOnboardingRequiredCookie(false);
      removeLocalItem(fallbackKeyForUser(userId));
    }
  }
}
