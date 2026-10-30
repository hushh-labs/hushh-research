export type PkmAgentLabPreviewWriteMode = "can_save" | "confirm_first" | "do_not_save";

export type PkmAgentLabPreviewCardLike = {
  write_mode?: string | null;
  preview_degraded?: boolean;
  validation_hints?: readonly string[] | null;
  drift_flags?: {
    fallback_used?: boolean;
  } | null;
};

/**
 * A fallback preview is a diagnostic/review artifact, not an authority to
 * write PKM. The backend also marks these cards, but the client must keep the
 * boundary fail-closed if a response is assembled from a mixed card payload.
 */
export function isDegradedPreviewCard(card: PkmAgentLabPreviewCardLike): boolean {
  return card.preview_degraded === true
    || card.drift_flags?.fallback_used === true
    || card.validation_hints?.includes("preview_generation_failed") === true;
}

export function getPersistablePreviewCards<T extends PkmAgentLabPreviewCardLike>(
  cards: readonly T[]
): T[] {
  return cards.filter(
    (card) => card.write_mode !== "do_not_save" && !isDegradedPreviewCard(card)
  );
}

export function getReviewRequiredPreviewCount(
  cards: readonly PkmAgentLabPreviewCardLike[]
): number {
  return cards.filter((card) => card.write_mode === "confirm_first").length;
}
