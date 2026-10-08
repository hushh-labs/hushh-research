/**
 * An Azure update's outcome: the agent's own status is the authority on what
 * runs, and a failed job is a failure only when nothing changed.
 *
 * Live incident 2026-10-05 (dev): the replace succeeded, the job failed with
 * "upgrade provider did not return a live terminal outcome" because the new
 * revision was not ready yet, and the read-only recovery recorded the new
 * release about 40 seconds later. The app said "The update did not finish"
 * while the agent ran 2026.10-dev.7.
 */
import { describe, expect, it } from "vitest";

import {
  HUB_RECORDED_FAILURE,
  azureUpdateVerdict,
  azureUpdatedLabel,
  isUpdateJobRecord,
} from "@/lib/one/azure-update-outcome";

const APPROVED = "2026.10-dev.7";
const RUNNING = "2026.10-dev.6";
const INCIDENT_ERROR =
  "Something unexpected stopped the setup. Everything already created is kept; try again. (RuntimeError)";
/** `pod_update_presentation._blocked_update`: the hub kept the lease and recovery continues. */
const RECOVERING = {
  updateFailed: true,
  update: {
    summary: "The update outcome could not be verified. Check again while recovery continues.",
    presentationState: "blocked" as const,
    phase: "blocked" as const,
  },
};

function job(status: "running" | "recorded" | "failed", extra: Record<string, unknown> = {}) {
  return {
    status, stage: "deploying_agent", stages: [], projectId: "", jobId: "job-7",
    errorCode: null, errorMessage: status === "failed" ? INCIDENT_ERROR : null,
    stale: false, updatedAt: null, ...extra,
  };
}

function agent(installed: string, update: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    installedRelease: { version: installed },
    availableRelease: { version: APPROVED, summary: "", releasedAt: "2026-10-05T12:00:00Z", notes: { improvements: [], fixes: [], security: [] } },
    update: { summary: "", presentationState: "updating" as const, phase: "verifying" as const, ...update },
    ...extra,
  };
}

describe("an approved Azure update's outcome", () => {
  it("reads a failed job as updated once the agent reports the approved release installed", () => {
    expect(
      azureUpdateVerdict({ approvedVersion: APPROVED, status: agent(APPROVED), job: job("failed") }),
    ).toEqual({ kind: "updated", version: APPROVED });
  });

  it("keeps confirming, not failing, while the hub still reports the update in flight", () => {
    expect(
      azureUpdateVerdict({ approvedVersion: APPROVED, status: agent(RUNNING), job: job("failed") }),
    ).toEqual({ kind: "updating", confirming: true });
  });

  it.each([
    ["an unnamed failure", job("failed")],
    ["no verdict in time (UPGRADE_UNCONFIRMED)", job("failed", { errorCode: "UPGRADE_UNCONFIRMED" })],
    ["a skipped retry", job("failed", { errorCode: "UPGRADE_IN_PROGRESS" })],
    ["a restarted job", job("running", { stale: true })],
  ])("keeps confirming %s while the hub holds the update for recovery", (_label, record) => {
    expect(
      azureUpdateVerdict({ approvedVersion: APPROVED, status: { ...agent(RUNNING), ...RECOVERING }, job: record }),
    ).toEqual({ kind: "updating", confirming: true });
  });

  it("keeps confirming a failed job while the agent's status is unreadable", () => {
    expect(azureUpdateVerdict({ approvedVersion: APPROVED, status: null, job: job("failed") })).toEqual({
      kind: "updating",
      confirming: true,
    });
  });

  it.each(["UPGRADE_REVISION_FAILED", "UPGRADE_FAILED"])(
    "calls %s failed at once, even while the hub holds the update",
    (errorCode) => {
      const record = job("failed", { errorCode, errorMessage: "The new version did not start." });
      expect(
        azureUpdateVerdict({ approvedVersion: APPROVED, status: { ...agent(RUNNING), ...RECOVERING }, job: record }),
      ).toEqual({ kind: "failed", message: "The new version did not start." });
    },
  );

  it("calls an unconfirmed update failed once the hub settles without the release", () => {
    const record = job("failed", {
      errorCode: "UPGRADE_UNCONFIRMED",
      errorMessage: "We could not confirm the update yet. It is being checked; you do not need to do anything.",
    });
    expect(
      azureUpdateVerdict({
        approvedVersion: APPROVED,
        status: agent(RUNNING, { presentationState: "ready", phase: undefined }),
        job: record,
      }),
    ).toEqual({ kind: "failed", message: HUB_RECORDED_FAILURE });
  });

  it("calls a failed job failed at once when the approval never started", () => {
    expect(
      azureUpdateVerdict({
        approvedVersion: APPROVED,
        status: agent(RUNNING, { presentationState: "scheduled", phase: "scheduled" }),
        job: job("failed"),
      }),
    ).toEqual({ kind: "failed", message: INCIDENT_ERROR });
  });

  it("reads a failed job as updated once the hub verifies the update, whatever the version label", () => {
    expect(
      azureUpdateVerdict({
        approvedVersion: APPROVED,
        status: agent("sha-3a7bb679", { presentationState: "verified", phase: "verified" }),
        job: job("failed", { errorCode: "UPGRADE_UNCONFIRMED" }),
      }),
    ).toEqual({ kind: "updated", version: "sha-3a7bb679" });
  });

  it("treats a restarted (stale) job as stopped partway once the hub has settled", () => {
    const verdict = azureUpdateVerdict({
      approvedVersion: APPROVED,
      status: agent(RUNNING, { presentationState: "scheduled", phase: "scheduled" }),
      job: job("running", { stale: true }),
    });
    expect(verdict).toEqual({ kind: "failed", message: expect.stringMatching(/stopped partway/) });
  });

  it("keeps updating while the job runs", () => {
    expect(
      azureUpdateVerdict({ approvedVersion: APPROVED, status: agent(RUNNING), job: job("running") }),
    ).toEqual({ kind: "updating", confirming: false });
  });

  it("waits a read for the status after a finished job, unless the hub calls it verified", () => {
    expect(
      azureUpdateVerdict({ approvedVersion: APPROVED, status: agent(RUNNING), job: job("recorded") }),
    ).toEqual({ kind: "updating", confirming: false });
    expect(
      azureUpdateVerdict({
        approvedVersion: APPROVED,
        status: agent(RUNNING, { presentationState: "verified", phase: "verified" }),
        job: job("recorded"),
      }),
    ).toEqual({ kind: "updated", version: RUNNING });
    expect(
      azureUpdateVerdict({ approvedVersion: null, status: null, job: job("recorded") }),
    ).toEqual({ kind: "updated", version: null });
  });

  it("never claims updated without the approved release or a finished job", () => {
    expect(
      azureUpdateVerdict({ approvedVersion: null, status: agent(RUNNING), job: null }),
    ).toEqual({ kind: "updating", confirming: false });
  });

  it("only trusts a job record that names this update's job", () => {
    const record = job("failed");
    expect(isUpdateJobRecord(record, "job-7")).toBe(true);
    expect(isUpdateJobRecord(record, "job-1")).toBe(false);
    expect(isUpdateJobRecord(record, null)).toBe(false);
    expect(isUpdateJobRecord({ ...record, status: "none" }, "job-7")).toBe(false);
  });

  it("names the installed version the way the pane does", () => {
    expect(azureUpdatedLabel(APPROVED, "2026-10-05T12:00:00Z")).toBe("Updated to 05.10.26 · Dev 7");
    expect(azureUpdatedLabel(null, null)).toBe("Your agent is updated");
  });
});
