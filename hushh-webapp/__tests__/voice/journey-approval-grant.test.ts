import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearJourneyApproval,
  isCoveredByJourneyApproval,
  readJourneyApprovalForTest,
  recordJourneyApproval,
} from "@/lib/voice/journey-approval-grant";

afterEach(() => {
  clearJourneyApproval("test_teardown");
  vi.useRealTimers();
});

/**
 * The approval must outlive the navigation it exists to span. Held in a
 * component ref it did not: a ref survives re-renders but not a remount, and
 * it vanished silently -- nothing called the clear path, so there was not even
 * a log to explain why the second step asked again.
 */
describe("journey approval grant", () => {
  it("covers the steps it named, under the goal it named", () => {
    recordJourneyApproval("goal.analysis.start_debate", [
      "route.kai_analysis",
      "analysis.start",
    ]);

    expect(
      isCoveredByJourneyApproval("goal.analysis.start_debate", "analysis.start"),
    ).toBe(true);
  });

  it("does not cover a step outside the approved list", () => {
    recordJourneyApproval("goal.analysis.start_debate", ["route.kai_analysis"]);

    // analysis.start was not in the plan's batchable set, so it still asks.
    expect(
      isCoveredByJourneyApproval("goal.analysis.start_debate", "analysis.start"),
    ).toBe(false);
  });

  it("does not cover a different goal", () => {
    recordJourneyApproval("goal.analysis.start_debate", ["analysis.start"]);

    expect(isCoveredByJourneyApproval("goal.something.else", "analysis.start")).toBe(
      false,
    );
  });

  it("covers nothing when no approval is held", () => {
    expect(
      isCoveredByJourneyApproval("goal.analysis.start_debate", "analysis.start"),
    ).toBe(false);
  });

  it("expires, and clears itself when it does", () => {
    vi.useFakeTimers();
    recordJourneyApproval("goal.analysis.start_debate", ["analysis.start"]);

    vi.advanceTimersByTime(120_001);

    expect(
      isCoveredByJourneyApproval("goal.analysis.start_debate", "analysis.start"),
    ).toBe(false);
    // An expired grant is dropped rather than lingering as dead state.
    expect(readJourneyApprovalForTest()).toBeNull();
  });

  it("ends on an explicit invalidation", () => {
    recordJourneyApproval("goal.analysis.start_debate", ["analysis.start"]);

    clearJourneyApproval("new_user_intent");

    expect(readJourneyApprovalForTest()).toBeNull();
  });

  it("refuses to record an approval that names nothing", () => {
    recordJourneyApproval("goal.analysis.start_debate", []);
    expect(readJourneyApprovalForTest()).toBeNull();

    recordJourneyApproval("", ["analysis.start"]);
    expect(readJourneyApprovalForTest()).toBeNull();
  });
});
