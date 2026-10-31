import { describe, expect, it } from "vitest";

import { bucketEmailDeliveryTimelineItems } from "@/lib/agent/agent-chat-email-delivery-timeline";

describe("bucketEmailDeliveryTimelineItems", () => {
  it("keeps each delivery after the assistant response that opened it while later turns continue", () => {
    const firstDelivery = { id: "delivery-1", anchorMessageId: "assistant-1" };
    const secondDelivery = { id: "delivery-2", anchorMessageId: "assistant-2" };
    const staleDelivery = { id: "delivery-3", anchorMessageId: "missing" };

    const timeline = bucketEmailDeliveryTimelineItems(
      [firstDelivery, secondDelivery, staleDelivery],
      ["user-1", "assistant-1", "user-2", "assistant-2"],
    );

    expect(timeline.itemsAfterMessage.get("assistant-1")).toEqual([firstDelivery]);
    expect(timeline.itemsAfterMessage.get("assistant-2")).toEqual([secondDelivery]);
    expect(timeline.trailingItems).toEqual([staleDelivery]);
  });

  it("preserves the order of multiple email actions from the same prompt", () => {
    const firstDelivery = { id: "delivery-1", anchorMessageId: "assistant-1" };
    const secondDelivery = { id: "delivery-2", anchorMessageId: "assistant-1" };

    const timeline = bucketEmailDeliveryTimelineItems(
      [firstDelivery, secondDelivery],
      ["user-1", "assistant-1"],
    );

    expect(timeline.itemsAfterMessage.get("assistant-1")).toEqual([
      firstDelivery,
      secondDelivery,
    ]);
  });
});
