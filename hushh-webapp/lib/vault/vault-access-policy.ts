"use client";

/**
 * The one answer to "can this person use a locked feature right now?"
 * ====================================================================
 *
 * Five states, and they are not interchangeable:
 *
 *   loading       nothing is known yet — wait, do not paint a destination
 *   unconfigured  no lock exists       — offer "Set a lock"
 *   locked        a lock exists, shut  — offer "Unlock One"
 *   unlocked      a key is in memory   — proceed, show no credential surface
 *   error         presence could not be read — say so and offer a retry
 *
 * Why the five-state version had to be added here
 * -----------------------------------------------
 * This module already modelled four of them, as a bag of booleans
 * (`vaultUnknown` / `needsVaultCreation` / `needsUnlock` / `canReadSecureData`).
 * A bag is not a decision: a caller picks the one boolean it happens to know
 * about and silently inherits whatever the others meant. Three screens use this
 * file today and all three get the answer wrong the same way — they hand it a
 * `hasVault: false` that was manufactured in a `catch` block or during auth
 * restore, and the bag faithfully reports `needsVaultCreation`, so somebody who
 * owns a lock is offered first-run lock CREATION.
 *
 * The rest of the app never got here at all. `VaultContextType` exposes exactly
 * one boolean about state — `isVaultUnlocked` — so a consumer holding only
 * `useVault()` is structurally incapable of telling the three "no token" cases
 * apart:
 *
 *   - no token because there is no lock          (unconfigured)
 *   - no token because the lock is shut          (locked)
 *   - no token because auth has not settled yet  (loading)
 *
 * That collapse produces both reported symptoms. A person with no lock is told
 * to "Unlock One" — a door with no key behind it. A person who is merely locked
 * is offered first-run lock setup, as if the lock they already own did not
 * exist. `isVaultUnlocked` is also `false` on every single mount, which is the
 * flash: whatever a screen renders for "false" appears for a frame before
 * anything has been read.
 *
 * The rules
 * ---------
 * 1. **A key in memory is authority and nothing outranks it.** It is proof the
 *    lock is open right now. Every other input describes the past.
 * 2. **Unknown is not false.** `hasVault === null` means "not read yet" and
 *    resolves to `loading`, never `unconfigured`. Offering setup to somebody
 *    who owns a lock is the exact regression this module exists to prevent.
 * 3. **A failed read is not an absent lock.** Pass `presenceFailed` and the
 *    answer is `error`, so the caller says so and offers a retry instead of
 *    quietly downgrading the person to a new user.
 * 4. **No settled identity, no verdict.** The vault context withholds a
 *    perfectly good token while `vaultUserId !== currentUserId`
 *    (lib/vault/vault-context.tsx), so a null token during an identity
 *    transition proves nothing. Pass `authLoading` and it resolves to
 *    `loading`.
 *
 * Pure by design: no React, no network, no storage, no clock. Everything
 * arrives as an argument, so every transition is directly testable.
 */

export type VaultCapabilityState = {
  hasVaultKey: boolean;
  hasVaultOwnerToken: boolean;
  isUnlocked: boolean;
  canReadSecureData: boolean;
  canMutateSecureData: boolean;
};

/**
 * The mutually exclusive states of the lock. Exactly one is ever true.
 *
 * Prefer switching on this over reading the individual booleans below. Those
 * remain for the narrow questions that are genuinely about capability ("may I
 * decrypt right now?") rather than about which screen to show.
 */
export type LockState =
  /** Not enough is known. Wait — never guess a destination or a label. */
  | "loading"
  /** No lock has ever been made. The next step is to create one. */
  | "unconfigured"
  /** A lock exists and is shut. The next step is to open it. */
  | "locked"
  /** A key is in memory. The action may proceed with no credential surface. */
  | "unlocked"
  /** Presence could not be resolved. Report it; never read it as "no lock". */
  | "error";

export type VaultAvailabilityState = VaultCapabilityState & {
  /** The one decision. Switch on this. */
  state: LockState;
  hasVault: boolean;
  /** `state === "loading"`. */
  vaultUnknown: boolean;
  /** `state === "unconfigured"`. Never true for a failed or unsettled read. */
  needsVaultCreation: boolean;
  /** `state === "locked"`. */
  needsUnlock: boolean;
  /** `state === "error"`. */
  vaultCheckFailed: boolean;
};

export function resolveVaultCapabilityState(params: {
  isVaultUnlocked: boolean;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
}): VaultCapabilityState {
  const hasVaultKey =
    typeof params.vaultKey === "string" && params.vaultKey.trim().length > 0;
  const hasVaultOwnerToken =
    typeof params.vaultOwnerToken === "string" &&
    params.vaultOwnerToken.trim().length > 0;
  const isUnlocked = Boolean(params.isVaultUnlocked);

  return {
    hasVaultKey,
    hasVaultOwnerToken,
    isUnlocked,
    canReadSecureData: hasVaultOwnerToken,
    canMutateSecureData: isUnlocked && hasVaultKey && hasVaultOwnerToken,
  };
}

