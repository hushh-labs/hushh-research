import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

describe("Light mode surface depth contract", () => {
  it("keeps grouped surfaces flat in light and dark mode", () => {
    const globals = fs.readFileSync(path.join(WEBAPP_ROOT, "app/globals.css"), "utf8");

    expect(globals).toContain("--app-card-shadow-standard: none;");
    expect(globals).not.toContain(
      "--app-card-shadow-standard: 0 10px 28px 0 rgba(120, 120, 128, 0.14);",
    );
  });

  it("preserves shared app card surface token stability", () => {
    const globals = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/globals.css"),
      "utf8"
    );

    expect(globals).toContain("--app-card-radius-compact: 16px;");
    expect(globals).toContain("--app-card-radius-standard: 18px;");
    expect(globals).toContain("--app-card-radius-feature: 20px;");
    expect(globals).toContain("--app-card-surface-default-solid:");
    expect(globals).toContain("--app-card-border-standard:");
  });
});
