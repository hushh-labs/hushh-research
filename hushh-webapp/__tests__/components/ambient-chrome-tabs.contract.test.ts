import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("tabbed ambient chrome contract", () => {
  it("keeps the top mask solid through the tab stack before dissolving", () => {
    const topShell = read("components/app-ui/top-app-bar.tsx");
    const styles = read("app/globals.css");
    const providers = read("app/providers.tsx");

    expect(topShell).toContain("ambient-chrome-mask--top-with-tabs");
    expect(topShell).toContain('height: "var(--top-shell-visual-height)"');
    expect(styles).toContain(".ambient-chrome-mask--top-with-tabs");
    expect(styles).toContain("var(--top-shell-reserved-height)");
    expect(styles).toContain("var(--top-ambient-tab-tail-midpoint, 32px)");
    expect(styles).not.toContain(
      "calc(var(--top-shell-reserved-height) + 50px)",
    );
    expect(providers).toContain('"--top-shell-reserved-height":');
    expect(providers).toContain('"--top-shell-visual-height":');
    expect(providers).toContain('"--top-tabs-total",');
  });

  it("samples past the content-facing mask edge instead of sampling chrome", () => {
    const ambient = read("lib/morphy-ux/ambient-chrome.ts");

    expect(ambient).toContain('const contentEdge = edge === "top" ? rect.bottom : rect.top');
    expect(ambient).toContain("sampleSurfaceAcrossMask");
    expect(ambient).toContain("AMBIENT_SAMPLE_COLUMNS");
    expect(ambient).toContain("AMBIENT_CHROME_FULL_BLEED_ATTR");
    expect(ambient).toContain('observer.observe(root, { attributes: true, attributeFilter: ["class"] });');
  });

  it("uses the shared Search Console dissolve curve at the bottom edge", () => {
    const styles = read("app/globals.css");

    expect(styles).toContain(".ambient-chrome-mask--bottom");
    expect(styles).toContain(
      "color-mix(in srgb, var(--ambient-chrome-bg) 86%, transparent) 22%",
    );
    expect(styles).toContain(
      "color-mix(in srgb, var(--ambient-chrome-bg) 42%, transparent) 52%",
    );
  });
});
