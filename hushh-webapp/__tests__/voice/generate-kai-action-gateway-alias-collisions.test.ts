import { describe, expect, it } from "vitest";

import {
  GLOBAL_NAV_ACTION_IDS,
  KNOWN_ALIAS_COLLISIONS,
  validateAliasCollisions,
  // eslint-disable-next-line import/extensions -- this is a script, not a lib module
} from "../../scripts/voice/generate-kai-action-gateway.mjs";

type FixtureAction = {
  action_id: string;
  surface_id: string;
  aliases: string[];
  execution_target: { status: "wired" | "unwired" };
  reachability: { screens: string[] };
};

function action(overrides: Partial<FixtureAction> & { action_id: string }): FixtureAction {
  return {
    surface_id: "test_surface",
    aliases: [],
    execution_target: { status: "wired" },
    reachability: { screens: [] },
    ...overrides,
  };
}

describe("validateAliasCollisions", () => {
  it("throws when two wired actions on the same surface share an alias", () => {
    const actions = [
      action({ action_id: "test.a", aliases: ["do the thing"] }),
      action({ action_id: "test.b", aliases: ["do the thing"] }),
    ];
    expect(() => validateAliasCollisions(actions)).toThrow(/do the thing.*test\.a.*test\.b/s);
  });

  it("does not throw when the shared alias only appears on one action", () => {
    const actions = [
      action({ action_id: "test.a", aliases: ["do the thing"] }),
      action({ action_id: "test.b", aliases: ["do something else"] }),
    ];
    expect(() => validateAliasCollisions(actions)).not.toThrow();
  });

  it("does not throw for two actions on different surfaces with no reachable-screen overlap", () => {
    const actions = [
      action({ action_id: "test.a", surface_id: "surface_a", aliases: ["shared phrase"], reachability: { screens: ["screen_a"] } }),
      action({ action_id: "test.b", surface_id: "surface_b", aliases: ["shared phrase"], reachability: { screens: ["screen_b"] } }),
    ];
    expect(() => validateAliasCollisions(actions)).not.toThrow();
  });

  it("throws when two actions on different surfaces share a reachable screen", () => {
    const actions = [
      action({ action_id: "test.a", surface_id: "surface_a", aliases: ["shared phrase"], reachability: { screens: ["shared_screen"] } }),
      action({ action_id: "test.b", surface_id: "surface_b", aliases: ["shared phrase"], reachability: { screens: ["shared_screen", "other_screen"] } }),
    ];
    expect(() => validateAliasCollisions(actions)).toThrow(/shared phrase/);
  });

  it("throws when one side of the collision is a global-nav action, regardless of screen", () => {
    const navId = [...GLOBAL_NAV_ACTION_IDS][0] as string;
    const actions = [
      action({ action_id: navId, surface_id: "nav_surface", aliases: ["shared phrase"], reachability: { screens: ["nav_screen"] } }),
      action({ action_id: "test.b", surface_id: "unrelated_surface", aliases: ["shared phrase"], reachability: { screens: ["unrelated_screen"] } }),
    ];
    expect(() => validateAliasCollisions(actions)).toThrow(/shared phrase/);
  });

  it("ignores unwired actions entirely", () => {
    const actions = [
      action({ action_id: "test.a", aliases: ["do the thing"], execution_target: { status: "unwired" } }),
      action({ action_id: "test.b", aliases: ["do the thing"] }),
    ];
    expect(() => validateAliasCollisions(actions)).not.toThrow();
  });

  it("does not throw for a pair explicitly listed in KNOWN_ALIAS_COLLISIONS", () => {
    expect(KNOWN_ALIAS_COLLISIONS.size).toBeGreaterThan(0);
    const [firstKey] = KNOWN_ALIAS_COLLISIONS;
    const [alias, first, second] = (firstKey as string).split("::");
    const actions = [
      action({ action_id: first as string, surface_id: "shared_surface", aliases: [alias as string] }),
      action({ action_id: second as string, surface_id: "shared_surface", aliases: [alias as string] }),
    ];
    expect(() => validateAliasCollisions(actions)).not.toThrow();
  });

  it("is case-insensitive when comparing aliases", () => {
    const actions = [
      action({ action_id: "test.a", aliases: ["Do The Thing"] }),
      action({ action_id: "test.b", aliases: ["do the thing"] }),
    ];
    expect(() => validateAliasCollisions(actions)).toThrow(/do the thing/);
  });
});
