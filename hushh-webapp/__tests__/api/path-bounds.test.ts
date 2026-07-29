import path from "node:path";
import { describe, expect, it } from "vitest";

import { isPathWithinBounds } from "../../app/api/_utils/path-bounds";

describe("isPathWithinBounds", () => {
  const baseDir = path.resolve("public", "assets");

  it("allows a valid subpath inside the authorized base directory", () => {
    const targetPath = path.join(baseDir, "images", "logo.png");

    expect(isPathWithinBounds(baseDir, targetPath)).toBe(true);
  });

  it("allows an exact base directory match", () => {
    expect(isPathWithinBounds(baseDir, baseDir)).toBe(true);
  });

  it("blocks relative breakout attempts that resolve outside the base directory", () => {
    const targetPath = path.join("..", "..", "etc", "passwd");

    expect(isPathWithinBounds(baseDir, targetPath)).toBe(false);
  });
});
