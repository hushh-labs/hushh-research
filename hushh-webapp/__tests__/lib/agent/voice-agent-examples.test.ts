import { describe, expect, it } from "vitest";

import { VOICE_AGENT_EXAMPLE_GROUPS } from "@/lib/agent/voice-agent-examples";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

/**
 * The durable fix for #6308: the "What can I say" page taught four phrases
 * that could not execute (Gmail connect/sync, KYC status/approve) because
 * their actions were unwired. This is what makes that class of rot fail
 * loudly instead of sitting there until someone notices by hand.
 */
describe("voice-agent-examples actionId guard", () => {
  for (const group of VOICE_AGENT_EXAMPLE_GROUPS) {
    for (const example of group.examples) {
      it(`"${example.phrase}" (${group.key}) maps to a runnable action`, () => {
        const action = getKaiActionById(example.actionId);
        expect(
          action,
          `actionId "${example.actionId}" is not in the generated action gateway`,
        ).not.toBeNull();
        expect(
          action?.execution_target.status,
          `${example.actionId} must be wired to execute the phrase it teaches`,
        ).toBe("wired");
        expect(
          action?.execution_policy,
          `${example.actionId} is manual_only -- One can only point at it, not do it, so it cannot be taught as something you can say`,
        ).not.toBe("manual_only");
      });
    }
  }
});
