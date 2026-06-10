import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptSource = fs.readFileSync(
  path.join(process.cwd(), "scripts/architecture/audit-cache-coherence.mjs"),
  "utf8"
);

describe("audit-cache-coherence Windows path support", () => {
  it("normalizes separators before matching page files", () => {
    expect(scriptSource).toContain('return filePath.replaceAll("\\\\", "/");');
    expect(scriptSource).toContain('return toForwardSlash(filePath).endsWith("/page.tsx");');
  });

  it("normalizes relative page paths before deriving routes", () => {
    expect(scriptSource).toContain("function routeFromRelativePageFile(relativePath)");
    expect(scriptSource).toMatch(/toForwardSlash\(relativePath\)\.replace\(/);
  });

  it("keeps cache-coherence helpers private to the script", () => {
    expect(scriptSource).not.toMatch(
      /export function (toForwardSlash|isPageFilePath|routeFromRelativePageFile|routeFromPageFile)/
    );
  });
});
