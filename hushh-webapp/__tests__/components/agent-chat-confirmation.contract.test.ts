import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * One confirmation means one tap.
 *
 * Confirming an action in chat used to take two. The first button said
 * "Authorize" and did nothing at all: it called `async () => \`agui:${callId}\``,
 * stored that template string as a `receipt`, toasted "Tap Run to continue",
 * and returned WITHOUT executing. No signature, no permission check, no ledger
 * proof -- a second tap that bought nothing while reading, to a person, as a
 * security step they had just cleared.
 *
 * Nothing in the suite asserted any of it, which is how it shipped. That is the
 * reason this file exists: the defect was not that someone wrote a bad step, it
 * was that a step could exist unexamined on the one surface where a person
 * authorises another person's access to their information.
 *
 * The real binding is the directive ledger
 * (`_GOVERNED_LEDGER_CONFIRMATION_ACTION_IDS` in action_tools.py). A local
 * placeholder standing next to it does not add safety; it dilutes the meaning
 * of the tap that does.
 */

const WEB_ROOT = path.resolve(__dirname, "../..");

/**
 * Source with comments removed.
 *
 * Needed because the first version of this file failed on its own explanation:
 * the comment describing the removed `agui:${callId}` receipt matched the
 * pattern forbidding it. A gate that cannot tell code from prose about code
 * will be silenced rather than fixed.
 */
function read(relative: string): string {
  return readFileSync(path.join(WEB_ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

describe("agent chat action confirmation", () => {
  const workspace = read("components/agent/agent-chat-workspace.tsx");

  it("never mints a receipt the app did not earn", () => {
    // The exact shape of the old no-op. A receipt must come from something that
    // actually authorised the action, never from interpolating its own call id.
    expect(workspace).not.toMatch(/authorize:\s*async\s*\(\)\s*=>\s*`agui:/);
    expect(workspace).not.toMatch(/`agui:\$\{[^}]*callId[^}]*\}`/);
  });

  it("labels the confirm button with the action, not with a step before it", () => {
    // A label chosen by `authorize && !receipt` always read "Authorize" first,
    // because authorize was always set and receipt always started undefined.
    expect(workspace).toContain(
      'confirmLabel={pendingAppAction.event.label || "Run"}',
    );
    expect(workspace).not.toContain('? "Authorize"');
  });

  it("executes on the confirming tap rather than returning early", () => {
    // The early return is the whole defect: the person confirmed, and nothing
    // happened. If a future step needs to run before execute(), it must still
    // end in execute() on that same tap.
    expect(workspace).toContain("await pending.execute();");
    expect(workspace).not.toMatch(/Authorized\.\s*Tap/);
  });
});

describe("agent turn stream sections", () => {
  const panel = read("components/app-ui/stream-progress-panel.tsx");

  it("does not render two stacked sections under the same glyph", () => {
    // `AppStreamSection` defaults its icon to Activity. Both call sites took the
    // default, so a turn that reasoned produced two collapsibles with identical
    // icon, chevron and shell -- which reads as the app saying one thing twice
    // rather than as two different kinds of detail.
    const sectionCalls = panel.match(/<AppStreamSection\b/g) || [];
    expect(sectionCalls.length).toBeGreaterThan(1);

    // The reasoning section must name its own.
    expect(panel).toMatch(/title=\{thinkingTitle\}[\s\S]{0,600}?icon=\{Brain\}/);
  });
});
