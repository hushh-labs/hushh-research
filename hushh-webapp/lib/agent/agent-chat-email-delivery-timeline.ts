/**
 * Places session-only email delivery activity beside the user turn that
 * started it. Email drafts are deliberately not persisted with chat history,
 * so this only orders live workspace state.
 */
export type AnchoredEmailDeliveryTimelineItem = {
  anchorMessageId: string | null;
};

export type EmailDeliveryTimelineBuckets<T> = {
  itemsAfterMessage: ReadonlyMap<string, readonly T[]>;
  trailingItems: readonly T[];
};

export function bucketEmailDeliveryTimelineItems<
  T extends AnchoredEmailDeliveryTimelineItem,
>(
  items: readonly T[],
  visibleMessageIds: readonly string[],
): EmailDeliveryTimelineBuckets<T> {
  const visibleIds = new Set(visibleMessageIds);
  const itemsAfterMessage = new Map<string, T[]>();
  const trailingItems: T[] = [];

  for (const item of items) {
    if (!item.anchorMessageId || !visibleIds.has(item.anchorMessageId)) {
      trailingItems.push(item);
      continue;
    }

    const anchoredItems = itemsAfterMessage.get(item.anchorMessageId) ?? [];
    anchoredItems.push(item);
    itemsAfterMessage.set(item.anchorMessageId, anchoredItems);
  }

  return { itemsAfterMessage, trailingItems };
}
