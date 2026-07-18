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
  describe("API template constants", () => {
    it("exports Gmail API templates", () => {
      expect(GMAIL_RECEIPTS_API_TEMPLATES.connectStart).toBe(
        "/api/kai/gmail/connect/start"
      );
      expect(GMAIL_RECEIPTS_API_TEMPLATES.sync).toBe(
        "/api/kai/gmail/sync"
      );
      expect(GMAIL_RECEIPTS_API_TEMPLATES.status).toContain("{user_id}");
      expect(GMAIL_RECEIPTS_API_TEMPLATES.syncRun).toContain("{run_id}");
    });

    it("exports support API templates", () => {
      expect(SUPPORT_API_TEMPLATES.message).toBe(
        "/api/kai/support/message"
      );
    });
  });

  describe("buildGmailStatusPath", () => {
    it("builds a status path", () => {
      expect(buildGmailStatusPath("user123")).toBe(
        "/api/kai/gmail/status/user123"
      );
    });

    it("trims whitespace", () => {
      expect(buildGmailStatusPath("  user123  ")).toBe(
        "/api/kai/gmail/status/user123"
      );
    });

    it("URL-encodes special characters", () => {
      expect(buildGmailStatusPath("john doe")).toBe(
        "/api/kai/gmail/status/john%20doe"
      );
    });
  });

  describe("buildGmailSyncRunPath", () => {
    it("builds a sync run path", () => {
      expect(buildGmailSyncRunPath("run123")).toBe(
        "/api/kai/gmail/sync/run123"
      );
    });

    it("encodes reserved characters", () => {
      expect(buildGmailSyncRunPath("run/123")).toBe(
        "/api/kai/gmail/sync/run%2F123"
      );
    });
  });

  describe("buildGmailReceiptsPath", () => {
    it("builds a receipts path", () => {
      expect(buildGmailReceiptsPath("user123")).toBe(
        "/api/kai/gmail/receipts/user123"
      );
    });

    it("encodes Unicode values", () => {
      expect(buildGmailReceiptsPath("测试")).toBe(
        `/api/kai/gmail/receipts/${encodeURIComponent("测试")}`
      );
    });
  });

  describe("buildGmailReceiptMemoryArtifactPath", () => {
    it("builds an artifact path", () => {
      expect(buildGmailReceiptMemoryArtifactPath("artifact1")).toBe(
        "/api/kai/gmail/receipts-memory/artifacts/artifact1"
      );
    });

    it("encodes special characters", () => {
      expect(
        buildGmailReceiptMemoryArtifactPath("artifact 123")
      ).toBe(
        "/api/kai/gmail/receipts-memory/artifacts/artifact%20123"
      );
    });
  });
});
