import { describe, expect, it } from "vitest";

import {
  KAI_ACTION_GATEWAY_ACTIONS,
  KAI_PREDICATE_INDEX,
} from "@/lib/voice/kai-action-gateway";
import type { KaiActionDefinition } from "@/lib/voice/kai-action-gateway";

const RELATIONS = ["requires", "establishes", "advances"] as const;

function refsOf(action: KaiActionDefinition, relation: (typeof RELATIONS)[number]) {
  return action[relation];
}

function actionById(actionId: string): KaiActionDefinition {
  const action = KAI_ACTION_GATEWAY_ACTIONS.find(
    (entry) => entry.action_id === actionId,
  );
  if (!action) throw new Error(`missing action ${actionId}`);
  return action;
}

describe("predicate vocabulary", () => {
  it("resolves every predicate reference against the generated index", () => {
    const unknown: string[] = [];
    for (const action of KAI_ACTION_GATEWAY_ACTIONS) {
      for (const relation of RELATIONS) {
        for (const ref of refsOf(action, relation)) {
          if (!KAI_PREDICATE_INDEX[ref.predicate]) {
            unknown.push(`${action.action_id}.${relation} -> ${ref.predicate}`);
          }
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("grounds arity-1 facts on a slot the action can actually resolve", () => {
    const problems: string[] = [];
    for (const action of KAI_ACTION_GATEWAY_ACTIONS) {
      const slots = action.goal?.slot_schema || {};
      for (const relation of RELATIONS) {
        for (const ref of refsOf(action, relation)) {
          const spec = KAI_PREDICATE_INDEX[ref.predicate];
          if (!spec) continue;
          if (spec.arity === 0 && ref.entity_slot) {
            problems.push(
              `${action.action_id}.${relation}: ${ref.predicate} takes no entity`,
            );
          }
          if (spec.arity === 1 && !ref.entity_slot) {
            problems.push(
              `${action.action_id}.${relation}: ${ref.predicate} needs an entity`,
            );
          }
          if (ref.entity_slot && !(ref.entity_slot in slots)) {
            problems.push(
              `${action.action_id}.${relation}: ${ref.predicate} grounded on unknown slot ${ref.entity_slot}`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  // The rule the whole design rests on. An action may only claim to complete a
  // fact it can actually complete; anything another party settles is advanced,
  // never established.
  it("never lets an action establish a fact it cannot settle", () => {
    const violations: string[] = [];
    for (const action of KAI_ACTION_GATEWAY_ACTIONS) {
      for (const ref of action.establishes) {
        const spec = KAI_PREDICATE_INDEX[ref.predicate];
        if (spec && spec.settlement !== "agent") {
          violations.push(
            `${action.action_id} establishes ${ref.predicate} (${spec.settlement})`,
          );
        }
      }
      for (const ref of action.advances) {
        const spec = KAI_PREDICATE_INDEX[ref.predicate];
        if (spec && spec.settlement !== "external") {
          violations.push(
            `${action.action_id} advances ${ref.predicate} (${spec.settlement})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the derived index consistent with the actions it was built from", () => {
    for (const [name, entry] of Object.entries(KAI_PREDICATE_INDEX)) {
      const established = KAI_ACTION_GATEWAY_ACTIONS.filter((action) =>
        action.establishes.some((ref) => ref.predicate === name),
      ).map((action) => action.action_id);
      const required = KAI_ACTION_GATEWAY_ACTIONS.filter((action) =>
        action.requires.some((ref) => ref.predicate === name),
      ).map((action) => action.action_id);
      expect(entry.established_by).toEqual([...established].sort());
      expect(entry.required_by).toEqual([...required].sort());
    }
  });
});

describe("the connection edge", () => {
  it("sends a request without claiming it makes anyone a connection", () => {
    const sendRequest = actionById("connect.send_request");
    expect(sendRequest.establishes).toEqual([
      { predicate: "connection_pending", entity_slot: "person" },
    ]);
    expect(
      sendRequest.establishes.some((ref) => ref.predicate === "connected_to"),
    ).toBe(false);
  });

  it("treats being connected as something only the other person can settle", () => {
    expect(KAI_PREDICATE_INDEX.connected_to.settlement).toBe("external");
    expect(KAI_PREDICATE_INDEX.connected_to.established_by).toEqual([]);
  });

  it("still offers a way forward when someone is blocked on it", () => {
    expect(KAI_PREDICATE_INDEX.connected_to.advanced_by).toContain(
      "connect.send_request",
    );
  });

  it("blocks picking a share recipient on being connected to them", () => {
    const select = actionById("location.select_share_recipient");
    expect(select.requires).toContainEqual({
      predicate: "connected_to",
      entity_slot: "person",
    });
    expect(select.establishes).toContainEqual({
      predicate: "share_recipient_selected",
      entity_slot: null,
    });
  });

  it("blocks sending a share until somebody is picked", () => {
    expect(actionById("location.share_selected").requires).toContainEqual({
      predicate: "share_recipient_selected",
      entity_slot: null,
    });
  });
});
