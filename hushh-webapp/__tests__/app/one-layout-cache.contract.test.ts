import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");

describe("/one layout cache policy", () => {
  it("requires a live web request without breaking Capacitor static export", () => {
    const source = readFileSync(
      path.join(repoRoot, "app", "one", "layout.tsx"),
      "utf8",
    );

    expect(source).toContain('import { connection } from "next/server"');
    expect(source).toContain('process.env.CAPACITOR_BUILD !== "true"');
    expect(source).toContain("await connection()");
    expect(source).not.toContain('dynamic = "force-dynamic"');
    expect(source).not.toContain("revalidate = 0");
  });
});
