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
    expect(row.description).toBe("Drive sharing finished; check file results");
    expect(row.domainLabel).toBe("Google Drive");
    expect(row.href).toContain(
      encodeURIComponent(`document_share_request:${REQUEST}`),
    );
  });

  it("marks a partial Drive request incomplete for both people", () => {
    expect(
      presentFeedItem(
        item("document_share_outcome", {
          ...recipient,
          user_facing_status: "partial",
        }),
      ).description,
    ).toBe("Sharing finished with some files unavailable");
    expect(
      presentFeedItem(
        item("document_share_outcome", { user_facing_status: "partial" }),
      ).description,
    ).toBe("Could not share all selected files");
  });

  it("reports an empty Drive search without implying a permission failure", () => {
    expect(
      presentFeedItem(item("document_share_outcome", {
        ...recipient,
        user_facing_status: "no_files_shared",
      })).description,
    ).toBe("No files were shared");
    expect(
      presentFeedItem(item("document_share_outcome", {
        user_facing_status: "no_match",
      })).description,
    ).toBe("No matching files found; nothing was shared");
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
      "Document request received",
    );
    expect(
      presentFeedItem(
        item("document_share_outcome", { user_facing_status: "completed" }),
      ).description,
    ).toBe("Drive sharing finished; check file results");
    expect(presentFeedItem(item("document_share_review_ready")).description).toBe("Files ready for your review");
    expect(presentFeedItem(item("document_share_decided", {
      ...recipient, user_facing_status: "pending",
    })).description)
      .toBe("Files are available; more may arrive");
  });

  it("routes payment events to the live Feed without private file details", () => {
    const ready = presentFeedItem(item("document_share_payment_ready", {
      file_names: ["private.pdf"],
    }));
    expect(ready.description).toBe("Pay $10 to continue your document request");
    expect(ready.href).toBe("/one/feed");
    expect(JSON.stringify(ready)).not.toContain("private.pdf");
    expect(presentFeedItem(item("document_share_payment_confirmed")).description)
      .toBe("Payment confirmed for your document request");
    const refunded = presentFeedItem(item("document_share_payment_refunded"));
    expect(refunded.description).toBe("Payment refunded for your document request");
    expect(refunded.href).toBe("/one/feed");
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
