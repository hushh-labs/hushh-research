import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

describe("Feed sticky section-label contract", () => {
  it("pins day labels below the live top-chrome boundary", () => {
    const feedPage = fs.readFileSync(
      path.join(WEBAPP_ROOT, "components/feed/feed-page.tsx"),
      "utf8",
    );
    const styles = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/globals.css"),
      "utf8",
    );

    expect(feedPage).toContain("sticky top-[var(--top-shell-live-height)]");
    expect(feedPage).not.toContain("sticky top-0");
    expect(styles).toContain("--top-shell-live-height");
    expect(styles).toContain("var(--top-chrome-collapse-px, 0px)");
  });
});
