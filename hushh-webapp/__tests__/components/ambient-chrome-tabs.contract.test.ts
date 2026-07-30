import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("tabbed ambient chrome contract", () => {
  it("uses one resolved top-edge mask for tabbed and plain shells", () => {
    const topShell = read("components/app-ui/top-app-bar.tsx");
    const styles = read("app/globals.css");
    const providers = read("app/providers.tsx");

    expect(topShell).toContain("ambient-chrome-mask--top-with-tabs");
    expect(topShell).toContain('"var(--top-shell-mask-visible-height)"');
    expect(styles).toContain(".ambient-chrome-mask--top-with-tabs");
    expect(styles).toContain(".ambient-chrome-mask--top {");
    expect(styles).toContain("--top-shell-live-height");
    expect(styles).toContain("--top-shell-mask-tabs-gap");
    expect(styles).toContain("--top-shell-mask-solid-height");
    expect(styles).toContain("--top-shell-mask-visible-height");
    expect(styles).toContain("--ambient-chrome-top-solid-height");
    expect(styles).toContain("var(--top-chrome-collapse-px, 0px)");
    expect(styles).toContain("--ambient-chrome-top-visible-height");
    expect(styles).toContain("--ambient-chrome-wash: 94%");
    expect(styles).toContain("var(--top-fade-active)");
    expect(providers).toContain(
      '"--top-fade-active": topShellMetrics.hasTabs ? "12px" : "14px"',
    );
    expect(providers).toContain('"--top-ambient-tab-tail-midpoint": "8px"');
    expect(styles).not.toContain(
      "calc(var(--top-shell-reserved-height) + 50px)",
    );
    expect(providers).toContain('"--top-shell-reserved-height":');
    expect(providers).toContain('"--top-shell-visual-height":');
    expect(providers).toContain('"--top-shell-live-height":');
    expect(providers).toContain('"--top-shell-mask-tabs-gap":');
    expect(providers).toContain('"--top-shell-mask-visible-height":');
    expect(providers).toContain('"--top-tabs-total",');
  });

  it("keeps the Consent bounded manager clear of the tab-mask tail", () => {
    const routeLayout = JSON.parse(
      read("lib/navigation/app-route-layout.contract.json"),
    ) as Array<{ route?: string; pageTopLocalOffset?: string }>;
    const consentRoute = routeLayout.find(
      (entry) => entry.route === "/one/consent",
    );

    expect(consentRoute?.pageTopLocalOffset).toBe("16px");
  });

  it("samples past the content-facing mask edge instead of sampling chrome", () => {
    const ambient = read("lib/morphy-ux/ambient-chrome.ts");

    expect(ambient).toContain(
      'const contentEdge = edge === "top" ? rect.bottom : rect.top',
    );
    expect(ambient).toContain("sampleSurfaceAcrossMask");
    expect(ambient).toContain("AMBIENT_SAMPLE_COLUMNS");
    expect(ambient).toContain("AMBIENT_CHROME_FULL_BLEED_ATTR");
    expect(ambient).toContain(
      'observer.observe(root, { attributes: true, attributeFilter: ["class"] });',
    );
  });

  it("uses the shared dissolve curve and bounded readability blur at both edges", () => {
    const styles = read("app/globals.css");
    const mask = read("components/app-ui/ambient-chrome-mask.tsx");

    expect(mask).toContain('"ambient-chrome-mask"');
    expect(styles).toContain("--ambient-chrome-mask-blur");
    expect(styles).toContain("--app-shared-chrome-mask-blur");
    expect(styles).toContain("--ambient-chrome-backdrop-filter");
    expect(styles).toContain(
      "backdrop-filter: var(--ambient-chrome-backdrop-filter)",
    );
    expect(styles).toContain(".ambient-chrome-mask--bottom");
    expect(styles).toContain(
      "color-mix(in srgb, var(--ambient-chrome-bg) 91%, transparent) 16%",
    );
    expect(styles).toContain(
      "color-mix(in srgb, var(--ambient-chrome-bg) 38%, transparent) 64%",
    );
    expect(styles).toContain(".ambient-chrome-mask--bottom");
    expect(styles).toContain("rgba(0, 0, 0, 0.72) 38%");
    expect(styles).toContain("rgba(0, 0, 0, 0.97)");
    expect(styles).toContain("rgba(0, 0, 0, 0.77)");
    expect(styles).toContain("rgba(0, 0, 0, 0.40)");
    expect(styles).toContain("rgba(0, 0, 0, 0.13)");
  });

  it("drives top-shell collapse directly from the shared scroll progress", () => {
    const topShell = read("components/app-ui/top-app-bar.tsx");

    expect(topShell).toContain("--top-chrome-collapse-px");
    expect(topShell).toContain("--top-chrome-progress");
    expect(topShell).not.toContain(
      "transition-[max-height,opacity,transform,padding]",
    );
    expect(topShell).not.toContain("transition-[height,padding]");
  });

  it("keeps neutral theme foreground authoritative for text and icons", () => {
    const styles = read("app/globals.css");

    expect(styles).toContain(
      "[data-app-top-bar] .top-shell-ambient-ink .text-foreground",
    );
    expect(styles).toContain("color: currentColor;");
    expect(styles).toContain(
      "--ambient-chrome-material-bg: var(--app-layout-surface, var(--background))",
    );
    expect(styles).toContain("--ambient-chrome-material-fg: var(--foreground)");
    expect(styles).not.toContain("color: var(--ambient-chrome-top-fg");
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

  it("contracts the bottom mask with the scroll-hidden navigation slot", () => {
    const bottomShell = read("components/app-ui/app-bottom-shell.tsx");

    expect(bottomShell).toContain("var(--bottom-chrome-progress, 0)");
    expect(bottomShell).toContain("var(--bottom-nav-travel, 0px)");
    expect(bottomShell).not.toContain("var(--bottom-chrome-fade-tail)");
  });
});
