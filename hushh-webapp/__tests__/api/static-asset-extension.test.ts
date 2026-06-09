import { describe, expect, it } from "vitest";

import { isValidExtension } from "@/app/api/_utils/static-asset-extension";

describe("isValidExtension", () => {
  it("allows permitted static image extensions", () => {
    expect(isValidExtension("images/logo.png")).toBe(true);
    expect(isValidExtension("photos/hero.jpeg")).toBe(true);
  });

  it("treats extensions case-insensitively", () => {
    expect(isValidExtension("icons/APP.PNG")).toBe(true);
    expect(isValidExtension("manifest/ASSET.JSON")).toBe(true);
  });

  it("rejects paths with no extension", () => {
    expect(isValidExtension("assets/readme")).toBe(false);
    expect(isValidExtension(".env")).toBe(false);
  });

  it("rejects paths ending in a trailing slash", () => {
    expect(isValidExtension("assets/app.js/")).toBe(false);
    expect(isValidExtension("assets\\app.css\\")).toBe(false);
  });

  it("blocks unsafe executable and shell-script extensions", () => {
    expect(isValidExtension("downloads/setup.exe")).toBe(false);
    expect(isValidExtension("assets/.deploy.sh")).toBe(false);
  });
});
