import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Navbar bottom chrome contract", () => {
  it("keeps the persistent Agent Bar joined to the fixed utility bar", () => {
    const navbar = read("components/navbar.tsx");
    const agentBar = read("components/agent/agent-bar.tsx");

    expect(navbar).toContain("const BOTTOM_GAP_PX = 4;");
    expect(navbar).toContain("md:justify-end");
    expect(agentBar).toContain(
      '"max(var(--app-bottom-inset), calc(var(--bottom-nav-offset)',
    );
    expect(agentBar).not.toContain(
      'calc(max(var(--app-bottom-inset), calc(var(--bottom-nav-offset) + var(--app-safe-area-bottom-effective) + var(--app-bottom-chrome-lift))) + 0.5rem)',
    );
  });

  it("keeps Agent owned by the persistent AgentBar instead of duplicating it in the nav or search chrome", () => {
    const navbar = read("components/navbar.tsx");
    const searchBar = read("components/kai/kai-search-bar.tsx");
    const agentBar = read("components/agent/agent-bar.tsx");
    const providers = read("app/providers.tsx");

    expect(navbar).toContain("function resolveBottomNavMaxWidth");
    expect(navbar).toContain("const bottomNavWidth =");
    expect(navbar).toContain("style={{ width: bottomNavWidth }}");
    expect(navbar).not.toContain('data-testid="bottom-agent-trigger"');

    // The Kai search chrome must no longer render its own Agent launcher; the
    // persistent AgentBar is the single agent entry point.
    expect(searchBar).not.toContain("kai-bottom-agent-action");
    expect(searchBar).not.toContain('aria-label="Open Agent"');

    expect(agentBar).toContain('data-testid="one-voice-agent-bar-start"');
    expect(agentBar).toContain('onClick={openAgentChat}');
    expect(agentBar).toContain('aria-label={`Open Agent Chat. ${hint}`}');
    expect(agentBar).toContain('data-native-voice-control-id="one_voice_agent_bar_start"');
    expect(agentBar).toContain('onClick={handleVoiceStartClick}');
    expect(agentBar).toContain('aria-label="Start conversation"');
    expect(agentBar).toContain("loading: authLoading");
    expect(agentBar).toContain("!agentPopover ||\n    authLoading ||");
    expect(agentBar).not.toContain("isRiaChrome");
    expect(agentBar).toContain("agentBarShellRef,\n    !physicalNavbarAbsent,");
    expect(agentBar).toContain("useKaiBottomChromeElementTranslation");
    expect(agentBar).toContain(
      "max(var(--app-bottom-inset), calc(var(--bottom-nav-offset)",
    );
    expect(agentBar).not.toContain("useKaiBottomChromeVisibility");
    expect(agentBar).not.toContain(
      "calc(var(--bottom-chrome-progress, 0) * var(--agent-bar-hide-distance))",
    );
    const bottomChromeMotion = read(
      "lib/navigation/kai-bottom-chrome-visibility.ts",
    );
    expect(bottomChromeMotion).toContain(
      "--bottom-chrome-hide-distance, var(--bottom-chrome-full-height)",
    );
    expect(bottomChromeMotion).toContain(
      "Agent Bar\n * settles into its vacated bottom slot and remains entirely visible",
    );
    expect(agentBar).not.toContain('aria-label="Talk to your agent"');
    expect(agentBar).not.toContain("<Mic");

    // The AgentBar is mounted above the route shell, so it cannot inherit
    // route-shell variables. The provider must mirror the nav's geometry to
    // :root alongside the scroll progress that the bar already consumes.
    const mirroredVars = providers.match(
      /const mirroredVars = \[(?<vars>[\s\S]*?)\];/,
    )?.groups?.vars;
    expect(mirroredVars).toContain('"--bottom-chrome-hide-distance"');
    expect(mirroredVars).toContain('"--bottom-chrome-full-height"');

    // Compact layouts intentionally keep one continuous ambient mask across
    // the bottom cluster. Desktop separates the navigation and persistent
    // Agent Bar vertically, so each must own a locally anchored fade rather
    // than inheriting the navigation fade's transparent tail.
    expect(providers).toContain("function SharedBottomChromeGlass()");
    expect(providers).toContain("z-[108] md:hidden");
    expect(providers).toContain("z-[108] hidden md:block");
    expect(providers).toContain(
      '"calc(var(--app-bottom-inset) + var(--bottom-chrome-fade-overscan))"',
    );
    expect(providers).toContain(
      '"calc(3rem + var(--bottom-chrome-fade-overscan))"',
    );
  });
});
