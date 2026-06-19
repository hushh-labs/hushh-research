import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("market preview surface contract", () => {
  it("does not render a body-level notification bell or mock notification sheet", () => {
    const source = read("components/kai/views/kai-market-preview-view.tsx");

    expect(source).not.toContain("OneMarketNotificationsSheet");
    expect(source).not.toContain('aria-label="Notifications"');
    expect(source).not.toContain("setNotificationsOpen");
    expect(source).not.toContain("<Bell");
  });
});
