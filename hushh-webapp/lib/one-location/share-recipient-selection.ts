import type { OneLocationRecipient } from "@/lib/one-location/types";

export function recipientSelectionFromIds(
  recipients: OneLocationRecipient[],
  selectedIds: string[],
): OneLocationRecipient[] {
  const recipientById = new Map(
    recipients.map((recipient) => [recipient.userId, recipient]),
  );
  return selectedIds
    .map((recipientId) => recipientById.get(recipientId))
    .filter((recipient): recipient is OneLocationRecipient => Boolean(recipient));
}

export type ShareReadyRecipient = OneLocationRecipient & {
  keyId: string;
  publicKeyJwk: JsonWebKey;
};

export function isShareReadyRecipient(
  recipient: OneLocationRecipient,
): recipient is ShareReadyRecipient {
  return Boolean(
    recipient.canReceiveLocation && recipient.keyId && recipient.publicKeyJwk,
  );
}

/**
 * The recipient list a share should actually act on, reconstructed from the
 * synchronous selection cursor.
 *
 * Voice can pick someone and immediately say "share" in the same breath --
 * faster than the render that would make the pick visible in the reactive
 * selection, a value React has not recomputed yet. `fallbackSelectedIds` is
 * expected to come from a ref that a selection hook updates synchronously,
 * ahead of that render (see `useShareRecipientSelectionState` in
 * `app/one/location/page.tsx`), so it still has the answer when the reactive
 * list does not yet.
 *
 * The cursor is authoritative even when React's rendered selection is already
 * non-empty. Otherwise adding or removing one person while a Circle is present
 * and immediately sharing can act on the previous render's audience.
 */
export function resolveEffectiveShareRecipients(
  pool: readonly OneLocationRecipient[],
  currentSelectedIds: readonly string[],
): OneLocationRecipient[] {
  return recipientSelectionFromIds([...pool], [...currentSelectedIds]);
}
