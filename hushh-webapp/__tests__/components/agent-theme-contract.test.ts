import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Agent theme contract", () => {
  it("keeps text and voice agent surfaces on app theme tokens", () => {
    const surfaces = [
      "components/agent/agent-chat-workspace.tsx",
      "components/agent/agent-history-sidebar.tsx",
      "components/agent/agent-popover-provider.tsx",
    ].map(read);
    const source = surfaces.join("\n");
    const globals = read("app/globals.css");

    expect(source).toContain("bg-background");
    expect(source).toContain("agent-themed-card-surface");
    expect(source).toContain("agent-themed-popover-surface");
    expect(source).toContain("text-foreground");
    expect(globals).toContain(".agent-themed-card-surface");
    expect(globals).toContain("background-color: var(--app-card-surface-default-solid)");
    expect(globals).toContain(".agent-themed-popover-surface");
    expect(globals).toContain("background-color: var(--popover)");

    for (const pinnedColor of [
      "bg-[#f5f5f7]",
      "bg-white/92",
      "bg-white/95",
      "dark:bg-[#0f1116]",
      "dark:bg-[#101216]",
      "dark:bg-[#15171c]",
      "dark:bg-[#1c1c1e]",
      "bg-card",
      "bg-popover",
      "text-[#1d1d1f]",
    ]) {
      expect(source).not.toContain(pinnedColor);
    }
  });
});
