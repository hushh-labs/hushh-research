import { describe, expect, it } from "vitest";

import {
  getPersistablePreviewCards,
  getReviewRequiredPreviewCount,
} from "@/lib/profile/pkm-agent-lab-preview";

describe("pkm agent lab preview persistence", () => {
  it("keeps confirm_first previews persistable for manual reviewed saves", () => {
    const cards = [
      { card_id: "ready", write_mode: "can_save" },
      { card_id: "review", write_mode: "confirm_first" },
      { card_id: "blocked", write_mode: "do_not_save" },
    ];

    expect(getPersistablePreviewCards(cards).map((card) => card.card_id)).toEqual([
      "ready",
      "review",
    ]);
    expect(getReviewRequiredPreviewCount(cards)).toBe(1);
  });

  it("blocks only do_not_save previews", () => {
    const cards = [{ card_id: "blocked", write_mode: "do_not_save" }];

    expect(getPersistablePreviewCards(cards)).toEqual([]);
    expect(getReviewRequiredPreviewCount(cards)).toBe(0);
  });
});
