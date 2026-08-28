import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

/**
 * The 12 alias collisions seeded into KNOWN_ALIAS_COLLISIONS when the
 * collision guard was introduced (#6081-#6085) -- each one a literal,
 * identical alias string declared by BOTH sides of a pair, so an exact
 * spoken match could not resolve to one action. All are now retired by
 * removing the alias from whichever side had the weaker claim.
 *
 * These tests pin the winner AND the loser for each phrase: asserting only
 * that the collision is gone would also pass if a later edit removed the
 * alias from both sides, which would silently make the phrase unreachable.
 */

function aliases(actionId: string): string[] {
  const action = getKaiActionById(actionId);
  expect(action, `${actionId} is not in the gateway`).not.toBeNull();
  return (action?.aliases ?? []).map((alias) => alias.toLowerCase());
}

function expectOwnedBy(alias: string, winner: string, loser: string) {
  expect(aliases(winner), `${winner} should own "${alias}"`).toContain(alias);
  expect(aliases(loser), `${loser} should no longer claim "${alias}"`).not.toContain(alias);
}

describe("Connect's generic phrases resolve to the global nav action", () => {
  // Both open /one/connect, so either was "correct" -- but route.one_connect
  // is in GLOBAL_NAV_ACTION_IDS and therefore offered from every screen,
  // while location.add_connections is only reachable from Location's own
  // "you have no connections" dead end.
  it.each(["add people", "connect with someone", "find people"])(
    '"%s" belongs to route.one_connect, not location.add_connections',
    (alias) => {
      expectOwnedBy(alias, "route.one_connect", "location.add_connections");
    },
  );

  it("location.add_connections keeps its own dead-end phrasing", () => {
    expect(aliases("location.add_connections")).toContain("i have no connections");
    expect(aliases("location.add_connections")).toContain("no one to share with");
  });
});

describe('"my connections" names the People tab, not Connect generally', () => {
  it("belongs to connect.open_people, not route.one_connect", () => {
    expectOwnedBy("my connections", "connect.open_people", "route.one_connect");
  });
});

describe("vault setup phrases point at the vault screen itself", () => {
  it.each(["finish setting up", "set up my vault"])(
    '"%s" belongs to vault.setup_open, not setup.hub_master_ack',
    (alias) => {
      expectOwnedBy(alias, "vault.setup_open", "setup.hub_master_ack");
    },
  );

  it("setup.hub_master_ack keeps its own unambiguous primaries", () => {
    expect(aliases("setup.hub_master_ack")).toContain("finish setup");
    expect(aliases("setup.hub_master_ack")).toContain("i'm done setting up");
  });
});

describe('"open analysis history" belongs to the direct route', () => {
  it("resolves to route.analysis_history, not the in-flow back control", () => {
    expectOwnedBy(
      "open analysis history",
      "route.analysis_history",
      "analysis.back_to_history",
    );
  });

  it("analysis.back_to_history keeps its own phrasing", () => {
    expect(aliases("analysis.back_to_history")).toContain("back to history");
  });
});

describe('"open ria workspace" belongs to the real home, not the compat route', () => {
  it("resolves to route.ria_home", () => {
    expectOwnedBy("open ria workspace", "route.ria_home", "route.ria_workspace_compat");
  });

  it("the compat route keeps its explicit legacy aliases", () => {
    expect(aliases("route.ria_workspace_compat")).toContain("open legacy ria workspace");
    expect(aliases("route.ria_workspace_compat")).toContain("open client workspace link");
  });
});

describe("a bare, direct Location phrase beats the conversational catch-all", () => {
  // location.chat.turn delegates to the Location specialist for open-ended
  // Q&A. When a phrase names a decisive action outright, that action has to
  // win -- the same reasoning as #6081, where a bare "stop sharing" opened a
  // list instead of stopping anything.
  it.each([
    ["stop sharing my location", "location.pause_updates"],
    ["who can see me right now", "location.open_active_shares"],
    ["who can see my location", "location.open_people"],
  ])('"%s" belongs to %s, not location.chat.turn', (alias, winner) => {
    expectOwnedBy(alias, winner, "location.chat.turn");
  });

  it("location.chat.turn keeps its open-ended conversational aliases", () => {
    // Removing the three direct phrases must not have gutted the action --
    // it still needs to catch the questions it exists for.
    expect(aliases("location.chat.turn")).toEqual(
      expect.arrayContaining([
        "show who can see me",
        "start sharing my location",
        "share my location with",
        "where am i",
        "check in here",
      ]),
    );
  });
});

describe('"not now" is not owned by any single setup skip step', () => {
  // All seven setup.skip_* actions declared it. Pairwise detection only
  // flagged calendar/gmail, but a generic dismissal word no single one of
  // seven peers can claim is ambiguous wherever two are reachable at once --
  // and skip_calendar and skip_gmail both list the "one_setup" hub screen.
  const SKIP_ACTIONS = [
    "setup.skip_calendar",
    "setup.skip_connected_systems",
    "setup.skip_email",
    "setup.skip_finance",
    "setup.skip_gmail",
    "setup.skip_location",
    "setup.skip_ria",
  ];

  it.each(SKIP_ACTIONS)("%s no longer claims the bare phrase", (actionId) => {
    expect(aliases(actionId)).not.toContain("not now");
  });

  it("every skip step still has its own specific phrasing", () => {
    // Nothing became unreachable: each still answers to a phrase that names
    // the thing being skipped.
    for (const actionId of SKIP_ACTIONS) {
      const own = aliases(actionId).filter((alias) => alias.startsWith("skip "));
      expect(own.length, `${actionId} lost all of its specific aliases`).toBeGreaterThan(0);
    }
  });
});
