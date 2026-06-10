import { describe, expect, it } from "vitest";

import {
  isPageFilePath,
  routeFromRelativePageFile,
  toForwardSlash,
} from "../../scripts/architecture/audit-cache-coherence.mjs";

describe("audit-cache-coherence Windows path support", () => {
  it("normalizes Windows separators before matching page files", () => {
    expect(toForwardSlash(String.raw`C:\repo\app\profile\page.tsx`)).toBe(
      "C:/repo/app/profile/page.tsx"
    );
    expect(isPageFilePath(String.raw`C:\repo\app\profile\page.tsx`)).toBe(true);
    expect(isPageFilePath(String.raw`C:\repo\app\profile\layout.tsx`)).toBe(false);
  });

  it("derives routes from Windows-style relative page paths", () => {
    expect(routeFromRelativePageFile("page.tsx")).toBe("/");
    expect(routeFromRelativePageFile(String.raw`profile\page.tsx`)).toBe("/profile");
    expect(routeFromRelativePageFile(String.raw`profile\receipts\page.tsx`)).toBe(
      "/profile/receipts"
    );
  });
});
