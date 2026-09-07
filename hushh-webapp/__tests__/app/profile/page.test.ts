import { describe, expect, it } from "vitest";

import {
  describeGmailReceiptScanProgress,
  resolveGmailConnectionPresentation,
  resolveGmailLastUpdatedLabel,
  resolveGmailStatusSummary,
  resolveGmailSyncFeedback,
  sanitizeGmailUserMessage,
} from "@/lib/profile/mail-flow";

describe("resolveGmailSyncFeedback", () => {
  it("keeps non-terminal sync states out of the success path", () => {
    expect(
      resolveGmailSyncFeedback({
        configured: true,
        connected: true,
        status: "connected",
        scope_csv: "gmail.readonly",
        last_sync_status: "running",
        auto_sync_enabled: true,
        revoked: false,
        latest_run: {
          run_id: "run-1",
          user_id: "user-123",
          trigger_source: "manual",
          status: "running",
          listed_count: 4,
          filtered_count: 2,
          synced_count: 1,
          extracted_count: 1,
          duplicates_dropped: 0,
          extraction_success_rate: 1,
        },
      }),
    ).toEqual({
      kind: "message",
      message: "We're still syncing your receipts.",
    });
  });

  it("keeps failed sync states on the error path", () => {
    expect(
      resolveGmailSyncFeedback({
        configured: true,
        connected: true,
        status: "connected",
        scope_csv: "gmail.readonly",
        last_sync_status: "failed",
        last_sync_error: "Mailbox locked.",
        auto_sync_enabled: true,
        revoked: false,
      }),
    ).toEqual({
      kind: "error",
      message: "Mailbox locked.",
    });
  });

  it("uses success only for completed sync states", () => {
    expect(
      resolveGmailSyncFeedback({
        configured: true,
        connected: true,
        status: "connected",
        scope_csv: "gmail.readonly",
        last_sync_status: "completed",
        auto_sync_enabled: true,
        revoked: false,
      }),
    ).toEqual({
      kind: "success",
      message: "Receipts updated.",
    });
  });
});

describe("resolveGmailConnectionPresentation", () => {
  it("uses an explicit loading state before connector status resolves", () => {
    expect(
      resolveGmailConnectionPresentation({
        status: null,
        loading: true,
        errorText: null,
      }),
    ).toMatchObject({
      state: "loading",
      badgeLabel: "Checking",
      isConnected: false,
    });
  });

  it("surfaces sync failures as needs-attention while staying connected", () => {
    expect(
      resolveGmailConnectionPresentation({
        status: {
          configured: true,
          connected: true,
          status: "connected",
          google_email: "dev@hushh.ai",
          scope_csv: "gmail.readonly",
          last_sync_status: "failed",
          last_sync_error: "Mailbox locked.",
          auto_sync_enabled: true,
          revoked: false,
        },
      }),
    ).toMatchObject({
      state: "sync_failed",
      badgeLabel: "Try again",
      isConnected: true,
    });
  });

  it("treats fetch errors as needs-attention instead of disconnected", () => {
    expect(
      resolveGmailConnectionPresentation({
        status: null,
        loading: false,
        errorText: "Failed to load Gmail connector state.",
      }),
    ).toMatchObject({
      state: "sync_failed",
      badgeLabel: "Try again",
      isConnected: false,
    });
  });

  it("keeps passive backfill in the connected background state instead of blocking sync", () => {
    expect(
      resolveGmailConnectionPresentation({
        status: {
          configured: true,
          connected: true,
          status: "connected",
          google_email: "dev@hushh.ai",
          scope_csv: "gmail.readonly",
          last_sync_status: "running",
          auto_sync_enabled: true,
          revoked: false,
          sync_state: "backfill_running",
          latest_run: {
            run_id: "run-backfill",
            user_id: "user-1",
            trigger_source: "backfill",
            sync_mode: "backfill",
            status: "running",
            listed_count: 1,
            filtered_count: 1,
            synced_count: 1,
            extracted_count: 1,
            duplicates_dropped: 0,
            extraction_success_rate: 1,
          },
        },
      }),
    ).toMatchObject({
      state: "connected_backfill_running",
      badgeLabel: "Connected",
      isConnected: true,
    });
  });

  it("does not keep completed backfill runs in the background running state", () => {
    expect(
      resolveGmailConnectionPresentation({
        status: {
          configured: true,
          connected: true,
          status: "connected",
          google_email: "dev@hushh.ai",
          scope_csv: "gmail.readonly",
          last_sync_status: "completed",
          auto_sync_enabled: true,
          revoked: false,
          sync_state: "backfill_running",
          latest_run: {
            run_id: "run-backfill-complete",
            user_id: "user-1",
            trigger_source: "backfill",
            sync_mode: "backfill",
            status: "completed",
            listed_count: 4,
            filtered_count: 3,
            synced_count: 3,
            extracted_count: 3,
            duplicates_dropped: 0,
            extraction_success_rate: 1,
          },
        },
      }),
    ).toMatchObject({
      state: "connected",
      badgeLabel: "Connected",
      latestSyncBadge: "completed",
      isConnected: true,
    });
  });
});

