import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Navbar bottom chrome contract", () => {
  it("keeps Agent owned by search chrome instead of duplicating it beside the nav", () => {
    const navbar = read("components/navbar.tsx");
    const commandBar = read("components/kai/kai-command-bar-global.tsx");
    const searchBar = read("components/kai/kai-search-bar.tsx");

    expect(navbar).toContain("useOptionalAgentPopover");
    expect(navbar).not.toContain('data-testid="bottom-agent-trigger"');
    expect(commandBar).toContain("showAgent={localVoiceReady}");
    expect(searchBar).toContain("showAgent?: boolean");
    expect(searchBar).toContain("showAgent ? (");
    expect(searchBar).toContain("kai-bottom-agent-action");
    expect(searchBar).toContain('aria-label="Open Agent"');
    expect(searchBar).toContain("agentPopover.openAgent()");
  });
});
