import { describe, it, expect } from "vitest";
import {
  GMAIL_RECEIPTS_API_TEMPLATES,
  SUPPORT_API_TEMPLATES,
} from "@/lib/services/kai-profile-api-paths";

describe("GMAIL_RECEIPTS_API_TEMPLATES", () => {
  it("exposes exactly the documented keys", () => {
    expect(Object.keys(GMAIL_RECEIPTS_API_TEMPLATES).sort()).toEqual(
      [
        "connectStart",
        "connectComplete",
        "status",
        "disconnect",
        "reconcile",
        "sync",
        "syncRun",
        "receipts",
        "receiptsMemoryPreview",
        "receiptsMemoryArtifact",
      ].sort()
    );
  });

  it("has the exact string values", () => {
    expect(GMAIL_RECEIPTS_API_TEMPLATES.connectStart).toBe(
      "/api/kai/gmail/connect/start"
    );
    expect(GMAIL_RECEIPTS_API_TEMPLATES.connectComplete).toBe(
      "/api/kai/gmail/connect/complete"
    );
    expect(GMAIL_RECEIPTS_API_TEMPLATES.status).toBe(
      "/api/kai/gmail/status/{user_id}"
    );
    expect(GMAIL_RECEIPTS_API_TEMPLATES.disconnect).toBe(
      "/api/kai/gmail/disconnect"
    );
    expect(GMAIL_RECEIPTS_API_TEMPLATES.reconcile).toBe(
      "/api/kai/gmail/reconcile"
    );
    expect(GMAIL_RECEIPTS_API_TEMPLATES.sync).toBe("/api/kai/gmail/sync");
    expect(GMAIL_RECEIPTS_API_TEMPLATES.syncRun).toBe(
      "/api/kai/gmail/sync/{run_id}"
    );
    expect(GMAIL_RECEIPTS_API_TEMPLATES.receipts).toBe(
      "/api/kai/gmail/receipts/{user_id}"
    );
    expect(GMAIL_RECEIPTS_API_TEMPLATES.receiptsMemoryPreview).toBe(
      "/api/kai/gmail/receipts-memory/preview"
    );
    expect(GMAIL_RECEIPTS_API_TEMPLATES.receiptsMemoryArtifact).toBe(
      "/api/kai/gmail/receipts-memory/artifacts/{artifact_id}"
    );
  });

  it("every template value starts with /api/kai/gmail/", () => {
    Object.values(GMAIL_RECEIPTS_API_TEMPLATES).forEach((value) => {
      expect(value.startsWith("/api/kai/gmail/")).toBe(true);
    });
  });
});

describe("SUPPORT_API_TEMPLATES", () => {
  it("exposes exactly the documented keys", () => {
    expect(Object.keys(SUPPORT_API_TEMPLATES)).toEqual(["message"]);
  });

  it("has the exact string value for message", () => {
    expect(SUPPORT_API_TEMPLATES.message).toBe("/api/kai/support/message");
  });

  it("every template value starts with /api/kai/", () => {
    Object.values(SUPPORT_API_TEMPLATES).forEach((value) => {
      expect(value.startsWith("/api/kai/")).toBe(true);
    });
  });
});