import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Navbar bottom chrome contract", () => {
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
    expect(agentBar).toContain('const isRiaChrome = isRiaRoute(pathname ?? "")');
    expect(agentBar).not.toContain('const isRiaChrome = activePersona === "ria"');
    expect(agentBar).toContain("useKaiBottomChromeElementTranslation");
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
  });
});
