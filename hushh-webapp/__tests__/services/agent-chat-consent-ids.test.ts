import { describe, expect, it } from "vitest";

describe("parsePendingConsentRequestIds", () => {
  it("reads request ids only from the pending-requests tool and dedupes them", async () => {
    const { parsePendingConsentRequestIds } = await import("@/lib/services/agent-chat-client");
    const content = JSON.stringify({
      status: "ok",
      pendingRequestIds: ["req_1", "req_1", " req_2 ", ""],
      pendingRequests: [{ requestId: "req_1", requesterLabel: "Alex" }],
    });
    expect(parsePendingConsentRequestIds("list_pending_information_requests", content)).toEqual([
      "req_1",
      "req_2",
    ]);
    expect(parsePendingConsentRequestIds("discover_person_information", content)).toEqual([]);
    expect(
      parsePendingConsentRequestIds(
        "list_pending_information_requests",
        JSON.stringify({ status: "failed", pendingRequestIds: ["req_1"] }),
      ),
    ).toEqual([]);
    expect(parsePendingConsentRequestIds("list_pending_information_requests", "not json")).toEqual([]);
  });
});
