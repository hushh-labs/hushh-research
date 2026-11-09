"use client";

import { SecureResourceCacheService } from "./secure-resource-cache-service";
import { SecureDurableResourceService } from "./secure-durable-resource-service";
import { DIRECT_MESSAGE_MAX_LENGTH } from "@/lib/direct-messages/limits";

const PREFIX = "messages-draft:v1:";
const TTL = 7 * 24 * 60 * 60_000;
type Session = { userId: string; epoch: object };
type Draft = { version: 1; text: string; binding: string | null; userId: string; scope: string };
const epochs = new Map<string, object>();
const sessions = new WeakMap<object, Session>();
const queues = new Map<string, Promise<void>>();
const revisions = new Map<string, Map<string, object>>();
const blocked = new Set<string>();
const purgeMarker = (owner: string) => `messages-draft-purge:v1:${owner}`;
function needsPurge(owner: string): boolean {
  try { return typeof window !== "undefined" && window.localStorage.getItem(purgeMarker(owner)) === "1"; }
  catch { return true; }
}
function scopeRevision(owner: string, scope: string, next?: object): object | undefined {
  if (!revisions.has(owner)) revisions.set(owner, new Map());
  if (next) revisions.get(owner)!.set(scope, next);
  return revisions.get(owner)!.get(scope);
}
export class MessageDraftSessionExpiredError extends Error {
  constructor() { super("Your message draft changed. Reload One and review it before sending."); }
}
const resource = (scope: string) => PREFIX + scope;
const current = (session: Session) => epochs.get(session.userId) === session.epoch;

function enqueue<T>(owner: string, operation: () => Promise<T>): Promise<T> {
  const result = (queues.get(owner) ?? Promise.resolve()).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  queues.set(owner, settled);
  void settled.then(() => { if (queues.get(owner) === settled) queues.delete(owner); });
  return result;
}

/** Unsent text only. Never stores keys, attachments, reply bodies or send authority. */
export class MessagesDraftService {
  static session(userId: string): Session {
    if (!epochs.has(userId)) {
      epochs.set(userId, {});
      if (needsPurge(userId)) void this.clearForUser(userId).catch(() => undefined);
    }
    const epoch = epochs.get(userId)!;
    if (!sessions.has(epoch)) sessions.set(epoch, { userId, epoch });
    return sessions.get(epoch)!;
  }

  static isCurrent(session: Session): boolean { return current(session) && !blocked.has(session.userId); }

  static read(session: Session, scope: string, vaultKey: string, binding: string | null): Promise<string | null> {
    return enqueue(session.userId, async () => {
      if (!this.isCurrent(session)) return null;
      const draft = await SecureResourceCacheService.read<Draft>({ userId: session.userId, resourceKey: resource(scope), vaultKey });
      if (!this.isCurrent(session) || !draft) return null;
      if (draft.version !== 1 || draft.userId !== session.userId || draft.scope !== scope || draft.binding !== binding
          || typeof draft.text !== "string" || draft.text.length > DIRECT_MESSAGE_MAX_LENGTH) {
        await SecureResourceCacheService.invalidateResourceRequired(session.userId, resource(scope));
        return null;
      }
      return draft.text;
    });
  }

  static write(session: Session, scope: string, vaultKey: string, text: string, binding: string | null, expectedRevision?: object): Promise<boolean> {
    if (!current(session) || text.length > DIRECT_MESSAGE_MAX_LENGTH
        || expectedRevision && scopeRevision(session.userId, scope) !== expectedRevision) return Promise.resolve(false);
    const revision = {};
    scopeRevision(session.userId, scope, revision);
    // Capture Reset's generation at submission, not after queued encryption.
    const version = SecureDurableResourceService.version(session.userId, resource(scope)).catch(() => null);
    return enqueue(session.userId, async () => {
      const admitted = await version;
      if (!admitted || !this.isCurrent(session) || scopeRevision(session.userId, scope) !== revision) return false;
      if (!text) {
        await SecureResourceCacheService.invalidateResourceRequired(session.userId, resource(scope));
        return true;
      }
      await SecureResourceCacheService.writeRequired<Draft>({ userId: session.userId, resourceKey: resource(scope),
        vaultKey, value: { version: 1, text, binding, userId: session.userId, scope }, ttlMs: TTL, ownerGeneration: admitted.generation });
      return this.isCurrent(session) && scopeRevision(session.userId, scope) === revision;
    });
  }

  /** Must settle before POST: an uncertain send must never become a fresh draft. */
  static remove(session: Session, scope: string): Promise<object> {
    const revision = {};
    if (current(session)) scopeRevision(session.userId, scope, revision);
    return enqueue(session.userId, async () => {
      const unchanged = () => this.isCurrent(session) && scopeRevision(session.userId, scope) === revision;
      if (!unchanged()) throw new MessageDraftSessionExpiredError();
      await SecureResourceCacheService.invalidateResourceRequired(session.userId, resource(scope));
      if (!unchanged()) throw new MessageDraftSessionExpiredError();
      return revision;
    });
  }

  static lock(userId: string): void { epochs.set(userId, {}); }

  static clearForUser(userId: string): Promise<void> {
    this.lock(userId);
    revisions.delete(userId);
    blocked.add(userId);
    try { window.localStorage.setItem(purgeMarker(userId), "1"); } catch { /* Recovery stays blocked until purge succeeds. */ }
    // Purge follows outstanding writes; future reads join the same queue.
    return enqueue(userId, async () => {
      await SecureResourceCacheService.invalidateResourcePrefixRequired(userId, PREFIX);
      try { window.localStorage.removeItem(purgeMarker(userId)); } catch { /* Only a metadata retry marker remains. */ }
      blocked.delete(userId);
    });
  }

  static clearAll(): void { for (const owner of epochs.keys()) void this.clearForUser(owner).catch(() => undefined); }
}
