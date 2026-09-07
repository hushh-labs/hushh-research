import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
  type AuthSessionOwnerSnapshot,
} from "@/lib/auth/session-owner";

export type VoiceSessionOwner = Readonly<{
  userId: string | null;
  snapshot: AuthSessionOwnerSnapshot | null;
}>;

/** A voice continuation follows the existing auth generation, never a tier. */
export function snapshotVoiceSessionOwner(
  userId: string | null,
): VoiceSessionOwner {
  return { userId, snapshot: snapshotValidatedAuthSessionOwner() };
}

export function isVoiceSessionOwnerCurrent(owner: VoiceSessionOwner): boolean {
  if (owner.userId) {
    return (
      owner.snapshot?.userId === owner.userId &&
      isValidatedAuthSessionOwnerCurrent(owner.snapshot)
    );
  }
  return (
    owner.snapshot === null && snapshotValidatedAuthSessionOwner() === null
  );
}

export type VoiceContinuation = Readonly<{
  owner: VoiceSessionOwner;
  handle: string | null;
}>;

export function currentVoiceContinuationHandle(
  continuation: VoiceContinuation | null,
): string | null {
  return continuation && isVoiceSessionOwnerCurrent(continuation.owner)
    ? continuation.handle
    : null;
}