describe("sanitizeGmailUserMessage", () => {
  it("hides raw backend error details", () => {
    expect(
      sanitizeGmailUserMessage(
        "DB operation failed [<raw_sql>.execute_raw]: (psycopg2.OperationalError) server closed the connection unexpectedly",
        {
          fallback:
            "Something went wrong while syncing your emails. Please try again in a moment.",
        },
      ),
    ).toBe(
      "Something went wrong while syncing your emails. Please try again in a moment.",
    );
  });

  it("hides proxy timeout and connection errors", () => {
    expect(
      sanitizeGmailUserMessage("fetch failed: connection refused", {
        fallback:
          "Something went wrong while syncing your emails. Please try again in a moment.",
      }),
    ).toBe(
      "Something went wrong while syncing your emails. Please try again in a moment.",
    );
  });
});

describe("resolveGmailStatusSummary", () => {
  it("explains the purchase-signal benefit before Gmail is connected", () => {
    expect(resolveGmailStatusSummary({ status: null }).detail).toBe(
      "One syncs purchase receipts into a private shopping summary. You can separately turn on KYC-request monitoring after connecting.",
    );
  });

  it("does not repeat the call to action already carried by the title and button", () => {
    // The card states "Gmail not connected" above this line and offers a
    // "Connect Gmail" button below it, so a third "Connect Gmail to start."
    // in the body was the same instruction a third time.
    expect(resolveGmailStatusSummary({ status: null }).detail).not.toContain(
      "Connect Gmail to start.",
    );
  });

  it("uses only available scan counts when explaining receipt progress", () => {
    expect(describeGmailReceiptScanProgress({ scanned: 12, matched: 3 })).toBe(
      "12 emails checked. 3 receipts matched so far. Receipt-based purchase interactions help One understand the brands you care about.",
    );
  });

  it("returns a calm success summary for connected Gmail", () => {
    expect(
      resolveGmailStatusSummary({
        status: {
          configured: true,
          connected: true,
          status: "connected",
          google_email: "dev@hushh.ai",
          scope_csv: "gmail.readonly",
          last_sync_status: "completed",
          last_sync_at: "2026-04-03T10:00:00.000Z",
          auto_sync_enabled: true,
          revoked: false,
        },
      }),
    ).toMatchObject({
      tone: "success",
      title: "Receipts are up to date",
      detail: "Connected to dev@hushh.ai",
    });
  });

  it("keeps saved receipts healthy after an interrupted background worker", () => {
    expect(
      resolveGmailStatusSummary({
        status: {
          configured: true,
          connected: true,
          status: "connected",
          google_email: "dev@hushh.ai",
          scope_csv: "gmail.readonly",
          last_sync_status: "failed",
          last_sync_error:
            "Gmail sync worker stopped before reporting a final status.",
          last_sync_at: "2026-04-03T10:00:00.000Z",
          auto_sync_enabled: true,
          revoked: false,
          latest_run: {
            run_id: "run_interrupted",
            user_id: "user_123",
            trigger_source: "auto_reconcile",
            status: "failed",
            listed_count: 0,
            filtered_count: 0,
            synced_count: 0,
            extracted_count: 0,
            duplicates_dropped: 0,
            extraction_success_rate: 0,
            error_message:
              "Gmail sync worker stopped before reporting a final status.",
          },
        },
      }),
    ).toMatchObject({
      tone: "success",
      title: "Receipts are up to date",
    });
  });

  it("formats last updated labels directly from raw timestamps", () => {
    const label = resolveGmailLastUpdatedLabel({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "dev@hushh.ai",
      scope_csv: "gmail.readonly",
      last_sync_status: "completed",
      last_sync_at: new Date(Date.now() - 60_000).toISOString(),
      auto_sync_enabled: true,
      revoked: false,
    });

    expect(label).toMatch(/^Last updated /);
  });
});
