import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Kai analysis route layering contract", () => {
  it("uses replace for in-route ticker preview transitions", () => {
    const source = read("app/one/kai/analysis/page.tsx");

    expect(source).toContain("router.replace(\n        buildKaiAnalysisPreviewRoute");
    expect(source).not.toContain("router.push(\n        buildKaiAnalysisPreviewRoute");
  });
});
