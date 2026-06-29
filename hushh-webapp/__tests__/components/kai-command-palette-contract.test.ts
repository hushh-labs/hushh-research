import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Kai command palette contract", () => {
  it("keeps the search tab free of voice controls", () => {
    const source = read("components/kai/kai-command-palette.tsx");

    expect(source).not.toContain("Start Kai voice");
    expect(source).not.toContain("End Kai voice");
    expect(source).not.toContain("<Mic");
    expect(source).toContain('aria-label="Close command search"');
    expect(source).toContain('className="pr-14"');
  });
});
