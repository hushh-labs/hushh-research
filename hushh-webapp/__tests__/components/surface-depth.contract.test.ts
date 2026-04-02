import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

describe("Light mode surface depth contract", () => {
  it("keeps a visible mobile light-mode card shadow for iCloud surfaces", () => {
    const globals = fs.readFileSync(path.join(WEBAPP_ROOT, "app/globals.css"), "utf8");

    expect(globals).toContain("--app-card-shadow-standard: 0 10px 28px 0 rgba(120, 120, 128, 0.14);");
    expect(globals).toContain("--shadow-md: 0 8px 22px 0 rgba(120, 120, 128, 0.16);");
  });
});
