import { describe, expect, it } from "vitest";

import {
  buildGmailStatusPath,
  buildGmailSyncRunPath,
  buildGmailReceiptsPath,
  buildGmailReceiptMemoryArtifactPath,
} from "@/lib/services/kai-profile-api-paths";

describe("buildGmailStatusPath", () => {
  it("substitutes plain user ids", () => {
    expect(
      buildGmailStatusPath("user-123"),
    ).toBe("/api/kai/gmail/status/user-123");
  });

  it("encodes special characters", () => {
    expect(
      buildGmailStatusPath("user@domain.com"),
    ).toBe("/api/kai/gmail/status/user%40domain.com");
  });

  it("trims surrounding whitespace", () => {
    expect(
      buildGmailStatusPath("  user-123  "),
    ).toBe("/api/kai/gmail/status/user-123");
  });

  it("supports empty values", () => {
    expect(
      buildGmailStatusPath(""),
    ).toBe("/api/kai/gmail/status/");
  });
});

describe("buildGmailSyncRunPath", () => {
  it("substitutes plain run ids", () => {
    expect(
      buildGmailSyncRunPath("run-abc"),
    ).toBe("/api/kai/gmail/sync/run-abc");
  });

  it("encodes spaces", () => {
    expect(
      buildGmailSyncRunPath("run 1"),
    ).toBe("/api/kai/gmail/sync/run%201");
  });

  it("supports empty values", () => {
    expect(
      buildGmailSyncRunPath(""),
    ).toBe("/api/kai/gmail/sync/");
  });
});

describe("buildGmailReceiptsPath", () => {
  it("substitutes plain user ids", () => {
    expect(
      buildGmailReceiptsPath("user-456"),
    ).toBe("/api/kai/gmail/receipts/user-456");
  });

  it("encodes forward slashes", () => {
    expect(
      buildGmailReceiptsPath("org/user"),
    ).toBe("/api/kai/gmail/receipts/org%2Fuser");
  });

  it("trims surrounding whitespace", () => {
    expect(
      buildGmailReceiptsPath("  user-456  "),
    ).toBe("/api/kai/gmail/receipts/user-456");
  });
});

describe("buildGmailReceiptMemoryArtifactPath", () => {
  it("substitutes plain artifact ids", () => {
    expect(
      buildGmailReceiptMemoryArtifactPath("artifact-789"),
    ).toBe(
      "/api/kai/gmail/receipts-memory/artifacts/artifact-789",
    );
  });

  it("encodes spaces", () => {
    expect(
      buildGmailReceiptMemoryArtifactPath("art id"),
    ).toBe(
      "/api/kai/gmail/receipts-memory/artifacts/art%20id",
    );
  });

  it("supports empty values", () => {
    expect(
      buildGmailReceiptMemoryArtifactPath(""),
    ).toBe(
      "/api/kai/gmail/receipts-memory/artifacts/",
    );
  });
});