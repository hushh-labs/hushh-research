/**
 * An upgrade is a software update at login, and the app has to be able to see it.
 *
 * The hub now says what the pod runs and what it wants (`runningImage`, `targetImage`,
 * `updateAvailable`, `updateInProgress`, `updateFailed`, `updateVerified`), tri-state like `hostReady`.
 * These tests pin how the app reads that and how the poll behaves while the build is
 * moving: a settled pod normally stops polling, and an update in flight must not.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: vi.fn() },
}));

import {
  DEPLOYMENT_POLL_INTERVAL_MS,
  UPDATE_POLL_INTERVAL_MS,
  decideFollow,
} from "@/lib/feed/deployment-progress-policy";
import {
  NO_UPDATE,
  readUpdateStatus,
} from "@/lib/feed/use-agent-deployment-follow";
import { updateActivityLabel, updateProgressStage } from "@/lib/feed/agent-update-status";

describe("readUpdateStatus", () => {
  it("keeps absent as unknown, never as false", () => {
    expect(readUpdateStatus({})).toEqual(NO_UPDATE);
    expect(readUpdateStatus(null).available).toBeNull();
  });

  it("reads a pod behind the target as an available update", () => {
    const update = readUpdateStatus({
      runningImage: "dev-aaaaaaaaa",
      targetImage: "dev-bbbbbbbbb",
      updateAvailable: true,
    });
    expect(update).toEqual({
      available: true,
      offerable: false,
      inProgress: false,
      failed: false,
      error: null,
      running: "dev-aaaaaaaaa",
      target: "dev-bbbbbbbbb",
      releaseId: null,
      summary: null,
      presentationState: null,
      phase: null,
      remindAt: null,
      operationId: null,
      verified: false,
    });
  });

  it("requires explicit server eligibility before offering an install", () => {
    expect(readUpdateStatus({ updateAvailable: true }).offerable).toBe(false);
    expect(
      readUpdateStatus({ updateAvailable: true, updateOfferable: false })
        .offerable,
    ).toBe(false);
    expect(
      readUpdateStatus({ updateAvailable: true, updateOfferable: true })
        .offerable,
    ).toBe(true);
  });

  it("only treats a matching running target as verified completion", () => {
    expect(
      readUpdateStatus({
        runningImage: "dev-bbbbbbbbb",
        targetImage: "dev-bbbbbbbbb",
        updateAvailable: false,
        updateVerified: true,
      }).verified,
    ).toBe(true);
    expect(readUpdateStatus({ updateAvailable: false }).verified).toBe(false);
  });

  it("carries the failure reason the hub chose to show", () => {
    const update = readUpdateStatus({
      updateAvailable: true,
      updateFailed: true,
      updateError: "copy refused (403)",
    });
    expect(update.failed).toBe(true);
    expect(update.error).toBe("copy refused (403)");
  });

  it("shows only observed update milestones and requires digest verification for completion", () => {
    for (const [phase, label, stage] of [
      ["preparing", "Finishing current work", 1],
      ["installing", "Installing update", 2],
      ["verifying", "Restarting and verifying", 3],
    ] as const) {
      const update = readUpdateStatus({ updateInProgress: true, update: { phase } });
      expect(updateActivityLabel(update)).toBe(label);
      expect(updateProgressStage(update)).toBe(stage);
      expect(update.verified).toBe(false);
    }
    expect(updateProgressStage(readUpdateStatus({ updateInProgress: false, update: { phase: "verifying" } }))).toBe(3);
    expect(updateProgressStage(readUpdateStatus({ update: { phase: "verified", presentationState: "verified" } }))).toBeNull();
    expect(updateProgressStage(readUpdateStatus({
      updateVerified: true, update: { phase: "verified", presentationState: "verified" },
    }))).toBe(4);
  });
});

describe("decideFollow while an update moves", () => {
  it("keeps polling a settled pod, slowly, while its build is moving", () => {
    const decision = decideFollow({
      state: "active",
      previousState: "active",
      elapsedMs: 0,
      updateMoving: true,
    });
    expect(decision.follow).toBe(true);
    expect(decision.reason).toBe("update_moving");
    expect(decision.intervalMs).toBe(UPDATE_POLL_INTERVAL_MS);
    expect(UPDATE_POLL_INTERVAL_MS).toBeGreaterThan(
      DEPLOYMENT_POLL_INTERVAL_MS,
    );
  });

  it("still stops on a settled pod when nothing is moving", () => {
    const decision = decideFollow({
      state: "active",
      previousState: "active",
      elapsedMs: 0,
      updateMoving: false,
    });
    expect(decision.follow).toBe(false);
  });

  it("does not let an update flag override a deployment that is not live", () => {
    const decision = decideFollow({
      state: "failed",
      previousState: "failed",
      elapsedMs: 0,
      updateMoving: true,
    });
    expect(decision.follow).toBe(false);
  });
});
