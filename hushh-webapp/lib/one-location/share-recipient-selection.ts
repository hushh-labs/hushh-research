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
 * The recipient list a share should actually act on, given both the
 * reactive selection React has rendered and a same-tick-fresh fallback.
 *
 * Voice can pick someone and immediately say "share" in the same breath --
 * faster than the render that would make the pick visible in the reactive
 * selection, a value React has not recomputed yet. `fallbackSelectedIds` is
 * expected to come from a ref that a selection hook updates synchronously,
 * ahead of that render (see `useShareRecipientSelectionState` in
 * `app/one/location/page.tsx`), so it still has the answer when the reactive
 * list does not yet.
 *
 * A tap-driven Share never needs the fallback: a render has long since
 * happened by the time a human can tap, so `reactiveSelection` is never
 * empty for a real "nobody picked" case where a person is standing there.
 * That is also why an empty `reactiveSelection` is trusted here rather than
 * cross-checked -- there is no way to tell "genuinely nobody selected" apart
 * from "selected too recently to have rendered" except by wall-clock timing
 * this function deliberately does not have, so it always prefers the fresher
 * of the two sources instead of guessing which case it is in.
 */
export function resolveEffectiveShareRecipients(
  reactiveSelection: readonly OneLocationRecipient[],
  pool: readonly OneLocationRecipient[],
  fallbackSelectedIds: readonly string[],
): OneLocationRecipient[] {
  if (reactiveSelection.length) return [...reactiveSelection];
  return recipientSelectionFromIds([...pool], [...fallbackSelectedIds]);
}
