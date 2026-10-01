/**
 * The one path every requester surface reads information-request state through.
 *
 * Measured 2026-09-29 (localhost run 4): the requester polled one already
 * answered request 166 times in 18 minutes, two to four reads at once, because
 * the doorbell, each request card, each secure card and the access watch all
 * fetched the same bundle on their own. On a 4-connection pool that starved
 * every other read and an open never finished.
 *
 * Here:
 *   * concurrent reads of the same bundle (or the share list) share one request;
 *   * every network result is published, so a card shows what the doorbell or
 *     the access watch just read without a read of its own;
 *   * at most `CONSENT_READ_CONCURRENCY` of these reads are on the wire at once,
 *     app-wide, and a read that hangs gives its slot back after
 *     `CONSENT_READ_SLOT_TIMEOUT_MS` so a stuck request never blocks the rest.
 *
 * Nothing is retained after a read settles: this holds ledger status and
 * encrypted exports only for as long as a request is in flight, never a
 * decrypted value, and never writes to storage.
 */
import {
  PersonProfileService,
  type InformationRequestBundle,
  type SharedWithMeEntry,
} from "@/lib/services/person-profile-service";

export const CONSENT_READ_CONCURRENCY = 2;
export const CONSENT_READ_SLOT_TIMEOUT_MS = 20_000;

let generation = 0;
let active = 0;
const queue: Array<() => void> = [];

function releaseSlot(slotGeneration: number): void {
  if (slotGeneration !== generation) return;
  active = Math.max(0, active - 1);
  queue.shift()?.();
}

/** Run `task` inside the app-wide cap, first in, first out. */
function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      const slotGeneration = generation;
      active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        releaseSlot(slotGeneration);
      };
      const timer = setTimeout(release, CONSENT_READ_SLOT_TIMEOUT_MS);
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(release);
    };
    if (active < CONSENT_READ_CONCURRENCY) start();
    else queue.push(start);
  });
}

type Running<T> = { promise: Promise<T>; startedAtMs: number; token: string };

const bundleReads = new Map<string, Running<InformationRequestBundle>>();
const exportReads = new Map<string, Running<Awaited<ReturnType<typeof PersonProfileService.getInformationRequestExports>>>>();
let sharesRead: Running<SharedWithMeEntry[]> | null = null;

const bundleListeners = new Map<string, Set<(bundle: InformationRequestBundle) => void>>();
const sharesListeners = new Set<(shares: SharedWithMeEntry[]) => void>();

type JoinPolicy = {
  /** Never share a read already on the wire: a re-check after decrypting. */
  fresh?: boolean;
  /**
   * Share a read only if it started at most this long ago. A push or event
   * passes a short window so its listeners share one read, while a read that
   * started before the change is not mistaken for the answer to it.
   */
  joinWithinMs?: number;
};

function canJoin<T>(running: Running<T> | null | undefined, token: string, policy: JoinPolicy): running is Running<T> {
  if (!running || running.token !== token || policy.fresh) return false;
  if (policy.joinWithinMs === undefined) return true;
  return Date.now() - running.startedAtMs <= policy.joinWithinMs;
}

/** GET /api/one/information-requests/{bundle}, shared and capped. */
export function readInformationRequest(input: {
  bundleId: string;
  vaultOwnerToken: string;
} & JoinPolicy): Promise<InformationRequestBundle> {
  const key = input.bundleId.toLowerCase();
  const running = bundleReads.get(key);
  if (canJoin(running, input.vaultOwnerToken, input)) return running.promise;
  const readGeneration = generation;
  const promise = limited(() => PersonProfileService.getInformationRequest({
    bundleId: input.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  })).then((bundle) => {
    // An older read can finish after a fresh post-event read. Its result is
    // still returned to its own caller, but must not replace newer status on
    // every subscribed surface.
    if (readGeneration === generation && bundleReads.get(key)?.promise === promise) publishBundle(key, bundle);
    return bundle;
  }).finally(() => {
    if (bundleReads.get(key)?.promise === promise) bundleReads.delete(key);
  });
  bundleReads.set(key, { promise, startedAtMs: Date.now(), token: input.vaultOwnerToken });
  return promise;
}

/** The encrypted exports of a bundle, shared while in flight and capped. */
export function readInformationRequestExports(input: {
  bundleId: string;
  vaultOwnerToken: string;
}): ReturnType<typeof PersonProfileService.getInformationRequestExports> {
  const key = input.bundleId.toLowerCase();
  const running = exportReads.get(key);
  if (canJoin(running, input.vaultOwnerToken, {})) return running.promise;
  const promise = limited(() => PersonProfileService.getInformationRequestExports({
    bundleId: input.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  })).finally(() => {
    if (exportReads.get(key)?.promise === promise) exportReads.delete(key);
  });
  exportReads.set(key, { promise, startedAtMs: Date.now(), token: input.vaultOwnerToken });
  return promise;
}

/** GET /api/one/information-requests/shared-with-me, shared and capped. */
export function readSharedWithMe(input: { vaultOwnerToken: string } & JoinPolicy): Promise<SharedWithMeEntry[]> {
  if (canJoin(sharesRead, input.vaultOwnerToken, input)) return sharesRead.promise;
  const readGeneration = generation;
  const promise = limited(() => PersonProfileService.listSharedWithMe({ vaultOwnerToken: input.vaultOwnerToken }))
    .then((shares) => {
      if (readGeneration === generation) for (const listener of [...sharesListeners]) listener(shares);
      return shares;
    })
    .finally(() => {
      if (sharesRead?.promise === promise) sharesRead = null;
    });
  sharesRead = { promise, startedAtMs: Date.now(), token: input.vaultOwnerToken };
  return promise;
}

function publishBundle(key: string, bundle: InformationRequestBundle): void {
  for (const listener of [...(bundleListeners.get(key) ?? [])]) listener(bundle);
}

/** Every network reading of this bundle, whoever asked for it. */
export function subscribeInformationRequest(
  bundleId: string,
  listener: (bundle: InformationRequestBundle) => void,
): () => void {
  const key = bundleId.toLowerCase();
  const set = bundleListeners.get(key) ?? new Set();
  set.add(listener);
  bundleListeners.set(key, set);
  return () => {
    set.delete(listener);
    if (!set.size && bundleListeners.get(key) === set) bundleListeners.delete(key);
  };
}

/** Every network reading of the share list. */
export function subscribeSharedWithMe(listener: (shares: SharedWithMeEntry[]) => void): () => void {
  sharesListeners.add(listener);
  return () => sharesListeners.delete(listener);
}

/**
 * Forget every read on the wire and free every slot: a sign-out, or a test.
 * Reads already started still settle for their callers; they no longer count
 * against the cap or publish.
 */
export function resetInformationRequestReads(): void {
  generation += 1;
  active = 0;
  queue.length = 0;
  bundleReads.clear();
  exportReads.clear();
  sharesRead = null;
}
