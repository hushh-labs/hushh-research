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
    expect(navbar).toContain("flex justify-center");
    expect(agentBar).toContain('"var(--agent-bar-with-nav-bottom)",');
    expect(agentBar).not.toContain(
      "calc(max(var(--app-bottom-inset), calc(var(--bottom-nav-offset) + var(--app-safe-area-bottom-effective) + var(--app-bottom-chrome-lift))) + 0.5rem)",
    );
  });

  it("keeps Agent owned by the persistent AgentBar instead of duplicating it in the nav or search chrome", () => {
    const navbar = read("components/navbar.tsx");
    const searchBar = read("components/kai/kai-search-bar.tsx");
    const agentBar = read("components/agent/agent-bar.tsx");
    const providers = read("app/providers.tsx");

    expect(navbar).toContain("const bottomNavWidth =");
    expect(navbar).toContain(
      '"min(calc(100vw - 1.5rem), var(--app-bottom-shell-max-width))"',
    );
    expect(navbar).toContain("style={{ width: bottomNavWidth }}");
    expect(navbar).not.toContain('data-testid="bottom-agent-trigger"');

    // The Kai search chrome must no longer render its own Agent launcher; the
    // persistent AgentBar is the single agent entry point.
    expect(searchBar).not.toContain("kai-bottom-agent-action");
    expect(searchBar).not.toContain('aria-label="Open Agent"');

    // The command bar remains the global typed-search surface, while the
    // persistent Agent Bar also exposes a direct Agent Chat entry point.
    expect(agentBar).toContain('data-testid="one-agent-chat-open"');
    expect(agentBar).toContain("onClick={openAgentChat}");
    expect(agentBar).toContain("aria-label={`Open Agent Chat. ${hint}`}");
    expect(agentBar).not.toContain("openSearchAndChat");
    expect(agentBar).not.toContain("openKaiCommandBar");
    expect(agentBar).toContain("Talk to One");
    expect(agentBar).toContain(
      'data-native-voice-control-id="one_voice_agent_bar_start"',
    );
    expect(agentBar).toContain("onClick={handleVoiceStartClick}");
    expect(agentBar).toContain(
      "aria-label={`Start a voice conversation. ${hint}`}",
    );
    // The native control is the complete visible voice pill. The separate
    // Agent Chat button remains its own action, but no whitespace or icon-only
    // target is allowed inside the voice launcher.
    expect(agentBar).toContain("agent-bar-voice-launcher press-scale");
    expect(agentBar).toContain("flex-1 self-stretch items-center");
    expect(agentBar).toContain("hover:bg-current/[0.09]");
    expect(agentBar).toContain("focus-visible:ring-inset");
    expect(agentBar).toContain(
      'className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-full"',
    );
    expect(agentBar).toContain("MessageCircle");
    expect(agentBar).toContain("loading: authLoading");
    expect(agentBar).toContain("!agentPopover ||\n    authLoading ||");
    expect(agentBar).not.toContain("isRiaChrome");
    expect(agentBar).toContain('layout = "fixed"');
    expect(agentBar).not.toContain("useKaiBottomChromeElementTranslation");
    expect(agentBar).toContain("bottom: physicalNavbarAbsent");
    expect(agentBar).not.toContain("useKaiBottomChromeVisibility");
    expect(agentBar).not.toContain(
      "calc(var(--bottom-chrome-progress, 0) * var(--agent-bar-hide-distance))",
    );
    const bottomChromeMotion = read(
      "lib/navigation/kai-bottom-chrome-visibility.ts",
    );
    expect(bottomChromeMotion).toContain("follow the thumb directly");
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

    // Persistent bottom chrome has one compositor, mounted outside route
    // Suspense with navigation and Agent Bar remaining separate controls.
    const bottomShell = read("components/app-ui/app-bottom-shell.tsx");
    expect(providers).toContain("<AppBottomShell model={bottomShellModel} />");
    expect(providers).toContain(
      "<AmbientChromeController enabled={ambientChromeEnabled} />",
    );
    expect(providers).not.toContain("SharedBottomChromeGlass");
    expect(providers).not.toContain("<AgentBar />");
    expect(bottomShell).toContain("export function AppBottomShell");
    expect(bottomShell).not.toContain("AmbientChromeController");
    expect(bottomShell).toContain(
      '<AmbientChromeMask\n          edge="bottom"',
    );
    expect(bottomShell).not.toContain("useKaiBottomChromeElementTranslation");
    expect(bottomShell).toContain("snapKaiBottomChromeVisible");
    expect(bottomShell).toContain("onPointerDownCapture");
    expect(bottomShell).toContain("BOTTOM_SCROLL_TRANSFORM");
    expect(bottomShell).toContain("data-bottom-shell-motion-stack");
    expect(bottomShell).toContain("data-bottom-shell-agent-slot");
    expect(bottomShell).toContain("data-bottom-shell-navigation-slot");
    expect(bottomShell).toContain("--bottom-nav-travel");
    expect(bottomShell).toContain("data-app-bottom-shell");
    expect(bottomShell).toMatch(
      /<Navbar\s+shellNavigationHidden=\{model\.navigationHidden\}\s+layout="slot"/,
    );
    expect(bottomShell).toContain('<AgentBar layout="slot" />');
    expect(bottomShell).toContain("items-center gap-1.5");
    expect(agentBar).toContain('? "h-11 rounded-[22px] px-2.5"');
    expect(agentBar).toContain("var(--app-agent-bar-max-width)");
    expect(bottomShell).toContain("var(--bottom-chrome-full-height)");
    expect(bottomShell).toContain("--app-bottom-shell-height");
    expect(bottomShell).not.toContain("xl:hidden");
    expect(navbar).toContain("shellNavigationHidden = false");
    expect(navbar).toContain("if (shellNavigationHidden || hideNavbar)");
    expect(navbar).toContain("data-ambient-chrome-ignore");
    expect(agentBar).toContain("data-ambient-chrome-ignore");
  });

  it("pins voice-only Foundation chrome instead of applying signed-in nav scroll-hide motion", () => {
    const providers = read("app/providers.tsx");

    expect(providers).toContain(
      "const foundationVoiceOnlyChrome = isFoundationRoute;",
    );
    expect(providers).toContain(
      "const pinnedBottomChrome =\n    isRiaRoute(pathname) || foundationVoiceOnlyChrome;",
    );
    expect(providers).toContain(
      "navigationHidden:\n      chromeState.hideCommandBar || foundationVoiceOnlyChrome,",
    );
    expect(providers).toContain(
      "!pinnedBottomChrome &&\n      !hidesPersistentChrome",
    );
  });
});
