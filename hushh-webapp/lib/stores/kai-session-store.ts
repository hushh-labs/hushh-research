/**
 * KaiSessionStore - Zustand store for cross-page Kai session state
 * ================================================================
 *
 * ZERO PERSISTENCE: No sessionStorage, no localStorage, no persist middleware.
 * All data lives only in React memory. On page refresh, user is redirected
 * to the dashboard to re-initiate their flow.
 *
 * This replaces:
 * - sessionStorage "kai_analysis_params" (leaked vaultOwnerToken!)
 * - sessionStorage "kai_losers_analysis_input"
 * - localStorage "lastKaiPath"
 */

import { create } from "zustand";
import type { PortfolioSource } from "@/lib/kai/brokerage/portfolio-sources";

interface AnalysisParams {
  ticker: string;
  userId: string;
  riskProfile: string;
  userContext?: Record<string, unknown>;
  portfolioSource?: PortfolioSource;
  portfolioContext?: Record<string, unknown> | null;
  pickSource?: string;
  pickSourceLabel?: string;
}

interface LosersInput {
  userId: string;
  thresholdPct: number;
  maxPositions: number;
  losers: Array<Record<string, unknown>>;
  holdings?: Array<Record<string, unknown>>;
  forceOptimize?: boolean;
  hadBelowThreshold?: boolean;
  portfolioSource?: PortfolioSource;
  portfolioContext?: Record<string, unknown> | null;
  sourceMetadata?: Record<string, unknown> | null;
}

interface KaiSessionState {
  /** Parameters for the current stock analysis */
  analysisParams: AnalysisParams | null;
  /** Epoch ms for when analysis params were last set (used to reject stale intents). */
  analysisParamsUpdatedAt: number | null;
  /** Input data for portfolio health / losers analysis */
  losersInput: LosersInput | null;
  /** Last visited Kai sub-path for navbar navigation */
  lastKaiPath: string;
  /** Last visited RIA sub-path for shell navigation */
  lastRiaPath: string;
  /** Active long-running Kai operations keyed by operation id */
  busyOperations: Record<string, boolean>;
  /** Derived flag for disabling global analyze search UI */
  isSearchDisabled: boolean;

  /** Set analysis parameters (replaces sessionStorage "kai_analysis_params") */
  setAnalysisParams: (params: AnalysisParams | null) => void;
  /** Set losers analysis input (replaces sessionStorage "kai_losers_analysis_input") */
  setLosersInput: (input: LosersInput | null) => void;
  /** Update last visited Kai path (replaces localStorage "lastKaiPath") */
  setLastKaiPath: (path: string) => void;
  /** Update last visited RIA path */
  setLastRiaPath: (path: string) => void;
  /** Mark/unmark a named long-running operation */
  setBusyOperation: (operation: string, busy: boolean) => void;
  /** Clear all session state */
  clear: () => void;
}

export const useKaiSession = create<KaiSessionState>((set) => ({
  analysisParams: null,
  analysisParamsUpdatedAt: null,
  losersInput: null,
  lastKaiPath: "/kai",
  lastRiaPath: "/ria",
  busyOperations: {},
  isSearchDisabled: false,

  setAnalysisParams: (params) =>
    set({
      analysisParams: params,
      analysisParamsUpdatedAt: params ? Date.now() : null,
    }),
  setLosersInput: (input) => set({ losersInput: input }),
  setLastKaiPath: (path) => set({ lastKaiPath: path }),
  setLastRiaPath: (path) => set({ lastRiaPath: path }),
  setBusyOperation: (operation, busy) =>
    set((state) => {
      const nextBusyOperations = { ...state.busyOperations };
      if (busy) {
        nextBusyOperations[operation] = true;
      } else {
        delete nextBusyOperations[operation];
      }
      return {
        busyOperations: nextBusyOperations,
        isSearchDisabled: Object.keys(nextBusyOperations).length > 0,
      };
    }),
  clear: () =>
    set({
      analysisParams: null,
      analysisParamsUpdatedAt: null,
      losersInput: null,
      lastKaiPath: "/kai",
      lastRiaPath: "/ria",
      busyOperations: {},
      isSearchDisabled: false,
    }),
}));

export type { AnalysisParams, LosersInput, KaiSessionState };
