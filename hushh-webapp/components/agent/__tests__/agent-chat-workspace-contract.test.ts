import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("AgentChatWorkspace mobile chrome contract", () => {
  it("exposes chat history in mobile popover mode separately from Back", () => {
    const source = read("components/agent/agent-chat-workspace.tsx");

    expect(source).toContain("isPopover ? (");
    expect(source).toContain("onClick={openHistoryDrawer}");
    expect(source).toContain('aria-label="Open chat history"');
    expect(source).toContain("sm:hidden");
    expect(source).toContain('aria-label="Back"');
  });
});
