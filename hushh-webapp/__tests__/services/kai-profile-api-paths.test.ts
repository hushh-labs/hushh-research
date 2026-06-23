import { describe, expect, it } from "vitest";

import {
  GMAIL_RECEIPTS_API_TEMPLATES,
  SUPPORT_API_TEMPLATES,
  buildGmailReceiptMemoryArtifactPath,
  buildGmailReceiptsPath,
  buildGmailStatusPath,
  buildGmailSyncRunPath,
} from "@/lib/services/kai-profile-api-paths";

describe("kai-profile-api-paths", () => {
  it("exposes gmail receipts template contracts", () => {
    expect(GMAIL_RECEIPTS_API_TEMPLATES.status).toBe(
      "/api/kai/gmail/status/{user_id}",
    );

    expect(GMAIL_RECEIPTS_API_TEMPLATES.syncRun).toBe(
      "/api/kai/gmail/sync/{run_id}",
    );

    expect(GMAIL_RECEIPTS_API_TEMPLATES.receipts).toBe(
      "/api/kai/gmail/receipts/{user_id}",
    );
  });

  it("exposes support template contracts", () => {
    expect(SUPPORT_API_TEMPLATES.message).toBe(
      "/api/kai/support/message",
    );
  });

  it("builds gmail status paths", () => {
    expect(buildGmailStatusPath("user-123")).toBe(
      "/api/kai/gmail/status/user-123",
    );
  });

  it("builds gmail sync run paths", () => {
    expect(buildGmailSyncRunPath("run-456")).toBe(
      "/api/kai/gmail/sync/run-456",
    );
  });

  it("builds gmail receipts paths", () => {
    expect(buildGmailReceiptsPath("user-789")).toBe(
      "/api/kai/gmail/receipts/user-789",
    );
  });

  it("builds gmail receipt memory artifact paths", () => {
    expect(buildGmailReceiptMemoryArtifactPath("artifact-001")).toBe(
      "/api/kai/gmail/receipts-memory/artifacts/artifact-001",
    );
  });
});