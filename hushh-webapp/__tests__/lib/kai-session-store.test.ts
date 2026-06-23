import { beforeEach, describe, expect, it } from "vitest";

import { useKaiSession } from "@/lib/stores/kai-session-store";
import { ROUTES } from "@/lib/navigation/routes";

beforeEach(() => {
  useKaiSession.getState().clear();
});

describe("useKaiSession", () => {
  describe("initial state", () => {
    it("initializes with expected defaults", () => {
      const state = useKaiSession.getState();

      expect(state.analysisParams).toBeNull();
      expect(state.analysisParamsUpdatedAt).toBeNull();
      expect(state.losersInput).toBeNull();
      expect(state.lastKaiPath).toBe(ROUTES.KAI_HOME);
      expect(state.busyOperations).toEqual({});
      expect(state.isSearchDisabled).toBe(false);
    });
  });

  describe("setAnalysisParams", () => {
    it("stores analysis params", () => {
      const params = { test: true };

      useKaiSession.getState().setAnalysisParams(params as never);

      expect(useKaiSession.getState().analysisParams).toEqual(params);
      expect(useKaiSession.getState().analysisParamsUpdatedAt).not.toBeNull();
    });

    it("clears analysis params when passed null", () => {
      useKaiSession
        .getState()
        .setAnalysisParams({ test: true } as never);

      useKaiSession.getState().setAnalysisParams(null);

      expect(useKaiSession.getState().analysisParams).toBeNull();
      expect(useKaiSession.getState().analysisParamsUpdatedAt).toBeNull();
    });
  });

  describe("setBusyOperation", () => {
    it("disables search when an operation becomes busy", () => {
      useKaiSession.getState().setBusyOperation("analysis", true);

      expect(useKaiSession.getState().isSearchDisabled).toBe(true);
    });

    it("re-enables search when all operations are cleared", () => {
      useKaiSession.getState().setBusyOperation("analysis", true);
      useKaiSession.getState().setBusyOperation("analysis", false);

      expect(useKaiSession.getState().busyOperations).toEqual({});
      expect(useKaiSession.getState().isSearchDisabled).toBe(false);
    });
  });

  describe("clear", () => {
    it("resets state back to defaults", () => {
      useKaiSession
        .getState()
        .setAnalysisParams({ test: true } as never);

      useKaiSession.getState().setBusyOperation("analysis", true);

      useKaiSession.getState().clear();

      const state = useKaiSession.getState();

      expect(state.analysisParams).toBeNull();
      expect(state.analysisParamsUpdatedAt).toBeNull();
      expect(state.losersInput).toBeNull();
      expect(state.lastKaiPath).toBe(ROUTES.KAI_HOME);
      expect(state.busyOperations).toEqual({});
      expect(state.isSearchDisabled).toBe(false);
    });
  });
});