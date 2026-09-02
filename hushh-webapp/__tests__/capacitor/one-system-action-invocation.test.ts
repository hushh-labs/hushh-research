import { describe, expect, it } from "vitest";

import {
  ONE_SYSTEM_ACTION_IDS,
  isPendingOneSystemActionInvocation,
} from "@/lib/capacitor/one-system-action-invocation";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

const valid = {
  id: "request-1",
  kind: "execute_one_action" as const,
  source: "siri_app_intent" as const,
  actionId: "location.share_selected" as const,
  slots: {
    person: "Kushal",
    resolvedRecipientId: "contact-1",
    duration_hours: "2",
  },
  requiresVault: true,
  confirmedBySystem: true,
  createdAt: 1_000,
  expiresAt: 301_000,
};

describe("One system action invocation bridge contract", () => {
  it("accepts the bounded structured envelope", () => {
    expect(isPendingOneSystemActionInvocation(valid)).toBe(true);
  });

  it("rejects arbitrary action ids and non-string slot payloads", () => {
    expect(
      isPendingOneSystemActionInvocation({
        ...valid,
        actionId: "location.run_anything" as never,
      }),
    ).toBe(false);
    expect(
      isPendingOneSystemActionInvocation({
        ...valid,
        slots: { prompt: { arbitrary: true } } as never,
      }),
    ).toBe(false);
  });

  it("contains only generated Location action identifiers", () => {
    expect(ONE_SYSTEM_ACTION_IDS).toHaveLength(17);
    expect(
      ONE_SYSTEM_ACTION_IDS.every((actionId) =>
        actionId.startsWith("location."),
      ),
    ).toBe(true);
    expect(
      ONE_SYSTEM_ACTION_IDS.every((actionId) => getKaiActionById(actionId)),
    ).toBe(true);
  });
});
