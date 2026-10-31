import { describe, expect, it } from "vitest";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import {
  answerRequestId,
  answerRequestSelection,
  isAnswerRequestEntry,
  isAnswerRequestSelection,
} from "@/lib/consent/answer-request-consent";
import { consentSelectionId } from "@/lib/consent/consent-selection-id";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
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
    expect(presentFeedItem(item("answer_request_payment_ready")).description).toContain("preparation");
    const staged = item("answer_request_payment_ready");
    staged.metadata = { ...staged.metadata, status: "staged" };
    expect(presentFeedItem(staged).description).toContain("price and pay");
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

describe("a Consent Center row keeps its lane in the URL", () => {
  // Exactly what PkmAnswerCenterContributor emits: the lane lives in `id`,
  // while `request_id` is the bare uuid shared with the generic consent path.
  const answerRow = (role: "owner" | "requester") =>
    ({
      id: `answer_request:${REQUEST}`,
      request_id: REQUEST,
      kind: role === "owner" ? "incoming_request" : "outgoing_request",
      status: role === "owner" ? "awaiting_owner" : "approved",
      action: "ANSWER_REQUEST_REVIEW",
      scope: null,
      counterpart_type: "person",
      counterpart_id: role === "owner" ? "requester-uid" : "owner-uid",
      counterpart_label: role === "owner" ? "The requester" : "The owner",
      issued_at: 1,
      metadata: {
        request_source: "answer_request",
        role,
        direction: role === "owner" ? "incoming" : "outgoing",
        request_status: role === "owner" ? "awaiting_owner" : "approved",
      },
    }) as unknown as ConsentCenterEntry;

  it.each(["owner", "requester"] as const)(
    "sends the %s to the answer card, not the generic approve path",
    (role) => {
      const selected = consentSelectionId(answerRow(role));
      // Dropping the prefix to `request_id` left the detail panel unable to
      // tell the lane apart once the row was not in the loaded list, and the
      // request fell through to the approve/deny path -- which grants the
      // scopes without showing the question, its scopes or the price.
      expect(selected).toBe(`answer_request:${REQUEST}`);
      expect(isAnswerRequestSelection(selected)).toBe(true);
      expect(answerRequestId(selected)).toBe(REQUEST);
    },
  );

  it.each([
    ["Received", "incoming_request", "awaiting_owner"],
    ["Sent", "outgoing_request", "approved"],
    ["Previous", "history", "answered"],
  ] as const)(
    "keeps the typed id for a row shown on the %s tab",
    (_tab, kind, status) => {
      // The row moves bucket as the request progresses -- the owner's row
      // leaves "Received" once it is approved. Each tab has its own select
      // handler, and a tab that dropped the prefix would reopen the request
      // through the generic approve/deny path.
      const row = {
        ...answerRow("owner"),
        kind,
        status,
        metadata: { ...answerRow("owner").metadata, request_status: status },
      } as unknown as ConsentCenterEntry;
      expect(consentSelectionId(row)).toBe(`answer_request:${REQUEST}`);
      expect(answerRequestId(consentSelectionId(row))).toBe(REQUEST);
    },
  );

  it.each([REQUEST, "not-a-uuid"])(
    "keeps a recognized answer row in its own lane when its prefix is missing: %s",
    (id) => {
      const selected = consentSelectionId({ ...answerRow("owner"), id, request_id: id });
      expect(isAnswerRequestSelection(selected)).toBe(true);
      expect(answerRequestId(selected)).toBe(id === REQUEST ? REQUEST : null);
    },
  );

  it("still routes the Drive lanes and the generic lane unchanged", () => {
    // Negative control: the fix must not broaden recognition. A bare
    // `request_id` remains correct for the generic consent path, and both
    // Drive lanes keep deciding by their own discriminated id.
    const driveQuery = {
      id: `drive_query_request:${REQUEST}`,
      request_id: REQUEST,
      action: "DRIVE_QUERY_REVIEW",
      metadata: { request_source: "drive_live_query_request" },
    } as unknown as ConsentCenterEntry;
    const documentShare = {
      id: `document_share_request:${REQUEST}`,
      request_id: REQUEST,
      action: "DOCUMENT_SHARE_REVIEW",
      metadata: { request_source: "drive_document_share_request" },
    } as unknown as ConsentCenterEntry;
    const genericConsent = {
      id: "consent-row-1",
      request_id: REQUEST,
      action: "CONSENT_REVIEW",
      metadata: {},
    } as unknown as ConsentCenterEntry;

    expect(consentSelectionId(driveQuery)).toBe(`drive_query_request:${REQUEST}`);
    expect(consentSelectionId(documentShare)).toBe(`document_share_request:${REQUEST}`);
    expect(consentSelectionId(genericConsent)).toBe(REQUEST);
    expect(isAnswerRequestSelection(consentSelectionId(documentShare))).toBe(false);
  });
});
