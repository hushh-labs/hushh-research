import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Providers theme contract", () => {
  it("does not force light theme on web while preserving iOS daylight mode", () => {
    const source = read("app/providers.tsx");

    expect(source).toContain("const forceNativeDaylight");
    expect(source).toContain("Capacitor.isNativePlatform() && Capacitor.getPlatform() === \"ios\"");
    expect(source).toContain('forcedTheme={forceNativeDaylight ? "light" : undefined}');
    expect(source).toContain("enableSystem={!forceNativeDaylight}");
    expect(source).not.toContain('forcedTheme="light"');
  });
});
