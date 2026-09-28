import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Puppy One's chat must take the same room One's chat takes.
 *
 * Founder report (2026-09-27): starting a Puppy chat, for a fresh person or a
 * connected one, rendered small and did not feel like One. Three causes, each
 * pinned here because jsdom has no layout engine to measure them:
 *
 *   1. In the workspace, One's transcript REGION stayed displayed while only
 *      its scroller was hidden. That region is `flex-1` beside Puppy's own
 *      `flex-1` surface, so Puppy got half the column.
 *   2. Puppy's surface padded its bottom with a fixed `pb-3`, which on root
 *      Chat put its composer under the fixed bottom navigation. One's composer
 *      clears it through `--agent-chat-composer-bottom`.
 *   3. `/one/puppy` held the chat in a fixed `min(68dvh, 42rem)` card at the
 *      720px reading width instead of One's measure and the full height.
 */

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Puppy One chat layout", () => {
  it("hides One's whole transcript region in Puppy mode, not only its scroller", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const region = workspace.match(
      /className=\{cn\(\s*"relative min-h-0 flex-1 overflow-hidden",\s*isPuppySurface && "hidden",\s*\)\}\s*inert=\{isHistoryDrawerOpen\}/,
    );
    expect(region).not.toBeNull();
    // The bare, always-displayed form the defect shipped as.
    expect(workspace).not.toContain(
      'className="relative min-h-0 flex-1 overflow-hidden"\n            inert={isHistoryDrawerOpen}',
    );
  });

  it("clears the bottom navigation and safe area the way One's composer does", () => {
    const surface = read("components/agent/puppy-one-surface.tsx");
    expect(surface).toContain("pb-[var(--agent-chat-composer-bottom,");
    expect(surface).toContain(
      "focus-within:pb-[var(--agent-chat-composer-focused-bottom,",
    );
    expect(surface).not.toMatch(/"flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-3/);
    // One's 896px measure, and no card frame around the conversation.
    expect(surface).toContain("max-w-4xl");
    expect(surface).not.toContain("rounded-2xl border border-border/60 bg-background");
  });

  it("gives /one/puppy One's measure and the full visible height", () => {
    const page = read("app/one/puppy/page.tsx");
    expect(page).toContain('width="agent"');
    expect(page).not.toContain('width="reading"');
    expect(page).not.toContain("h-[min(68dvh,42rem)]");
    expect(page).toContain("100dvh-var(--app-top-content-offset,0px)");
    expect(page).toContain('<AppPageContentRegion className="flex min-h-0 flex-1 flex-col">');
  });

  it("uses One's compact composer size and type scale", () => {
    const panel = read("components/agent/hermes-chat-panel.tsx");
    expect(panel).toContain("min-h-[3.75rem]");
    expect(panel).toContain("rounded-[var(--app-input-radius)]");
    expect(panel).toContain("text-[15px] leading-snug");
    expect(panel).toContain('aria-label="Message Puppy One"');
    // The old 40px bordered field.
    expect(panel).not.toContain("min-h-[2.5rem]");
    // Turns keep One's widths: 90% on phones, One's caps from `sm`.
    expect(panel).toContain("max-w-[90%] whitespace-pre-wrap");
    expect(panel).toContain("sm:max-w-[min(76%,42rem)]");
    expect(panel).toContain("sm:max-w-[min(82%,48rem)]");
  });
});
