import { describe, expect, it } from "vitest";

import { isIncomingLocationRequestActionable } from "@/lib/feed/use-feed-actionables";
import type { OneLocationAccessRequest } from "@/lib/one-location/types";

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
