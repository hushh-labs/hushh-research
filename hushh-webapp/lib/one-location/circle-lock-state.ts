import {
  lockActionLabel,
  resolveLockState,
  type LockState,
} from "@/lib/vault/vault-access-policy";

/**
 * The lock decision for a One Location action that needs the owner token.
 * ======================================================================
 *
 * Circles are reachable without a lock. `VaultLockGuard` renders `/one/*`
 * children on its `hasVault === false` branch (components/vault/vault-lock-guard.tsx),
 * and the entry resolver puts a signed-in account with no lock into `main_app`
 * whenever `setupCompleted` is true — which it defaults to for any account that
 * predates the journey mirror (lib/onboarding/user-entry-state.ts). So a person
 * can browse Location, open "Create a circle", type a name, and only discover at
 * the last tap that there is no owner token. Every Circle handler used to answer
 * that with a thrown string.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **A state that is not known yet is not "locked".** While auth is still
 *    resolving there is no identity to match a token against, so
 *    `vaultOwnerToken` reads null for reasons that have nothing to do with the
 *    lock (lib/vault/vault-context.tsx gates the token on
 *    `vaultUserId === currentUserId`). Deciding "locked" there would blame the
 *    user for a frame of our own bookkeeping.
 * 2. **"Locked" is an invitation, not a verdict.** The caller is expected to
 *    open the unlock sheet and resume, never to dead-end.
 */

export type OneLocationLockState =
  /** Identity is still settling. Not a decision — wait for one. */
  | "resolving"
  /** An owner token is in memory. The action may proceed. */
  | "ready"
  /** Signed in, no owner token. The action needs the unlock sheet first. */
  | "locked";

export interface OneLocationLockStateInput {
  /** `useAuth().loading` — true while the identity is still being published. */
  authLoading: boolean;
  /** `useAuth().userId` — null until an identity exists. */
  userId: string | null | undefined;
  /** `useVault().vaultOwnerToken` — memory-only, null when locked or absent. */
  vaultOwnerToken: string | null | undefined;
  /**
   * Whether this account owns a lock at all. `null` means not read yet.
   *
   * Optional so the original three-valued callers keep working unchanged. Pass
   * it and `locked` splits into two: somebody whose lock is shut, and somebody
   * who never made one. They wait in the same place and are owed different
   * words — see `resolveOneLocationLockPrompt`.
   */
  hasLock?: boolean | null;
}

export function resolveOneLocationLockState({
  authLoading,
  userId,
  vaultOwnerToken,
}: OneLocationLockStateInput): OneLocationLockState {
  // A token that is present is authority regardless of what else is settling.
  if (vaultOwnerToken) return "ready";
  // No token AND no settled identity is an unknown, not a lock. The vault
  // context withholds a perfectly good token during an identity transition, so
  // reading null here proves nothing yet.
  if (authLoading || !userId) return "resolving";
  return "locked";
}

/**
 * The words this screen owes the person, derived from the app-wide policy.
 *
 * `resolveOneLocationLockState` answers "may this action run?", which is a
 * three-valued question and stays one. It cannot answer "what do I call the
 * button?", because `locked` covers two different people:
 *
 *   - a lock exists and is shut  -> "Unlock One"
 *   - no lock was ever made      -> "Set a lock"
 *
 * The Circle sheet opened with `allowVaultCreation` precisely because the
 * common case here is the second one — `VaultLockGuard` admits an account with
 * no lock to `/one/*` — yet it still announced itself as "Unlock One", a door
 * with no key behind it. The visible copy inside the sheet was saved by
 * `VaultFlow` checking presence for itself; the accessible name was not, and
 * neither was any caller that wanted to label its own control.
 */
export function resolveOneLocationLockPrompt(
  input: OneLocationLockStateInput,
): { state: LockState; title: string; description: string } {
  const state = resolveLockState({
    hasVault: input.hasLock ?? null,
    isVaultUnlocked: Boolean(input.vaultOwnerToken),
    vaultOwnerToken: input.vaultOwnerToken,
    authLoading: input.authLoading || !input.userId,
  });

  return {
    state,
    title: lockActionLabel(state),
    description:
      state === "unconfigured"
        ? "Circles are private. Set a lock to make one."
        : "Circles are private. Unlock to make one.",
  };
}

/**
 * Thrown by a Location handler that genuinely cannot proceed without the owner
 * token. Typed so a caller can tell "you need to unlock" apart from "the server
 * said no" and offer the unlock sheet instead of a toast — the UI never has to
 * pattern-match on a message string.
 *
 * The message stays short and plain because non-UI callers (One Voice) read it
 * out verbatim.
 */
export class OneLocationLockRequiredError extends Error {
  readonly lockRequired = true as const;

  constructor(message = "Unlock One first") {
    super(message);
    this.name = "OneLocationLockRequiredError";
  }
}

export function isOneLocationLockRequiredError(
  error: unknown,
): error is OneLocationLockRequiredError {
  return (
    error instanceof OneLocationLockRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { lockRequired?: unknown }).lockRequired === true)
  );
}
