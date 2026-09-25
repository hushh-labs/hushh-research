import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * Drive sharing and Drive questions reach the Feed (migration 246).
 *
 * Their only delivery used to be a push, so anyone without a registered
 * device -- every web browser that never granted permission -- learned
 * nothing. Each row names the other person, says what happened from this
 * person's side, and opens the same review a push opens. It never names a
 * file or the question.
 */

const REQUEST = "11111111-2222-4333-8444-555555555555";

function item(
  event_type: string,
  metadata: Record<string, unknown> = {},
): FeedItem {
  return {
    id: "feed_1",
    source_domain: "connected_systems",
    event_type,
    actor_label: null,
    metadata: { request_id: REQUEST, counterpart_label: "Ankit", ...metadata },
    read: false,
    created_at: "2026-09-25T15:50:00.000Z",
  };
}

const recipient = { feed_audience: "recipient" };

describe("Drive rows in the Feed", () => {
  it("tells the recipient who shared files with them", () => {
    const row = presentFeedItem(
      item("document_share_outcome", {
        ...recipient,
        user_facing_status: "completed",
      }),
    );
    expect(row.label).toBe("Ankit");
    expect(row.person?.displayName).toBe("Ankit");
    expect(row.description).toBe("Shared Drive files with you");
    expect(row.domainLabel).toBe("Google Drive");
    expect(row.href).toContain(
      encodeURIComponent(`document_share_request:${REQUEST}`),
    );
  });

  it("says when only some files were shared", () => {
    expect(
      presentFeedItem(
        item("document_share_outcome", {
          ...recipient,
          user_facing_status: "partial",
        }),
      ).description,
    ).toBe("Shared some Drive files with you");
  });

  it("announces an approved share before it finishes, and a decline", () => {
    expect(
      presentFeedItem(
        item("document_share_decided", {
          ...recipient,
          user_facing_status: "approved",
        }),
      ).description,
    ).toBe("Is sharing Drive files with you");
    expect(
      presentFeedItem(
        item("document_share_decided", {
          ...recipient,
          user_facing_status: "declined",
        }),
      ).description,
    ).toBe("Declined your file request");
  });

  it("tells the owner about a request, and about their finished share", () => {
    expect(presentFeedItem(item("document_share_request")).description).toBe(
      "Asked for files from your Drive",
    );
    expect(
      presentFeedItem(
        item("document_share_outcome", { user_facing_status: "completed" }),
      ).description,
    ).toBe("Now has your shared files");
  });

  it("opens the Drive question card for question rows", () => {
    const question = presentFeedItem(item("document_share_question"));
    expect(question.description).toBe("Asked a question about your Drive");
    expect(question.href).toContain(
      encodeURIComponent(`drive_query_request:${REQUEST}`),
    );
    expect(
      presentFeedItem(item("document_share_answered", recipient)).description,
    ).toBe("Answered your Drive question");
    expect(
      presentFeedItem(item("document_share_declined", recipient)).description,
    ).toBe("Declined your Drive question");
  });

  it("falls back to Google Drive when the person has no name", () => {
    const row = presentFeedItem(
      item("document_share_outcome", {
        ...recipient,
        counterpart_label: undefined,
      }),
    );
    expect(row.label).toBe("Google Drive");
    expect(row.person).toBeNull();
  });

  it("never routes on a malformed request id", () => {
    const row = presentFeedItem(
      item("document_share_request", { request_id: "../../evil" }),
    );
    expect(row.href).not.toContain("evil");
  });
});
