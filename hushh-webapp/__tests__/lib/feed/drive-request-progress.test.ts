import { describe, expect, it } from "vitest";

import { projectFeedDriveProgress } from "@/lib/feed/drive-request-progress";
import { projectFeedDrivePayments } from "@/lib/feed/drive-request-payment";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

const requestId = "document_share_request:123e4567-e89b-12d3-a456-426614174000";

function entry(overrides: Partial<ConsentCenterEntry> = {}): ConsentCenterEntry {
  return {
    id: requestId,
    kind: "incoming_request",
    status: "pending",
    action: "read",
    counterpart_type: "person",
    issued_at: "2026-09-29T10:00:00Z",
    metadata: {
      request_source: "drive_document_share_request",
      direction: "incoming",
      automatic_progress_active: true,
      automatic_progress_stage: "finding",
    },
    ...overrides,
  };
}

describe("projectFeedDriveProgress", () => {
  it("shows a received automatic request without exposing unconfirmed file details", () => {
    const rows = projectFeedDriveProgress([entry({ metadata: {
      ...entry().metadata,
      file_names: ["unconfirmed.pdf"],
      candidate_count: 7,
    } })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("One is finding documents");
    expect(rows[0]?.href).toContain("requestId=document_share_request");
    expect(rows[0]?.href).not.toContain("requestView=sent");
    expect(JSON.stringify(rows)).not.toMatch(/unconfirmed\.pdf|candidate_count|7 files/i);
  });

  it("routes sent pending requests through the sent view", () => {
    const rows = projectFeedDriveProgress([entry({
      kind: "outgoing_request",
      metadata: { ...entry().metadata, direction: "outgoing", automatic_progress_stage: "preparing" },
    })]);

    expect(rows[0]?.href).toContain("requestView=sent");
    expect(rows[0]?.description).toContain("your Trusted Circle request");
  });

  it("keeps one row after a confirmed grant and opens the active detail", () => {
    const pending = entry();
    const active = entry({ kind: "active_grant", status: "active", metadata: {
      ...entry().metadata,
      automatic_progress_stage: "sharing",
    } });
    const rows = projectFeedDriveProgress([pending, active]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("One is sharing documents");
    expect(rows[0]?.href).toContain("tab=active");
  });

  it("ignores inactive, nonparticipant, malformed and settled entries", () => {
    const rows = projectFeedDriveProgress([
      entry({ metadata: { ...entry().metadata, automatic_progress_active: false } }),
      entry({ metadata: { ...entry().metadata, direction: "unknown" } }),
      entry({ id: "document_share_request:bad-id" }),
      entry({ status: "denied" }),
      entry({ kind: "history", status: "active" }),
    ]);
    expect(rows).toEqual([]);
  });

  it("moves only the requester payment into Needs you, with no sharing progress claim", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "awaiting_payment",
      paymentAmountCents: 1000, paymentCurrency: "usd", file_names: ["private.pdf"],
    } });
    expect(projectFeedDriveProgress([payment])).toEqual([]);
    const rows = projectFeedDrivePayments([payment]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toContain("Pay $10");
    expect(JSON.stringify(rows)).not.toContain("private.pdf");
    expect(projectFeedDrivePayments([entry({ metadata: payment.metadata })])).toEqual([]);
    expect(projectFeedDrivePayments([entry({ kind: "outgoing_request", metadata: {
      ...payment.metadata, paymentStatus: "paid",
    } })])).toEqual([]);
  });

  it("keeps an abandoned Checkout actionable without claiming sharing progress", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "checkout_open",
      paymentAmountCents: 1000, paymentCurrency: "usd",
    } });
    expect(projectFeedDrivePayments([payment])).toHaveLength(1);
    expect(projectFeedDriveProgress([payment])).toEqual([]);
  });

  it("does not claim sharing progress during paid payment reconciliation", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "paid",
      paymentReconciliationRequired: true,
    } });
    expect(projectFeedDriveProgress([payment])).toEqual([]);
  });
});
