import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptSource = fs.readFileSync(
  path.join(process.cwd(), "scripts/architecture/audit-cache-coherence.mjs"),
  "utf8"
);

describe("audit-cache-coherence Windows path support", () => {
  it("keeps the real cache-coherence audit entrypoint passing", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/architecture/audit-cache-coherence.mjs", "--check"],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(output).toContain("Cache coherence manifest is current");
  });

  it("normalizes separators before matching page files", () => {
    expect(scriptSource).toContain('filePath.replaceAll("\\\\", "/").endsWith("/page.tsx")');
  });

  it("normalizes relative page paths before deriving routes", () => {
    expect(scriptSource).toContain(
      'path.relative(path.join(appRoot, "app"), filePath).replaceAll("\\\\", "/")'
    );
  });
});
