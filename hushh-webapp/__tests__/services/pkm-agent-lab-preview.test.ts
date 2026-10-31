import { describe, expect, it } from "vitest";
import { getPkmAgentLabPersistableCards } from "@/lib/profile/pkm-agent-lab-capture";

import {
  getPersistablePreviewCards,
  getReviewRequiredPreviewCount,
  isDegradedPreviewCard,
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

  it("blocks fallback previews even when their write mode is otherwise saveable", () => {
    const cards = [
      { card_id: "fallback-flag", write_mode: "can_save", drift_flags: { fallback_used: true } },
      { card_id: "fallback-response", write_mode: "confirm_first", preview_degraded: true },
      { card_id: "fallback-hint", write_mode: "can_save", validation_hints: ["preview_generation_failed"] },
      { card_id: "verified", write_mode: "confirm_first" },
    ];

    expect(cards.slice(0, 3).every(isDegradedPreviewCard)).toBe(true);
    expect(getPersistablePreviewCards(cards).map((card) => card.card_id)).toEqual(["verified"]);
    expect(getReviewRequiredPreviewCount(getPersistablePreviewCards(cards))).toBe(1);
  });

  it("keeps the legacy capture facade fail-closed for a degraded response", () => {
    const response = {
      agent_id: "agent",
      agent_name: "agent",
      model: "model",
      used_fallback: true,
      candidate_payload: {},
      structure_decision: {},
      preview_cards: [{
        card_id: "fallback",
        source_text: "synthetic",
        write_mode: "can_save",
      }],
    };

    expect(getPkmAgentLabPersistableCards(response)).toEqual([]);
  });
});
