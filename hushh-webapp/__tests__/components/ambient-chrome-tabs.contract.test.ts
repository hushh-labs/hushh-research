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
    expect(topShell).toContain(': "var(--top-shell-visual-height)"');
    expect(styles).toContain(".ambient-chrome-mask--top-with-tabs");
    expect(styles).toContain("var(--top-shell-reserved-height)");
    expect(styles).toContain("var(--top-fade-active)");
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
    const mask = read("components/app-ui/ambient-chrome-mask.tsx");

    expect(mask).toContain('"ambient-chrome-mask"');
    expect(mask).not.toContain("backdrop-blur");
    expect(mask).not.toContain("backdrop-saturate");
    expect(styles).toMatch(
      /\.ambient-chrome-mask\s*\{[^}]*--tw-backdrop-blur: blur\(0px\);/s,
    );
    expect(styles).toContain(".ambient-chrome-mask--bottom");
    expect(styles).toContain(
      "color-mix(in srgb, var(--ambient-chrome-bg) 89%, transparent) 22%",
    );
    expect(styles).toContain(
      "color-mix(in srgb, var(--ambient-chrome-bg) 48%, transparent) 52%",
    );
  });

  it("keeps sampled chrome foreground authoritative for text and icons", () => {
    const styles = read("app/globals.css");

    expect(styles).toContain("[data-app-top-bar] .top-shell-ambient-ink .text-foreground");
    expect(styles).toContain("color: currentColor;");
    expect(styles).toContain("var(--ambient-chrome-bottom-fg, #1d1d1f)");
    expect(styles).not.toContain("ambient-chrome-bottom-base");
    expect(styles).toContain("--lucide-stroke-width: 1.6");
  });

  it("keeps both chrome edges on the one live token contract", () => {
    const ambient = read("lib/morphy-ux/ambient-chrome.ts");

    expect(ambient).not.toContain("baseBackground");
    expect(ambient).not.toContain("writeBottomBase");
    expect(ambient).toContain('background: "--ambient-chrome-bottom-bg"');
    expect(ambient).toContain('foreground: "--ambient-chrome-bottom-fg"');
  });
});
