import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Profile canonical page layout", () => {
  it("uses the shared signed-in shell without route-local header spacing", () => {
    const source = readFileSync(
      join(process.cwd(), "app/profile/profile-workspace-page.tsx"),
      "utf8",
    );

    expect(source).toContain("<AppPageShell");
    expect(source).toContain('width="reading"');
    expect(source).toContain("<AppPageHeaderRegion>");
    expect(source).not.toContain("profilePageHeaderRegion");
  });
});
