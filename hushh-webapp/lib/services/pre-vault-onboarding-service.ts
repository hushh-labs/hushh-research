"use client";

import { Preferences } from "@capacitor/preferences";
import {
  getLocalItem,
  removeLocalItem,
  setLocalItem,
} from "@/lib/utils/session-storage";
import type {
  DrawdownResponse,
  InvestmentHorizon,
  RiskProfile,
  VolatilityPreference,
} from "@/lib/services/kai-profile-service";
import { setOnboardingRequiredCookie } from "@/lib/services/onboarding-route-cookie";

const KEY_PREFIX = "kai_pre_vault_onboarding_v1";
const VERSION = 1 as const;
const FALLBACK_STORAGE_PREFIX = `${KEY_PREFIX}:fallback`;

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

function keyForUser(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

function fallbackKeyForUser(userId: string): string {
  return `${FALLBACK_STORAGE_PREFIX}:${userId}`;
}

async function persist(userId: string, state: PreVaultOnboardingState): Promise<void> {
  const serialized = JSON.stringify(state);
  try {
    await Preferences.set({
      key: keyForUser(userId),
      value: serialized,
    });
    setLocalItem(fallbackKeyForUser(userId), serialized);
  } catch (error) {
    // Keep onboarding progression fail-open when native Preferences temporarily fails.
    if (typeof window !== "undefined") {
      setLocalItem(fallbackKeyForUser(userId), serialized);
      setOnboardingRequiredCookie(!state.completed);
      return;
    }
    throw error;
  }
  setOnboardingRequiredCookie(!state.completed);
}

export class PreVaultOnboardingService {
  static keyForUser(userId: string): string {
    return keyForUser(userId);
  }

  static async load(userId: string): Promise<PreVaultOnboardingState | null> {
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

    await persist(userId, next);
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

    await persist(userId, next);
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

    await persist(userId, next);
    return next;
  }

  static async clear(userId: string): Promise<void> {
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
