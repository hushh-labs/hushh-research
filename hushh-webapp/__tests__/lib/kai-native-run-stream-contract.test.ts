import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Kai native debate run stream contract", () => {
  it("keeps native run resume streams on the resumable run endpoint", () => {
    const apiService = read("lib/services/api-service.ts");
    const iosPlugin = read("ios/App/App/Plugins/KaiPlugin.swift");
    const androidPlugin = read(
      "android/app/src/main/java/com/hussh/app/plugins/Kai/KaiPlugin.kt",
    );

    expect(apiService).toContain("run_id: data.runId");
    expect(apiService).toContain("resume_cursor: data.resumeCursor ?? 0");
    expect(apiService).toContain("await Kai.streamKaiAnalysis({");
    expect(apiService).toContain("Kai.cancelKaiAnalysisStream()");
    expect(
      apiService.match(/handleNativeVaultOwnerStreamError\(/g)?.length,
    ).toBe(6); // helper declaration plus all five native SSE entry points
    expect(apiService).toContain("isValidatedAuthSessionOwnerCurrent");

    expect(iosPlugin).toContain('body["run_id"]');
    expect(iosPlugin).toContain("/api/kai/analyze/run/");
    expect(iosPlugin).toContain('runRequest.httpMethod = "GET"');
    expect(iosPlugin).toContain("text/event-stream");
    expect(iosPlugin).toContain("/api/kai/analyze/stream");
    expect(iosPlugin).toContain(
      'CAPPluginMethod(name: "cancelKaiAnalysisStream"',
    );
    expect(iosPlugin).toContain("KAI_STREAM_ATTACHMENT_CANCELLED");
    expect(iosPlugin).toContain('"AUTH_ACCOUNT_NOT_FOUND": 401');
    expect(iosPlugin).toContain('"AUTH_ACCOUNT_DELETION_IN_PROGRESS": 423');
    expect(iosPlugin).toContain('"AUTH_ACCOUNT_STATUS_UNAVAILABLE": 503');
    expect(iosPlugin).toContain('return "AUTH_VAULT_OWNER_INVALID"');
    expect(iosPlugin).toContain("maxStreamErrorBodyBytes = 16 * 1024");

    expect(androidPlugin).toContain('bodyObj.optString("run_id"');
    expect(androidPlugin).toContain("/api/kai/analyze/run/");
    expect(androidPlugin).toContain(".get()");
    expect(androidPlugin).toContain("text/event-stream");
    expect(androidPlugin).toContain("/api/kai/analyze/stream");
    expect(androidPlugin).toContain(
      "fun cancelKaiAnalysisStream(call: PluginCall)",
    );
    expect(androidPlugin).toContain("KAI_STREAM_BUSY");
    expect(androidPlugin).toContain('"AUTH_ACCOUNT_NOT_FOUND" to 401');
    expect(androidPlugin).toContain(
      '"AUTH_ACCOUNT_DELETION_IN_PROGRESS" to 423',
    );
    expect(androidPlugin).toContain('"AUTH_ACCOUNT_STATUS_UNAVAILABLE" to 503');
    expect(androidPlugin).toContain('return "AUTH_VAULT_OWNER_INVALID"');
    expect(androidPlugin).toContain("MAX_STREAM_ERROR_BODY_BYTES = 16 * 1024");
  });
});
