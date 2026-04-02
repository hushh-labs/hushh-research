import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Top app bar responsive contract", () => {
  it("keeps the persona pill affordances visible on mobile and tablet", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("TOP_SHELL_TITLE_PILL_CLASSNAME");
    expect(source).not.toContain("hidden shrink-0 text-current sm:inline-flex");
    expect(source).not.toContain("hidden h-1.5 w-1.5 shrink-0 rounded-full sm:inline-block");
    expect(source).not.toContain("hidden h-4 w-4 shrink-0 text-current/70 transition-colors group-hover:text-current sm:inline-block");
    expect(source).toContain('className="shrink-0 text-current"');
    expect(source).toContain('className="h-4 w-4 shrink-0 text-current/70 transition-colors group-hover:text-current"');
  });
});
