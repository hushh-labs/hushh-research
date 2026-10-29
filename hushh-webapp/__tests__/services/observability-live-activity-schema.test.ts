import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateAndSanitizeEvent } from "@/lib/observability/schema";

const EVENT_MATRIX = path.resolve(__dirname, "../../../docs/reference/operations/observability-event-matrix.md");

/**
 * Background consolidation of the device activity log reports one closed-set
 * outcome. Nothing that could name a statement, a fact or the owner may pass.
 */
describe("live activity consolidation contract", () => {
  const valid = { env: "uat", platform: "web", event_category: "system", app_version: "2.1.0", outcome: "host_skipped", saved_bucket: "0" } as const;

  it("keeps only the closed outcome and saved band, and never a statement, fact or owner", () => {
    const result = validateAndSanitizeEvent("live_activity_consolidation_completed", {
      ...valid, statement: "On 29 Oct 2026 I connected Gmail.", owner_user_id: "UWHGeUyfUAbmEl5xwIPoWJ7Cyft2",
    } as any);
    expect(result.fatal).toBe(false);
    expect(result.sanitized).toEqual(valid);
    for (const leak of [{ outcome: "Error: connection refused" }, { saved_bucket: 3 }, { saved_bucket: undefined }]) {
      expect(validateAndSanitizeEvent("live_activity_consolidation_completed", { ...valid, ...leak } as any).fatal).toBe(true);
    }
  });

  it("is listed in the event matrix with both params", () => {
    const row = readFileSync(EVENT_MATRIX, "utf8").split("\n")
      .find((line) => line.startsWith("| `live_activity_consolidation_completed` |"));
    expect(row).toContain("`outcome`");
    expect(row).toContain("`saved_bucket`");
  });
});
