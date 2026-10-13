export type PkmAgentLabPreviewWriteMode = "can_save" | "confirm_first" | "do_not_save";

export type PkmAgentLabPreviewCardLike = {
  write_mode?: string | null;
};

export function getPersistablePreviewCards<T extends PkmAgentLabPreviewCardLike>(
  cards: readonly T[]
): T[] {
  return cards.filter((card) => card.write_mode !== "do_not_save");
}

export function getReviewRequiredPreviewCount(
  cards: readonly PkmAgentLabPreviewCardLike[]
): number {
  return cards.filter((card) => card.write_mode === "confirm_first").length;
}
