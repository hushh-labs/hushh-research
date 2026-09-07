import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotAuthSessionGeneration,
  type AuthSessionGenerationSnapshot,
} from "@/lib/auth/session-owner";

export type VoiceSessionOwner = Readonly<{
  userId: string | null;
  snapshot: AuthSessionGenerationSnapshot | null;
}>;

/** A voice continuation follows the existing auth generation, never a tier. */
export function snapshotVoiceSessionOwner(
  userId: string | null,
): VoiceSessionOwner {
  return { userId, snapshot: snapshotAuthSessionGeneration() };
}

export function isVoiceSessionOwnerCurrent(owner: VoiceSessionOwner): boolean {
  return Boolean(
    owner.snapshot &&
    owner.snapshot.userId === owner.userId &&
    isValidatedAuthSessionOwnerCurrent(owner.snapshot),
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
