/** Maximum existing connections accepted by one Circle invite mutation. */
export const CIRCLE_INVITE_BATCH_LIMIT = 20;

/**
 * Keep every Circle picker aligned with both the mutation batch contract and
 * the Circle's remaining membership capacity.
 */
export function circleInviteSelectionLimit(remainingCapacity: number): number {
  if (!Number.isFinite(remainingCapacity)) return 0;
  return Math.min(
    CIRCLE_INVITE_BATCH_LIMIT,
    Math.max(0, Math.floor(remainingCapacity)),
  );
}
