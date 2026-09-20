import type { OneLocationMapPreferences } from "@/lib/one-location/types";

const inFlightByUser = new Map<
  string,
  { revision: number; request: Promise<OneLocationMapPreferences> }
>();
const revisionByUser = new Map<string, number>();
const presentationByUser = new Map<string, OneLocationMapPreferences>();
const invalidationEvents = new Set<string>();

function revisionFor(userId: string): number {
  return revisionByUser.get(userId) ?? 0;
}

/** Memory-only, account-scoped authority for Map visibility and consent. */
export const OneLocationMapPreferencesResource = {
  readPresentation(userId: string): OneLocationMapPreferences | null {
    return presentationByUser.get(userId) ?? null;
  },

  write(userId: string, value: OneLocationMapPreferences): void {
    presentationByUser.set(userId, value);
  },

  load(
    userId: string,
    loader: () => Promise<OneLocationMapPreferences>,
  ): Promise<OneLocationMapPreferences> {
    const revision = revisionFor(userId);
    const current = inFlightByUser.get(userId);
    if (current?.revision === revision) return current.request;
    const request = loader()
      .then((value) => {
        if (revisionFor(userId) === revision) this.write(userId, value);
        return value;
      })
      .finally(() => {
        if (inFlightByUser.get(userId)?.request === request) {
          inFlightByUser.delete(userId);
        }
      });
    inFlightByUser.set(userId, { revision, request });
    return request;
  },

  invalidate(userId: string): void {
    revisionByUser.set(userId, revisionFor(userId) + 1);
    inFlightByUser.delete(userId);
  },

  invalidateFromEvent(userId: string, eventKey: string): void {
    const key = `${userId}:${eventKey}`;
    if (invalidationEvents.has(key)) return;
    invalidationEvents.add(key);
    if (invalidationEvents.size > 128) {
      const oldest = invalidationEvents.values().next().value;
      if (oldest) invalidationEvents.delete(oldest);
    }
    this.invalidate(userId);
  },

  commit(userId: string, value: OneLocationMapPreferences): void {
    this.invalidate(userId);
    this.write(userId, value);
  },

  discard(userId: string): void {
    this.invalidate(userId);
    presentationByUser.delete(userId);
  },
};
