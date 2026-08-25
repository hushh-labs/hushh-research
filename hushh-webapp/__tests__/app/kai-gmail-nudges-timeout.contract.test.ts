import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "app/api/kai/[...path]/route.ts"),
  "utf8",
);

describe("Gmail nudge proxy timeout", () => {
  it("keeps the non-blocking live inbox panel on its own timeout budget", () => {
    expect(source).toContain("const GMAIL_NUDGES_TIMEOUT_MS");
    expect(source).toContain('overrideEnvKey: "HUSHH_KAI_GMAIL_NUDGES_TIMEOUT_MS"');
    expect(source).toContain('path.startsWith("gmail/nudges/")');
    expect(source).toContain("return GMAIL_NUDGES_TIMEOUT_MS");
  });
});
