import { describe, expect, it } from "vitest";

import {
  buildGmailReceiptMemoryArtifactPath,
  buildGmailReceiptsPath,
  buildGmailStatusPath,
  buildGmailSyncRunPath,
} from "@/lib/services/kai-profile-api-paths";

describe("kai-profile-api-paths", () => {
  it("builds gmail status path", () => {
    expect(buildGmailStatusPath("user123")).toBe(
      "/api/kai/gmail/status/user123"
    );
  });

  it("builds gmail sync run path", () => {
    expect(buildGmailSyncRunPath("run123")).toBe(
      "/api/kai/gmail/sync/run123"
    );
  });

  it("builds gmail receipts path", () => {
    expect(buildGmailReceiptsPath("user123")).toBe(
      "/api/kai/gmail/receipts/user123"
    );
  });

  it("builds gmail receipt memory artifact path", () => {
    expect(buildGmailReceiptMemoryArtifactPath("artifact123")).toBe(
      "/api/kai/gmail/receipts-memory/artifacts/artifact123"
    );
  });

  it("trims whitespace from parameters", () => {
    expect(buildGmailStatusPath("  user123  ")).toBe(
      "/api/kai/gmail/status/user123"
    );
  });

  it("url encodes path parameters", () => {
    expect(buildGmailReceiptsPath("user 123")).toBe(
      "/api/kai/gmail/receipts/user%20123"
    );
  });

  it("encodes special characters", () => {
    expect(buildGmailSyncRunPath("run/123")).toBe(
      "/api/kai/gmail/sync/run%2F123"
    );
  });

  it("handles empty values", () => {
    expect(buildGmailStatusPath("")).toBe(
      "/api/kai/gmail/status/"
    );
  });
});
