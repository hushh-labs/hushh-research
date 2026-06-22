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
      "android/app/src/main/java/com/hushh/app/plugins/Kai/KaiPlugin.kt"
    );

    expect(apiService).toContain("run_id: data.runId");
    expect(apiService).toContain("resume_cursor: data.resumeCursor ?? 0");
    expect(apiService).toContain("await Kai.streamKaiAnalysis({");

    expect(iosPlugin).toContain("body[\"run_id\"]");
    expect(iosPlugin).toContain("/api/kai/analyze/run/");
    expect(iosPlugin).toContain("runRequest.httpMethod = \"GET\"");
    expect(iosPlugin).toContain("text/event-stream");
    expect(iosPlugin).toContain("/api/kai/analyze/stream");

    expect(androidPlugin).toContain("bodyObj.optString(\"run_id\"");
    expect(androidPlugin).toContain("/api/kai/analyze/run/");
    expect(androidPlugin).toContain(".get()");
    expect(androidPlugin).toContain("text/event-stream");
    expect(androidPlugin).toContain("/api/kai/analyze/stream");
  });
});
