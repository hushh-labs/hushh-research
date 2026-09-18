import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("profile and memory interaction surfaces", () => {
  it("keeps SettingsRow hover on the outer row while retaining press feedback", () => {
    const source = read("components/app-ui/settings-ui.tsx");

    expect(source).toContain("group-hover/settings-row:bg-foreground/[0.04]");
    expect(source).toContain("disableHover");
    expect(source).not.toContain(
      'className="relative isolate min-w-0 rounded-xl bg-foreground',
    );
  });

  it("gives each memory tree node one hover owner", () => {
    const jsonTree = read("components/profile/pkm-tree-view.tsx");
    const memoryTree = read("components/profile/pkm-memory-browser.tsx");
    const explorer = read("components/profile/pkm-explorer-panel.tsx");

    expect(jsonTree).toContain("TREE_NODE_SURFACE_CLASSNAME");
    expect(jsonTree).toContain("hover:bg-transparent");
    expect(memoryTree).toContain("group/pkm-memory-node");
    expect(memoryTree).toContain("hover:bg-transparent");
    expect(explorer).toContain("transition-colors");
    expect(explorer).toContain("bg-transparent text-foreground hover:bg-muted/50");
    expect(explorer).not.toContain(
      "bg-card shadow-[var(--app-card-shadow-standard)] hover:bg-muted/50",
    );
  });
});
