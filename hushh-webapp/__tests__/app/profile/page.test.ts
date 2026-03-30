import { describe, expect, it } from "vitest";

import { resolveGmailSyncFeedback } from "@/lib/profile/mail-flow";

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
      })
    ).toEqual({
      kind: "message",
      message: "Gmail sync is still running. Check back in a moment.",
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
      })
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
      })
    ).toEqual({
      kind: "success",
      message: "Gmail receipts synced.",
    });
  });
});
