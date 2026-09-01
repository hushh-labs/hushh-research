import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");

describe("/one layout cache policy", () => {
  it("keeps signed-in One routes out of static HTML caching", () => {
    const source = readFileSync(
      path.join(repoRoot, "app", "one", "layout.tsx"),
      "utf8",
    );

    expect(source).toContain('export const dynamic = "force-dynamic"');
    expect(source).toContain("export const revalidate = 0");
  });
});
