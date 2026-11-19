import { normalizeDetailedPersona } from "./detailed-persona";
import { normalizeLossCapacity } from "./investing-persona";
import type {
  HorizonAnchorChoice,
  InvestmentHorizon,
  KaiPreferences,
  KaiPreferencesUpdate,
} from "@/lib/services/kai-profile-service";

export function shouldPromptForHorizonAnchor(params: {
  mode: "onboarding" | "edit";
  previousHorizon: InvestmentHorizon | null;
  nextHorizon: InvestmentHorizon | null;
}): boolean {
  if (params.mode !== "edit") return false;
  if (!params.previousHorizon) return false;
  return params.previousHorizon !== params.nextHorizon;
}

export function resolveHorizonAnchorAt(params: {
  previousAnchorAt: string | null;
  now: string;
  choice: HorizonAnchorChoice;
}): string {
  if (params.choice === "keep_original") {
    return params.previousAnchorAt ?? params.now;
  }
  return params.now;
}

export function applyKaiPreferenceUpdates(
  current: KaiPreferences,
  params: {
    updates: KaiPreferencesUpdate;
    mode: "onboarding" | "edit";
    horizonAnchorChoice?: HorizonAnchorChoice;
  },
  iso: string,
): KaiPreferences {
  const preferences = { ...current };
  // Investment horizon (with anchor semantics)
  if (params.updates.investment_horizon !== undefined) {
    const nextHorizon = params.updates.investment_horizon;
    const prevHorizon = preferences.investment_horizon;
    if (nextHorizon !== prevHorizon) {
      preferences.investment_horizon = nextHorizon;
      preferences.investment_horizon_selected_at = iso;

      if (!prevHorizon) {
        // First time selection: anchor = now.
        preferences.investment_horizon_anchor_at = iso;
      } else if (
        shouldPromptForHorizonAnchor({
          mode: params.mode,
          previousHorizon: prevHorizon,
          nextHorizon,
        })
      ) {
        const choice: HorizonAnchorChoice =
          params.horizonAnchorChoice ?? "from_now";
        preferences.investment_horizon_anchor_at =
          resolveHorizonAnchorAt({
            previousAnchorAt:
              preferences.investment_horizon_anchor_at,
            now: iso,
            choice,
          });
      } else {
        // onboarding mode, or null->value edits
        preferences.investment_horizon_anchor_at = iso;
      }
    }
  }

  if (params.updates.drawdown_response !== undefined) {
    const nextDrawdown = params.updates.drawdown_response;
    if (nextDrawdown !== preferences.drawdown_response) {
      preferences.drawdown_response = nextDrawdown ?? null;
      preferences.drawdown_response_selected_at = iso;
    }
  }

  if (params.updates.volatility_preference !== undefined) {
    const nextVol = params.updates.volatility_preference;
    if (nextVol !== preferences.volatility_preference) {
      preferences.volatility_preference = nextVol ?? null;
      preferences.volatility_preference_selected_at = iso;
    }
  }

  if (params.updates.loss_capacity !== undefined) {
    preferences.loss_capacity = normalizeLossCapacity(
      params.updates.loss_capacity,
    );
  }
  if (params.updates.detailed_assessment_v1 !== undefined) {
    preferences.detailed_assessment_v1 = normalizeDetailedPersona(
      params.updates.detailed_assessment_v1,
    );
  }
  return preferences;
}
