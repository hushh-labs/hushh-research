import { describe, expect, it } from "vitest";

import {
  buildDebateFeedAnalysisHref,
  classifyDebateFeedState,
  isActiveSmsEmergencyGrant,
  isIncomingLocationRequestActionable,
  isSmsEmergencyGrant,
} from "@/lib/feed/use-feed-actionables";
import type { DebateRunTask } from "@/lib/services/debate-run-manager";
import type {
  OneLocationAccessRequest,
  OneLocationGrant,
} from "@/lib/one-location/types";

const ME = "user-me";
const CONTACT = "user-contact";

function request(
  overrides: Partial<OneLocationAccessRequest>,
): OneLocationAccessRequest {
  return {
    id: "req-1",
    ownerUserId: CONTACT,
    requesterUserId: ME,
    status: "pending",
    ...overrides,
  };
}

describe("isIncomingLocationRequestActionable", () => {
  it("does NOT surface a request the viewer sent (outgoing) — the reported self-card bug", () => {
    // Viewer asked to see CONTACT's location: owner=contact, requester=me.
    expect(
      isIncomingLocationRequestActionable(
        request({ ownerUserId: CONTACT, requesterUserId: ME }),
        ME,
      ),
    ).toBe(false);
  });

  it("surfaces a genuine incoming request the viewer owns", () => {
    expect(
      isIncomingLocationRequestActionable(
        request({ ownerUserId: ME, requesterUserId: CONTACT }),
        ME,
      ),
    ).toBe(true);
  });

  it("does NOT surface a self-request where sender equals recipient", () => {
    expect(
      isIncomingLocationRequestActionable(
        request({ ownerUserId: ME, requesterUserId: ME }),
        ME,
      ),
    ).toBe(false);
  });

  it("does NOT surface a non-pending incoming request", () => {
    expect(
      isIncomingLocationRequestActionable(
        request({
          ownerUserId: ME,
          requesterUserId: CONTACT,
          status: "approved",
        }),
        ME,
      ),
    ).toBe(false);
  });

  it("does NOT surface a pending request owned by someone else", () => {
    expect(
      isIncomingLocationRequestActionable(
        request({ ownerUserId: "user-other", requesterUserId: CONTACT }),
        ME,
      ),
    ).toBe(false);
  });
});

function grant(overrides: Partial<OneLocationGrant>): OneLocationGrant {
  return {
    id: "grant-1",
    ownerUserId: CONTACT,
    recipientUserId: ME,
    recipientKeyId: "key-1",
    status: "active",
    consentScope: "cap.location.live",
    capabilityScopes: ["cap.location.live"],
    durationHours: 1,
    shareKind: "sos",
    ...overrides,
  };
}

describe("isActiveSmsEmergencyGrant", () => {
  it("surfaces a live SOS share as an emergency alert", () => {
    expect(isActiveSmsEmergencyGrant(grant({ shareKind: "sos" }))).toBe(true);
  });

  it("does NOT surface a plain (non-SOS) share", () => {
    expect(isActiveSmsEmergencyGrant(grant({ shareKind: "share" }))).toBe(false);
  });

  it("does NOT surface a friendly check-in", () => {
    expect(isActiveSmsEmergencyGrant(grant({ shareKind: "check_in" }))).toBe(
      false,
    );
  });

  it("does NOT surface an expired or revoked SOS share", () => {
    expect(
      isActiveSmsEmergencyGrant(grant({ shareKind: "sos", status: "expired" })),
    ).toBe(false);
    expect(
      isActiveSmsEmergencyGrant(grant({ shareKind: "sos", status: "revoked" })),
    ).toBe(false);
  });
});

describe("isSmsEmergencyGrant", () => {
  it("surfaces an SOS share regardless of status, so a revoke stays visible", () => {
    expect(isSmsEmergencyGrant(grant({ shareKind: "sos", status: "active" }))).toBe(
      true,
    );
    expect(isSmsEmergencyGrant(grant({ shareKind: "sos", status: "revoked" }))).toBe(
      true,
    );
    expect(isSmsEmergencyGrant(grant({ shareKind: "sos", status: "expired" }))).toBe(
      true,
    );
  });

  it("does NOT surface a non-SOS share", () => {
    expect(isSmsEmergencyGrant(grant({ shareKind: "share" }))).toBe(false);
    expect(isSmsEmergencyGrant(grant({ shareKind: "check_in" }))).toBe(false);
  });
});

function debateTask(
  overrides: Partial<DebateRunTask> = {},
): DebateRunTask {
  return {
    runId: "run-1",
    userId: ME,
    debateSessionId: "session-1",
    ticker: "AAPL",
    status: "running",
    startedAt: "2026-08-31T00:00:00Z",
    completedAt: null,
    updatedAt: "2026-08-31T00:00:00Z",
    latestCursor: 0,
    streamState: "connected",
    streamMessage: null,
    persistenceState: "none",
    persistenceError: null,
    dismissedAt: null,
    finalDecision: null,
    ...overrides,
  };
}

describe("classifyDebateFeedState", () => {
  it("retains a completed analysis as ready until it is dismissed", () => {
    expect(
      classifyDebateFeedState(
        debateTask({ status: "completed", persistenceState: "saved" }),
      ),
    ).toBe("ready");
    expect(
      classifyDebateFeedState(
        debateTask({
          status: "completed",
          persistenceState: "saved",
          dismissedAt: "2026-08-31T01:00:00Z",
        }),
      ),
    ).toBeNull();
  });

  it("keeps running and failed-save states actionable", () => {
    expect(classifyDebateFeedState(debateTask())).toBe("running");
    expect(
      classifyDebateFeedState(
        debateTask({ status: "completed", persistenceState: "failed" }),
      ),
    ).toBe("failed_save");
  });

  it("keeps raw persistence diagnostics out of the retained task", () => {
    const task = debateTask({
      status: "completed",
      persistenceState: "failed",
      persistenceError: "Analysis is ready, but could not be saved to history.",
    });

    expect(task.persistenceError).toBe(
      "Analysis is ready, but could not be saved to history.",
    );
    expect(task.persistenceError).not.toContain("422");
    expect(task.persistenceError).not.toContain("json_paths");
  });
});

describe("buildDebateFeedAnalysisHref", () => {
  it("opens a settled run through its durable history identity", () => {
    const href = buildDebateFeedAnalysisHref("run-1", true);
    const url = new URL(href, "https://example.test");

    expect(url.searchParams.get("tab")).toBe("analysis");
    expect(url.searchParams.get("analysis_id")).toBe("run:run-1");
    expect(url.searchParams.has("run_id")).toBe(false);
    expect(url.searchParams.has("focus")).toBe(false);
  });

  it("keeps an active run on the resumable stream route", () => {
    const href = buildDebateFeedAnalysisHref("run-2", false);
    const url = new URL(href, "https://example.test");

    expect(url.searchParams.get("focus")).toBe("active");
    expect(url.searchParams.get("run_id")).toBe("run-2");
  });
});
