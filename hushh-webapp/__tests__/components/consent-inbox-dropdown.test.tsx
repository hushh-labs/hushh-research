import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs
    .readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

describe("ConsentInboxDropdown", () => {
  it("covers pending consents list semantics", async () => {
    const { ConsentInboxDropdown } = await import(
      "@/components/consent/consent-inbox-dropdown"
    );
    const source = read("components/consent/consent-inbox-dropdown.tsx");

    expect(ConsentInboxDropdown).toEqual(expect.any(Function));
    expect(source).toContain("items.length > 0");
    expect(source).toContain('role="list"');
    expect(source).toContain('aria-label="Pending consents"');
    expect(source).toContain('role="listitem"');
    expect(source).toContain("items.map((entry) =>");
  });
});
