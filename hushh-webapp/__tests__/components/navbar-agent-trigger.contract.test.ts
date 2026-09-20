import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs
    .readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

describe("Navbar bottom chrome contract", () => {
  it("keeps the persistent voice bar and utility bar as distinct chrome pills", () => {
    const navbar = read("components/navbar.tsx");
    const agentBar = read("components/agent/command-agent-bar.tsx");

    expect(navbar).toContain("const BOTTOM_GAP_PX = 4;");
    expect(navbar).toContain("flex justify-center");
    expect(agentBar).toContain('"var(--agent-bar-with-nav-bottom)",');
    expect(agentBar).not.toContain(
      "calc(max(var(--app-bottom-inset), calc(var(--bottom-nav-offset) + var(--app-safe-area-bottom-effective) + var(--app-bottom-chrome-lift))) + 0.5rem)",
    );
  });

  it("keeps voice owned by the persistent AgentBar while Chat belongs to navigation", () => {
    const navbar = read("components/navbar.tsx");
    const searchBar = read("components/kai/kai-search-bar.tsx");
    const agentBar = read("components/agent/command-agent-bar.tsx");
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

    // Command capture owns voice; Chat is a distinct navigation destination.
    expect(navbar).toContain('label: "Chat"');
    expect(navbar).toContain('dataTourId: "nav-chat"');
    expect(agentBar).not.toContain('data-agent-action="chat"');
    expect(agentBar).not.toContain("openKaiCommandBar");
    expect(agentBar).toContain("useLocationCommand()");
    expect(agentBar).toContain('data-native-voice-control-id="one_voice_agent_bar_start"');
    expect(agentBar).toContain('data-agent-action="voice"');
    expect(agentBar).toContain("Talk to One. Hold to speak, or tap to start and finish.");
    expect(agentBar).toContain("onPointerDown=");
    expect(agentBar).toContain("onPointerUp=");
    expect(agentBar).toContain("onPointerCancel=");
    expect(agentBar).toContain("finishCapture() : startCapture()");
    expect(agentBar).toContain("cancelCapture()");
    expect(agentBar).toContain("focus-visible:ring-inset");
    expect(agentBar).toContain('layout = "fixed"');
    expect(agentBar).toContain("bottom: noNavbar");
    expect(agentBar).not.toContain("useKaiBottomChromeElementTranslation");
    expect(agentBar).not.toContain("useKaiBottomChromeVisibility");

    // The AgentBar is mounted above the route shell, so it cannot inherit
    // route-shell variables. The provider must mirror the nav's geometry to
    // :root alongside the scroll progress that the bar already consumes.
    const mirroredVars = read("lib/navigation/root-shell-mirror.ts").match(
      /export const ROOT_MIRRORED_SHELL_VARS = \[(?<vars>[\s\S]*?)\]/,
    )?.groups?.vars;
    expect(providers).toContain("createRootShellMirror(");
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
    expect(bottomShell).toContain("export const AppBottomShell = memo(function AppBottomShell");
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
    expect(agentBar).toContain('data-agent-dock="one-agent-dock"');
    expect(agentBar).toContain('role="group"');
    expect(agentBar).toContain('aria-label="One private agent"');
    const dockClass = agentBar.match(
      /data-testid="one-voice-agent-bar"[\s\S]*?className=\{cn\((?<classes>[\s\S]*?)\)\}/,
    )?.groups?.classes;
    expect(dockClass).toBeDefined();
    expect(dockClass).toContain("bottom-chrome-surface");
    expect(dockClass).not.toContain("backdrop-blur");
    expect(agentBar).not.toContain('? "h-11 rounded-[22px] px-2.5"');
    expect(agentBar).toContain("var(--app-agent-bar-max-width)");
    expect(bottomShell).toContain("var(--bottom-chrome-full-height)");
    expect(bottomShell).toContain("--app-bottom-shell-height");
    expect(bottomShell).not.toContain("xl:hidden");
    expect(navbar).toContain("shellNavigationHidden = false");
    expect(navbar).toContain("if (shellNavigationHidden || hideNavbar)");
    expect(navbar).toContain("data-ambient-chrome-ignore");
    expect(agentBar).toContain("data-ambient-chrome-ignore");
    const globalStyles = read("app/globals.css");
    expect(globalStyles).toContain("[data-bottom-shell-motion-stack]");
    expect(globalStyles).toContain(
      "transform: translate3d(0, calc(var(--kb-height, 0px) * -1), 0) !important",
    );
    expect(globalStyles).toContain(
      ".bottom-chrome-surface,\n.kai-bottom-nav-pill {",
    );
    expect(globalStyles).not.toContain(
      ".kai-bottom-nav-pill {\n  color: var(--foreground);\n  border: 0 !important;",
    );
    const chromeState = read("lib/navigation/kai-chrome-state.ts");
    expect(chromeState).not.toContain("path === ROUTES.HOME ||");
  });

  it("pins voice-only Foundation chrome instead of applying signed-in nav scroll-hide motion", () => {
    const providers = read("app/providers.tsx");

    expect(providers).toContain(
      "const foundationVoiceOnlyChrome = isFoundationRoute && !isAuthenticated;",
    );
    expect(providers).toMatch(
      /const pinnedBottomChrome\s*=\s*isRiaRoute\(pathname\)\s*\|\|\s*foundationVoiceOnlyChrome;/,
    );
    expect(providers).toMatch(
      /navigationHidden:\s*hideBottomNavigation,/,
    );
    expect(providers).toContain(
      "!pinnedBottomChrome &&\n      !bottomChromeHidden",
    );
  });
});
