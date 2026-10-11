import { describe, expect, it } from "vitest";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import {
  answerRequestId,
  answerRequestSelection,
  isAnswerRequestEntry,
  isAnswerRequestSelection,
} from "@/lib/consent/answer-request-consent";
import type { FeedItem } from "@/lib/services/feed-service";

const REQUEST = "11111111-2222-3333-4444-555555555555";

const item = (event_type: string): FeedItem =>
  ({
    id: 1,
    user_id: "u",
    source_domain: "consent",
    event_type,
    actor_label: null,
    metadata: { lane: "answer_request", request_id: REQUEST },
    source_row_id: `answer_request:${REQUEST}`,
    read_at: null,
    created_at: "2026-10-10T00:00:00.000Z",
  }) as unknown as FeedItem;

describe("paid-answer rows reach the card that owns the decision", () => {
  it.each([
    ["answer_request_received", "pending"],
    ["answer_request_payment_ready", "pending"],
    ["answer_delivered", "pending"],
    ["answer_request_declined", "previous"],
  ])("%s links into the Consent Center (%s)", (event, tab) => {
    const presented = presentFeedItem(item(event));
    expect(presented.href).toContain(tab);
    // The href carries the answer-request selection, so the Consent Center
    // opens the answer card rather than the generic approve/deny path.
    expect(presented.href).toContain(encodeURIComponent(`answer_request:${REQUEST}`));
    expect(presented.label).toBeTruthy();
    expect(presented.description).toBeTruthy();
  });

  it("tells the requester the price step and the owner the review step", () => {
    expect(presentFeedItem(item("answer_request_received")).description).toContain("set a price");
    expect(presentFeedItem(item("answer_request_payment_ready")).description).toContain("Pay");
    expect(presentFeedItem(item("answer_request_declined")).description).toContain(
      "refunded in full",
    );
  });

  it("carries no question, scope or answer text into the Feed row", () => {
    // feed_events.metadata is server-readable; the row must stay coarse.
    const presented = presentFeedItem(item("answer_delivered"));
    const rendered = JSON.stringify(presented);
    expect(rendered).not.toContain("attr.");
    expect(rendered).not.toMatch(/spend|travel|passport/i);
  });
});

describe("answer-request selection helpers fail closed", () => {
  it("round-trips a well-formed id", () => {
    const selection = answerRequestSelection(REQUEST);
    expect(isAnswerRequestSelection(selection)).toBe(true);
    expect(answerRequestId(selection)).toBe(REQUEST);
  });

  it.each([
    ["a non-uuid", "answer_request:not-a-uuid"],
    ["an empty id", "answer_request:"],
    ["a different lane", "drive_query_request:11111111-2222-3333-4444-555555555555"],
    ["nothing", null],
  ])("refuses %s", (_label, selection) => {
    expect(answerRequestId(selection)).toBeNull();
  });

  it("recognises an entry by source, action or id prefix", () => {
    expect(
      isAnswerRequestEntry({ id: "x", action: "ANSWER_REQUEST_REVIEW", metadata: {} }),
    ).toBe(true);
    expect(
      isAnswerRequestEntry({ id: "x", action: "OTHER", metadata: { request_source: "answer_request" } }),
    ).toBe(true);
    expect(isAnswerRequestEntry({ id: `answer_request:${REQUEST}`, action: "OTHER", metadata: {} })).toBe(
      true,
    );
    expect(isAnswerRequestEntry({ id: "other", action: "OTHER", metadata: {} })).toBe(false);
  });
});
