import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The agent chat header's layout contract: the One | Puppy toggle can never
 * overlap a sibling, by construction rather than by a width that happens to
 * fit.
 *
 * Measured on localhost before this contract (reviewer session, 390px, both
 * themes, One and Puppy): the actions cluster was 281px because a fixed-width
 * slot was reserved for the model picker; the history button, brand tile and
 * title shared one unclipped group that flex squeezed to 65px against an 84px
 * minimum, so the brand tile painted under the toggle and the agent's name
 * collapsed to zero width. At 768px and 1440px the same slot left ~70px of
 * dead space beside the toggle, empty on the Puppy surface.
 *
 * jsdom has no layout engine, so this pins the structure that makes the
 * overlap impossible; the live widths are verified in a real browser.
 */

const root = process.cwd();
const workspace = fs.readFileSync(
  path.join(root, "components/agent/agent-chat-workspace.tsx"),
  "utf8",
);

function headerBlock(): string {
  const start = workspace.indexOf('"agent-chat-header ');
  expect(start).toBeGreaterThan(0);
  const end = workspace.indexOf("Both transcripts are HIDDEN", start);
  expect(end).toBeGreaterThan(start);
  return workspace.slice(start, end);
}

function openingTag(block: string, marker: string): string {
  const at = block.indexOf(marker);
  expect(at, `${marker} is in the header`).toBeGreaterThan(0);
  const tagStart = block.lastIndexOf("<", at);
  const tagEnd = block.indexOf(">", at);
  return block.slice(tagStart, tagEnd + 1);
}

describe("agent chat header layout", () => {
  it("gives way only in a clipped identity region, never under a control", () => {
    const header = headerBlock();
    const identity = openingTag(header, 'data-agent-chat-header-region="identity"');
    expect(identity).toContain("min-w-0");
    expect(identity).toContain("flex-1");
    // Horizontal clip: what does not fit is cut at the region's own edge and
    // truncates. `overflow-x-clip` (not `hidden`) leaves vertical overflow visible.
    expect(identity).toContain("overflow-x-clip");
    // The history control sits outside the region that gives way, so the
    // clip can never take it.
    expect(header.indexOf("ref={historyDrawerFallbackRef}")).toBeLessThan(
      header.indexOf('data-agent-chat-header-region="identity"'),
    );
  });

  it("keeps the toggle in flow, anchored beside the profile button", () => {
    const header = headerBlock();
    const picker = header.indexOf('data-testid="agent-chat-model-picker"');
    const toggle = header.indexOf('ariaLabel="Agent"');
    const profile = header.indexOf('data-testid="profile-open-button"');
    expect(picker).toBeGreaterThan(0);
    // Order is the anti-jump guarantee: the One-only picker comes and goes on
    // the far side of the toggle, so the toggle never moves under a thumb.
    expect(picker).toBeLessThan(toggle);
    expect(toggle).toBeLessThan(profile);
    // No reserved fixed-width slot for the picker; its cap lives on the
    // trigger itself so a long model name still truncates.
    expect(header).not.toMatch(/<span className="flex w-\[[\d.]+rem\] shrink-0/);
    expect(openingTag(header, 'data-testid="agent-chat-model-picker"')).toContain(
      "max-w-[7.5rem]",
    );
    // In flow: never absolutely or fixed positioned over the header.
    const toggleTag = header.slice(
      header.lastIndexOf("<SegmentedControl", toggle),
      header.indexOf("/>", toggle),
    );
    expect(toggleTag).not.toMatch(/\b(absolute|fixed)\b/);
    expect(toggleTag).toContain('size="sm"');
  });

  it("uses an icon-only toggle on phones without losing either spoken name", () => {
    const header = headerBlock();
    const toggle = header.indexOf('ariaLabel="Agent"');
    const toggleTag = header.slice(
      header.lastIndexOf("<SegmentedControl", toggle),
      header.indexOf("/>", toggle),
    );
    expect(toggleTag).toContain('iconClassName="sm:hidden"');
    expect(toggleTag).toContain('labelClassName="max-sm:hidden"');
    expect(toggleTag).toContain("icon: Cloud");
    expect(toggleTag).toContain("icon: Laptop");
    expect(toggleTag.match(/accessibleLabel:/g)).toHaveLength(2);
    // The brand tile repeats what the title and the toggle already say; on a
    // phone its width goes to the agent's name instead.
    expect(openingTag(header, "data-agent-chat-brand-tile")).toContain(
      "max-sm:hidden",
    );
  });

  it("renders the canonical Hussh mark at the existing 24px size", () => {
    const header = headerBlock();
    expect(header).toContain("<HushhMark");
    expect(header).toContain('className="h-[24px] w-[24px]"');
    expect(header).not.toContain("🤫");
  });
});
