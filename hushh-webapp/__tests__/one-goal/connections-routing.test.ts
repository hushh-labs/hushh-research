import { describe, expect, it } from "vitest";

import { planOneGoal } from "@/lib/one-goal/one-goal-planner";

/**
 * Regression guard for the native "One" chat client-side router.
 *
 * The native chat routes turns through planOneGoal (the client action gateway)
 * BEFORE any backend call. Connection intents must resolve to the connections
 * specialist (connections.chat.turn / agent_connections), not to RIA-marketplace
 * or CRM (connected_systems). This test pins that routing and guards the
 * neighbouring specialists so the new connection phrases don't steal their turns.
 */

function resolvedActionId(transcript: string): string {
  const plan = planOneGoal({ transcript, entrypoint: "chat" });
  // Both "ready" and "input_needed" plans carry the selected action.
  return (plan as { action?: { action_id?: string } }).action?.action_id ?? `NONE(${plan.status})`;
}

describe("planOneGoal — connections intent routing", () => {
  it.each([
    "connect me with Rohan",
    "who are my connections",
    "list my connections",
    "show my pending connection requests",
    "accept Priya's connection request",
    "decline Sam's connection request",
    "remove Alex from my connections",
  ])("routes %j to the connections specialist", (transcript) => {
    expect(resolvedActionId(transcript)).toBe("connections.chat.turn");
  });

  it("keeps the legacy trusted-connection phrasing on connections", () => {
    expect(resolvedActionId("who do I trust")).toBe("connections.chat.turn");
  });

  it("does NOT steal CRM / connected-systems turns", () => {
    expect(resolvedActionId("check my crm")).toBe("connected_systems.chat.turn");
  });

  it("does NOT steal Information Marketplace turns", () => {
    expect(resolvedActionId("show marketplace demand")).toBe(
      "marketplace.information.chat.turn"
    );
  });
});
