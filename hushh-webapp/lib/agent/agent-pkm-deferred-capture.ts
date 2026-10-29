import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
  type AuthSessionOwnerSnapshot,
} from "@/lib/auth/session-owner";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

/**
 * A typed turn whose ambient memory capture waited because memory.md could not
 * be read: capture reconciles against memory.md, so it runs after the next
 * successful read instead of dropping a correction. Session RAM only, at most
 * a few turns, and never across an owner change or a new vault session.
 */
export type DeferredAgentPkmCapture = Readonly<{
  turnId: string;
  assistantMessageId: string;
  sourceMessage: string;
}>;

const MAX_DEFERRED_CAPTURES = 5;
const deferred: { owner: AuthSessionOwnerSnapshot; capture: DeferredAgentPkmCapture }[] = [];
let stopWatchingVault: (() => void) | null = null;

export function clearDeferredAgentPkmCaptures(): void {
  deferred.length = 0;
  stopWatchingVault?.();
  stopWatchingVault = null;
}

export function deferAgentPkmCapture(capture: DeferredAgentPkmCapture): void {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner) return;
  // Lock, unlock, rotation and renewal all advance the epoch; deferred text never outlives it.
  stopWatchingVault ??= subscribeVaultSessionEpoch(clearDeferredAgentPkmCaptures);
  deferred.push({ owner, capture });
  if (deferred.length > MAX_DEFERRED_CAPTURES) deferred.shift();
}

/** The current owner's deferred turns, oldest first; the queue is emptied either way. */
export function takeDeferredAgentPkmCaptures(userId: string): DeferredAgentPkmCapture[] {
  const taken = deferred.filter(({ owner }) =>
    owner.userId === userId && isValidatedAuthSessionOwnerCurrent(owner));
  clearDeferredAgentPkmCaptures();
  return taken.map(({ capture }) => capture);
}
