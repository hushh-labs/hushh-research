export type SetupCapabilityGroups<T> = {
  remaining: T[];
  complete: T[];
  visible: T[];
};

/**
 * Preserve authored order within each status group while keeping remaining
 * work ahead of completed work. The returned visible order is also the order
 * published to Morphy AX, so voice never reasons from a different layer than
 * the person sees.
 */
export function groupSetupCapabilities<T>(
  items: readonly T[],
  isComplete: (item: T) => boolean,
): SetupCapabilityGroups<T> {
  const remaining: T[] = [];
  const complete: T[] = [];
  for (const item of items) {
    (isComplete(item) ? complete : remaining).push(item);
  }
  return { remaining, complete, visible: [...remaining, ...complete] };
}