export type LockStateInputs = {
  /**
   * Whether this account owns a lock. `null` means "not read yet" and must not
   * be flattened to `false` by the caller.
   *
   * Read it from the wrapper-aware presence answer
   * (`VaultService.checkVault` / `peekVaultPresence`) — the same source the
   * unlock sheet itself uses to choose between creating and opening. Any other
   * source can disagree with the screen the person is about to see.
   */
  hasVault: boolean | null | undefined;
  /** `useVault().isVaultUnlocked`. */
  isVaultUnlocked: boolean;
  vaultKey?: string | null;
  /** `useVault().vaultOwnerToken` — memory-only, and the only real authority. */
  vaultOwnerToken?: string | null;
  /**
   * `useAuth().loading`, or false when the caller genuinely has a settled
   * identity. True holds the answer at `loading` rather than blaming somebody
   * for a frame of our own bookkeeping.
   */
  authLoading?: boolean;
  /**
   * True when the presence read threw and no cached answer survived. Distinct
   * from `hasVault === null`, which only means "still reading".
   */
  presenceFailed?: boolean;
};

export function resolveLockState({
  hasVault,
  isVaultUnlocked,
  vaultKey,
  vaultOwnerToken,
  authLoading = false,
  presenceFailed = false,
}: LockStateInputs): LockState {
  // Rule 1. A usable key present is proof, whatever else is still settling.
  //
  // Either signal is sufficient. `isVaultUnlocked` is the vault context's own
  // claim (`!!vaultKey && !!vaultOwnerToken`), so a caller that holds only that
  // boolean is as entitled to the answer as one holding the token itself.
  const capability = resolveVaultCapabilityState({
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
  });
  if (capability.canReadSecureData || capability.isUnlocked) return "unlocked";
  // Rule 4. No settled identity, no verdict.
  if (authLoading) return "loading";
  // Rule 3. A read that failed is not an answer of "no".
  if (presenceFailed) return "error";
  // Rule 2. Unknown stays unknown.
  if (hasVault === null || hasVault === undefined) return "loading";
  return hasVault ? "locked" : "unconfigured";
}

export function resolveVaultAvailabilityState(
  params: LockStateInputs,
): VaultAvailabilityState {
  const capability = resolveVaultCapabilityState(params);
  const state = resolveLockState(params);

  return {
    ...capability,
    state,
    hasVault: params.hasVault === true,
    vaultUnknown: state === "loading",
    needsVaultCreation: state === "unconfigured",
    needsUnlock: state === "locked",
    vaultCheckFailed: state === "error",
  };
}

/** True only when the action may run now with no credential surface. */
export function isLockReady(state: LockState): boolean {
  return state === "unlocked";
}

/**
 * True when the person can be asked for the lock.
 *
 * Deliberately excludes `loading` and `error`. Prompting on `loading` accuses
 * somebody of being locked during a frame of our own bookkeeping; prompting on
 * `error` hides a fault behind a credential sheet.
 */
export function needsLockPrompt(state: LockState): boolean {
  return state === "locked" || state === "unconfigured";
}

/**
 * The action label for the state, in the approved product vocabulary.
 *
 * "Set a lock" and "Unlock One" are different promises and must never be
 * swapped. Both sit inside the four-word budget.
 */
export function lockActionLabel(state: LockState): string {
  return state === "unconfigured" ? "Set a lock" : "Unlock One";
}

/**
 * What One says when an action cannot run yet.
 *
 * Non-visual callers (One Voice) read these verbatim, so each is a short plain
 * sentence naming the actual next step rather than a generic refusal.
 * `loading` asks for a moment instead of assigning blame; `error` names the
 * fault instead of pretending the person has no lock.
 */
export function lockBlockedSummary(state: LockState): string {
  switch (state) {
    case "unconfigured":
      return "Set a lock first";
    case "locked":
      return "Unlock One first";
    case "error":
      return "Couldn't check your lock";
    case "loading":
      return "Still checking";
    case "unlocked":
      return "";
  }
}

/**
 * Thrown by a handler that genuinely cannot proceed without the owner token.
 *
 * Typed so a caller can tell "you need the lock" apart from "the server said
 * no" and open the right sheet, instead of pattern-matching on a sentence. It
 * carries the state, so the surface picks between creating and opening without
 * asking the question a second time.
 */
export class LockRequiredError extends Error {
  readonly lockRequired = true as const;
  readonly lockState: LockState;

  constructor(lockState: LockState = "locked", message?: string) {
    super(message || lockBlockedSummary(lockState) || "Unlock One first");
    this.name = "LockRequiredError";
    this.lockState = lockState;
  }
}

export function isLockRequiredError(error: unknown): error is LockRequiredError {
  return (
    error instanceof LockRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { lockRequired?: unknown }).lockRequired === true)
  );
}
