/** Serialize session authority per owner; Web Locks also covers sibling tabs. */
const pending = new Map<string, Promise<unknown>>();

export function withOwnerPodSessionLock<T>(owner: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(owner) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(`hushh-owner-pod-session:${owner}`, operation);
    }
    return operation();
  });
  pending.set(owner, next);
  void next.finally(() => {
    if (pending.get(owner) === next) pending.delete(owner);
  }).catch(() => undefined);
  return next;
}
