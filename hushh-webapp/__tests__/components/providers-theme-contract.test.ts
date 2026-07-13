import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Providers theme contract", () => {
  it("never forces a theme on any platform (iOS daylight pin removed)", () => {
    const source = read("app/layout.tsx");

    // The earlier "daylight" ship pinned iOS to light via forcedTheme +
    // Info.plist UIUserInterfaceStyle=Light. Both pins are removed: the theme
    // toggle must work identically on web and native iOS.
    expect(source).not.toContain("forcedTheme");
    expect(source).not.toContain("forceNativeDaylight");
    expect(source).toContain('attribute="class"');
    expect(source).toContain("enableSystem");
  });

  it("keeps Info.plist free of a UIUserInterfaceStyle pin", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).not.toContain("UIUserInterfaceStyle");
  });
});
