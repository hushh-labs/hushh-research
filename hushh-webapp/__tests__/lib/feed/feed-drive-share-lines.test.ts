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
  it.each([
    [recipient, "Files ready · Already had access · No charge"],
    [{}, "Files delivered · No payment due"],
  ])("renders the current no-charge receipt for its audience (%j)", (audience, description) => {
    expect(presentFeedItem(item("document_share_outcome", {
      ...audience, current_existing_access_nocharge: true,
    })).description).toBe(description);
  });

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
    ).toBe("Check sharing and search results");
    expect(
      presentFeedItem(
        item("document_share_outcome", { user_facing_status: "partial" }),
      ).description,
    ).toBe("Check sharing and search results");
  });

  it.each([{}, recipient])("uses confirmed receipts for partial requests (%j)", audience => {
    const line = (counts: Record<string, unknown>) => presentFeedItem(item(
      "document_share_outcome", {
        ...audience, user_facing_status: "partial",
        current_delivery_total_count: 20,
        current_delivery_confirmed_count: 20,
        current_delivery_pending_count: 0,
        ...counts,
      },
    )).description;
    expect(line({})).toBe("Files shared; request incomplete");
    expect(line({ current_delivery_confirmed_count: 19 }))
      .toBe("Some selected files could not be shared");
    expect(line({ current_delivery_confirmed_count: 19, current_delivery_pending_count: 1 }))
      .toBe("Sharing is still being checked");
    expect(line({ current_delivery_confirmed_count: 21 }))
      .toBe("Check sharing and search results");
    expect(line({ current_delivery_pending_count: undefined }))
      .toBe("Check sharing and search results");
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
    ).toBe("No file candidates in this search; nothing was shared");
  });

  it("announces consent without claiming pre-payment sharing, and a decline", () => {
    expect(
      presentFeedItem(
        item("document_share_decided", {
          ...recipient,
          user_facing_status: "approved",
        }),
      ).description,
    ).toBe("Approved your document request");
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
    expect(presentFeedItem(item("document_share_request_sent", recipient)).description).toBe(
      "Request sent",
    );
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
    expect(ready.description).toBe("Payment due for your document request");
    expect(ready.href).toBe("/one/feed");
    expect(JSON.stringify(ready)).not.toContain("private.pdf");
    expect(presentFeedItem(item("document_share_payment_confirmed")).description)
      .toBe("Payment confirmed for your document request");
    const refunded = presentFeedItem(item("document_share_payment_refunded"));
    expect(refunded.description).toBe("Payment refunded for your document request");
    expect(refunded.href).toBe("/one/feed");
  });

  it("renders current payment state instead of an obsolete Pay instruction", () => {
    expect(presentFeedItem(item("document_share_payment_ready", {
      current_payment_status: "paid",
    })).description).toBe("Payment confirmed");
    expect(presentFeedItem(item("document_share_payment_ready", {
      current_payment_status: "refunded",
    })).description).toBe("Payment refunded");
    expect(presentFeedItem(item("document_share_payment_ready", {
      current_payment_status: "checkout_open",
      current_checkout_expired: true,
    })).description).toBe("Payment link expired");
    expect(presentFeedItem(item("document_share_payment_ready", {
      current_payment_status: "checkout_open",
      current_request_expired: true,
    })).description).toBe("Document request expired");
    expect(presentFeedItem(item("document_share_payment_ready", {
      current_payment_status: "unavailable",
    })).description).toBe("Check document request");
    expect(presentFeedItem(item("document_share_payment_ready", {
      current_payment_status: "checkout_open",
      current_owner_payout_account_ready: false,
    })).description).toBe("Waiting for owner payout setup");
    expect(presentFeedItem(item("document_share_payment_ready", {
      current_payment_status: "checkout_open",
      current_owner_payout_account_ready: true,
    })).description).toBe("Payment due for your document request");
  });

  it("reads the shared payment view state before the older payment fields", () => {
    const line = (metadata: Record<string, unknown>) =>
      presentFeedItem(item("document_share_payment_ready", metadata)).description;
    // The order is paid, but the money is going back: never "Payment confirmed".
    expect(line({ current_payment_state: "refund_pending", current_payment_status: "paid" }))
      .toBe("Refund pending");
    expect(line({ current_payment_state: "closed", current_payment_status: "expired" }))
      .toBe("Document request closed");
    expect(line({ current_payment_state: "link_expired" })).toBe("Payment link expired");
    expect(line({ current_payment_state: "request_expired" })).toBe("Document request expired");
    // Payable still honours the live deadline the row carries.
    expect(line({
      current_payment_state: "payable",
      current_payment_status: "checkout_open",
      current_checkout_expires_at: "2026-09-25T15:00:00.000Z",
    })).toBe("Payment link expired");
    expect(line({ current_payment_state: "payable", current_payment_status: "checkout_open" }))
      .toBe("Payment due for your document request");
  });

  it("never confirms a payment that goes back after the request closed", () => {
    const line = (metadata: Record<string, unknown>) =>
      presentFeedItem(item("document_share_payment_confirmed", metadata)).description;
    expect(line({})).toBe("Payment confirmed for your document request");
    expect(line({
      current_payment_state: "refund_pending",
      current_request_status: "cancelled",
      current_refund_amount_cents: 2500,
    })).toBe("Payment received after you withdrew · Refund of $25 pending");
    expect(line({
      current_payment_state: "refunded",
      current_request_status: "declined",
      current_refund_amount_cents: 2500,
    })).toBe("Payment received after the request closed · Refunded $25");
  });

  it("tells the owner the requester asked for a review of unshared files", () => {
    const row = presentFeedItem(item("document_share_review_requested"));
    expect(row.description).toBe("Asked you to review unshared files");
    expect(row.label).toBe("Ankit");
    expect(row.domainLabel).toBe("Google Drive");
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
