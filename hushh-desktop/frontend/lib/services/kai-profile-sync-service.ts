"use client";

import {
  KaiProfileService,
  computeRiskScore,
  mapRiskProfile,
} from "@/lib/services/kai-profile-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { KaiNavTourLocalService } from "@/lib/services/kai-nav-tour-local-service";
import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";

type OnboardingPayload = {
  completed: boolean;
  skippedPreferences: boolean;
  completedAt?: string | null;
  answers?: {
    investment_horizon: "short_term" | "medium_term" | "long_term" | null;
    drawdown_response: "reduce" | "stay" | "buy_more" | null;
    volatility_preference: "small" | "moderate" | "large" | null;
  };
};

type NavPayload = {
  completedAt?: string | null;
  skippedAt?: string | null;
};

export type KaiProfilePendingSyncState = {
  hasPending: boolean;
  reason?: string;
  onboardingPayload?: OnboardingPayload;
  navPayload?: NavPayload;
  pendingOnboarding?: Awaited<ReturnType<typeof PreVaultOnboardingService.load>>;
  pendingNavTour?: Awaited<ReturnType<typeof KaiNavTourLocalService.load>>;
};

export class KaiProfileSyncService {
  static async getPendingSyncState(userId: string): Promise<KaiProfilePendingSyncState> {
    const [pendingOnboarding, pendingNavTour] = await Promise.all([
      PreVaultOnboardingService.load(userId),
      KaiNavTourLocalService.load(userId),
    ]);

    let onboardingReason: string | undefined;
    let navReason: string | undefined;
    let onboardingPayload: OnboardingPayload | undefined;
    let navPayload: NavPayload | undefined;

    if (!pendingOnboarding) {
      onboardingReason = "no_pending_state";
    } else if (!pendingOnboarding.completed) {
      onboardingReason = "not_completed";
    } else if (pendingOnboarding.synced_to_vault_at) {
      onboardingReason = "already_synced";
    } else if (pendingOnboarding.skipped) {
      onboardingPayload = {
        completed: true,
        skippedPreferences: true,
        completedAt: pendingOnboarding.completed_at ?? undefined,
      };
    } else {
      const answers = pendingOnboarding.answers;
      const riskScore = computeRiskScore(answers);
      if (
        !answers.investment_horizon ||
        !answers.drawdown_response ||
        !answers.volatility_preference ||
        riskScore === null
      ) {
        onboardingReason = "incomplete_answers";
      } else {
        onboardingPayload = {
          completed: true,
          skippedPreferences: false,
          completedAt: pendingOnboarding.completed_at ?? undefined,
          answers,
        };
      }
    }

    if (!pendingNavTour) {
      navReason = "no_pending_state";
    } else if (pendingNavTour.synced_to_vault_at) {
      navReason = "already_synced";
    } else if (!pendingNavTour.completed_at && !pendingNavTour.skipped_at) {
      navReason = "not_completed";
    } else {
      navPayload = {
        completedAt: pendingNavTour.completed_at,
        skippedAt: pendingNavTour.skipped_at,
      };
    }

    if (!onboardingPayload && !navPayload) {
      return {
        hasPending: false,
        reason:
          navReason && navReason !== "no_pending_state"
            ? `nav_tour_${navReason}`
            : onboardingReason ?? "no_pending_state",
        pendingOnboarding,
        pendingNavTour,
      };
    }

    return {
      hasPending: true,
      onboardingPayload,
      navPayload,
      pendingOnboarding,
      pendingNavTour,
    };
  }

  static async syncPendingToVault(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
    pendingState?: KaiProfilePendingSyncState;
    baseFullBlob?: Record<string, unknown>;
  }): Promise<{ synced: boolean; reason?: string }> {
    if (AppBackgroundTaskService.hasRunningTask(params.userId, "portfolio_save")) {
      return {
        synced: false,
        reason: "portfolio_save_inflight",
      };
    }

    const pendingState = params.pendingState ?? (await this.getPendingSyncState(params.userId));
    if (!pendingState.hasPending) {
      return {
        synced: false,
        reason: pendingState.reason ?? "no_pending_state",
      };
    }

    // Retry with exponential backoff (max 3 attempts)
    const retryDelays = [0, 1000, 3000];
    let lastError: unknown;
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        }
        await KaiProfileService.syncOnboardingAndNavState({
          userId: params.userId,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          baseFullBlob: params.baseFullBlob,
          onboarding: pendingState.onboardingPayload,
          navTour: pendingState.navPayload,
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `[KaiProfileSyncService] Sync attempt ${attempt + 1}/${retryDelays.length} failed:`,
          error,
        );
      }
    }
    if (lastError) {
      throw lastError;
    }

    const pendingOnboarding = pendingState.pendingOnboarding;
    if (
      pendingState.onboardingPayload &&
      pendingOnboarding &&
      !pendingOnboarding.skipped
    ) {
      const answers = pendingOnboarding.answers;
      const riskScore = computeRiskScore(answers);
      if (
        answers.investment_horizon &&
        answers.drawdown_response &&
        answers.volatility_preference &&
        riskScore !== null
      ) {
        const riskProfile = pendingOnboarding.risk_profile ?? mapRiskProfile(riskScore);
        await PreVaultOnboardingService.markCompleted(params.userId, {
          skipped: false,
          answers,
          risk_score: riskScore,
          risk_profile: riskProfile,
        });
      }
    }

    if (pendingState.onboardingPayload) {
      await PreVaultOnboardingService.markSynced(params.userId);
    }
    if (pendingState.navPayload) {
      await KaiNavTourLocalService.markSynced(params.userId);
    }

    return { synced: true };
  }
}
