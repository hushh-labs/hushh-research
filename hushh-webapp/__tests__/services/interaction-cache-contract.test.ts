import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function read(relativePath: string) {
  return fs.readFileSync(path.join(projectRoot(), relativePath), "utf8");
}

describe("interaction and cache contract", () => {
  it("keeps shared interaction shells aligned with full-surface ripple behavior", () => {
    const globals = read("app/globals.css");
    const navbar = read("components/navbar.tsx");
    const topAppBar = read("components/app-ui/top-app-bar.tsx");
    const taskCenter = read("components/app-ui/debate-task-center.tsx");
    const providers = read("app/providers.tsx");
    const materialRipple = read("lib/morphy-ux/material-ripple.tsx");

    expect(navbar).toContain('hitArea="segment"');
    expect(navbar).not.toContain('hitArea="content"');

    expect(topAppBar).toContain('<Check className="ml-auto h-4 w-4 text-current" />');
    expect(topAppBar).toContain('<Loader2 className="ml-auto h-4 w-4 animate-spin text-current" />');
    expect(taskCenter).toContain("Notifications");
    expect(topAppBar).toContain('href={consentCenterHref}');
    expect(taskCenter).not.toContain("Consent Center");
    expect(taskCenter).not.toContain('openConsentSheet({ view: "pending" })');
    expect(taskCenter).not.toContain("Notification delivery");
    expect(taskCenter).not.toContain("BellRing");
    expect(taskCenter).not.toContain("useConsentNotificationState");
    expect(providers).toContain("ConsentSheetProvider");
    expect(providers).toContain('"--top-systembar-row-gap": "4px"');

    expect(globals).toContain("--top-shell-reserved-height");
    expect(globals).toContain("--top-shell-visual-height");
    expect(globals).toContain(".bar-glass-top::before");
    expect(globals).toContain(".bar-glass-bottom::before");
    expect(globals).toContain(".morphy-ripple-host");
    expect(globals).not.toContain("html.native-ios body {\n    padding-top: env(safe-area-inset-top);");
    expect(materialRipple).toContain("morphy-ripple-host");
    expect(materialRipple).toContain("overflow-hidden");
    expect(materialRipple).toContain('contain: "paint"');
  });

  it("keeps kai market home on stale-aware cache refreshes", () => {
    const kaiMarketHome = read("components/kai/views/kai-market-preview-view.tsx");
    const riaPicksList = read("components/kai/cards/renaissance-market-list.tsx");
    const unlockWarmOrchestrator = read("lib/services/unlock-warm-orchestrator.ts");

    expect(kaiMarketHome).toContain("staleOnly?: boolean");
    expect(kaiMarketHome).toContain("staleOnly?: boolean");
    expect(kaiMarketHome).toContain("THEME_ICON_MAP");
    expect(riaPicksList).not.toContain("useSearchParams");
    expect(riaPicksList).not.toContain("router.replace");
    expect(riaPicksList).toContain("useState(DEFAULT_PICKS_PAGE_SIZE)");
    expect(unlockWarmOrchestrator).toContain("getKaiActivePickSource");
    expect(unlockWarmOrchestrator).toContain("KaiFinancialResourceService");
  });
});
