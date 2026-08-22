import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Looking for someone who is not there yet has one continuous path.
 *
 * A person searching the People list for a name is asking one question: where
 * is this person? There are three answers, and until now the first one was a
 * dead end.
 *
 *   1. People search finds nobody   -> hand over to Connect        (this PR)
 *   2. Connect search finds nobody  -> offer "Invite them to One"  (on main)
 *   3. They accept the invite       -> they appear in both lists
 *
 * Steps 2 and 3 already existed. Step 1 ended at "No matching people / Try a
 * different name.", which answers a question nobody asked and leaves the
 * person to guess that Connect is the next place to look. The chain only works
 * end to end if every link points at the next one.
 *
 * These are source contracts rather than render tests because both surfaces
 * need a full view-model to mount, and what is worth protecting is narrow: the
 * links exist and point where they say.
 */

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

const HUB = source(
  "components",
  "one-location",
  "redesign",
  "location-redesign-hub.tsx",
);
const CONNECT = source("app", "connect", "page-client.tsx");

function peopleEmptyState(src: string): string {
  // Identified by the two titles it switches between, not by line number.
  const anchor = src.indexOf('hasSearch ? "No matching people"');
  expect(
    anchor,
    "the People empty state was renamed; update this contract with it",
  ).toBeGreaterThan(-1);
  const open = src.lastIndexOf("<EmptyState", anchor);
  const close = src.indexOf("/>", anchor);
  return src.slice(open, close + 2);
}

describe("link 1 — People search hands over to Connect", () => {
  const block = peopleEmptyState(HUB);

  it("asks the question the person is actually asking", () => {
    expect(block).toContain("Don't see who you're looking for?");
  });

  it("offers the way into Connect", () => {
    expect(block).toContain("action=");
    expect(block).toContain("Manage connections in Connect");
  });

  it("offers the same bridge when there are no connections at all", () => {
    expect(block).toContain("Add someone in Connect");
  });

  it("routes through the hub's single Connect entry point", () => {
    // The same one the header's Add people button uses, so the two cannot
    // drift to different destinations.
    expect(block).toContain("onClick={onAddConnections}");
    expect(HUB).toContain(
      "onAddConnections={() => router.push(ROUTES.CONNECT)}",
    );
  });
});

describe("link 2 — Connect search offers the invite", () => {
  it("says plainly that a search matched nobody", () => {
    expect(CONNECT).toContain('No one matches "${trimmedQuery}"');
  });

  it("offers Invite them to One from that same dead end", () => {
    expect(CONNECT).toContain("Invite them to One");
    expect(CONNECT).toContain("handleInviteToOne");
    expect(CONNECT).toContain('testId="connect-invite-to-one"');
  });

  it("keeps the invite a separate offer, not a tappable statement of fact", () => {
    // "No one matches Bob" is a fact and stays inert; the invite is a choice
    // and gets its own row. Collapsing them would make the fact look like an
    // action and hide the one thing left to try.
    const anchor = CONNECT.indexOf('No one matches "${trimmedQuery}"');
    const row = CONNECT.slice(anchor, anchor + 400);
    expect(row).toContain("disabled");
  });
});

describe("the chain holds end to end", () => {
  it("lands on the tab that actually offers the invite", () => {
    // `canInviteToOne` is gated on `tab === "people"`. Arriving from the
    // People bridge onto any other tab would complete two links of the chain
    // and hide the third, which is worse than no bridge: the person would be
    // sent somewhere that looks like the same dead end.
    expect(CONNECT).toContain('useState<ConnectTab>("people")');
    expect(CONNECT).toContain('tab === "people"');
  });

  it("every link points at the next one", () => {
    // 1 -> Connect
    expect(peopleEmptyState(HUB)).toContain("Manage connections in Connect");
    expect(HUB).toContain("ROUTES.CONNECT");
    // 2 -> invite
    expect(CONNECT).toContain("Invite them to One");
    // 3 -> the invite is a real share, not a placeholder
    expect(CONNECT).toContain("buildInviteToOneShare");
  });
});
