import { describe, expect, it } from "vitest";

import {
  requestRecipientStatus,
  shortAgo,
  shortRemaining,
} from "@/lib/one-location/request-recipient-status";
import type {
  OneLocationAccessRequest,
  OneLocationGrant,
} from "@/lib/one-location/types";

/**
 * What a person's row says in "ask someone to share".
 *
 * Every row used to read "Ready for private sharing" with Select as the only
 * affordance -- so "what is active status?" had no answer, and somebody who
 * had just asked Roopmann for an hour came back to a row offering to ask
 * again, exactly as if they never had.
 */

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const ROOPMANN = "user_roopmann";

function request(
  overrides: Partial<OneLocationAccessRequest>,
): OneLocationAccessRequest {
  return {
    id: "req_1",
    ownerUserId: ROOPMANN,
    requesterUserId: "user_me",
    status: "pending",
    requestedAt: new Date(NOW - 6 * 60_000).toISOString(),
    ...overrides,
  } as OneLocationAccessRequest;
}

function grant(overrides: Partial<OneLocationGrant>): OneLocationGrant {
  return {
    id: "grant_1",
    ownerUserId: ROOPMANN,
    status: "active",
    expiresAt: new Date(NOW + 55 * 60_000).toISOString(),
    ...overrides,
  } as OneLocationGrant;
}

function statusFor(input: {
  requestedByMe?: OneLocationAccessRequest[];
  receivedGrants?: OneLocationGrant[];
}) {
  return requestRecipientStatus({
    recipientUserId: ROOPMANN,
    requestedByMe: input.requestedByMe ?? [],
    receivedGrants: input.receivedGrants ?? [],
    nowMs: NOW,
  });
}

describe("someone with nothing between you yet", () => {
  it("is the only row that offers to ask", () => {
    const status = statusFor({});
    expect(status.subtitle).toBe("Ready for private sharing");
    expect(status.selectable).toBe(true);
  });
});

describe("someone you already asked", () => {
  it("says when, and stops offering to ask again", () => {
    // The reported bug: going back to the same screen re-offered a person who
    // already had an unanswered request.
    const status = statusFor({ requestedByMe: [request({})] });
    expect(status.subtitle).toBe("Asked 6m ago, waiting on them");
    expect(status.statusLabel).toBe("Asked");
    expect(status.selectable).toBe(false);
  });

  it("reports the most recent ask when there are several", () => {
    const status = statusFor({
      requestedByMe: [
        request({ id: "old", requestedAt: new Date(NOW - 5 * 3_600_000).toISOString() }),
        request({ id: "new", requestedAt: new Date(NOW - 60_000).toISOString() }),
      ],
    });
    expect(status.subtitle).toBe("Asked 1m ago, waiting on them");
  });

  it("hands the row the request to take back", () => {
    // Reported from QA: two people asked, both rows reading "Asked", and no
    // way off either one. The row cannot offer a take-back without knowing
    // WHICH request it would be taking back.
    const status = statusFor({ requestedByMe: [request({ id: "req_live" })] });
    expect(status.pendingRequestId).toBe("req_live");
  });

  it("offers the take-back for the ask it is reporting", () => {
    // The subtitle names the newest ask; a take-back wired to the older one
    // would end a request the row is not talking about and leave the visible
    // one standing.
    const status = statusFor({
      requestedByMe: [
        request({ id: "old", requestedAt: new Date(NOW - 5 * 3_600_000).toISOString() }),
        request({ id: "new", requestedAt: new Date(NOW - 60_000).toISOString() }),
      ],
    });
    expect(status.pendingRequestId).toBe("new");
  });
});

describe("someone already sharing with you", () => {
  it("says so, with how long is left, and is not askable", () => {
    // Asking somebody to share while they already are is the clearest possible
    // sign the list is not looking at anything.
    const status = statusFor({ receivedGrants: [grant({})] });
    expect(status.subtitle).toBe("Sharing with you, 55 more min");
    expect(status.statusLabel).toBe("Live");
    expect(status.selectable).toBe(false);
  });

  it("outranks a pending request to the same person", () => {
    const status = statusFor({
      requestedByMe: [request({})],
      receivedGrants: [grant({})],
    });
    expect(status.statusLabel).toBe("Live");
  });

  it("ignores a grant that is no longer active", () => {
    const status = statusFor({ receivedGrants: [grant({ status: "revoked" })] });
    expect(status.subtitle).toBe("Ready for private sharing");
    expect(status.selectable).toBe(true);
  });
});

describe("someone who said no", () => {
  it("says so plainly and stays askable", () => {
    // A refusal is not permanent. Hiding it is how somebody nags without
    // meaning to; blocking on it would be worse.
    const status = statusFor({
      requestedByMe: [
        request({
          status: "denied",
          resolvedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
        }),
      ],
    });
    expect(status.subtitle).toBe("Declined 2h ago");
    expect(status.selectable).toBe(true);
  });
});

describe("relative labels", () => {
  it("stays coarse enough not to tick", () => {
    expect(shortAgo(NOW - 30_000, NOW)).toBe("just now");
    expect(shortAgo(NOW - 6 * 60_000, NOW)).toBe("6m ago");
    expect(shortAgo(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(shortAgo(NOW - 50 * 3_600_000, NOW)).toBe("2d ago");
  });

  it("never reports remaining time on access that already ended", () => {
    expect(shortRemaining(NOW - 1, NOW)).toBeNull();
    expect(shortRemaining(NOW + 55 * 60_000, NOW)).toBe("55 more min");
    expect(shortRemaining(NOW + 60 * 60_000, NOW)).toBe("1 more hour");
    expect(shortRemaining(NOW + 3 * 3_600_000, NOW)).toBe("3 more hours");
  });
});
