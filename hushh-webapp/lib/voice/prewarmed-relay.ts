import type { AuthSessionOwnerSnapshot } from "@/lib/auth/session-owner";
import { isVoiceSessionOwnerCurrent } from "@/lib/voice/voice-session-owner";

export type PrewarmedGeminiRelay = {
  relayUrl: string;
  expiresAtMs: number;
  snapshotId: string;
  accessTier: string;
  ownerUserId: string | null;
  ownerSnapshot: AuthSessionOwnerSnapshot | null;
};

/** Cache reuse follows the existing validated session owner, never just a tier. */
export function canReusePrewarmedRelay(
  relay: PrewarmedGeminiRelay | null,
  accessTier: string | null | undefined,
  ownerUserId: string | null,
  now = Date.now(),
): relay is PrewarmedGeminiRelay {
  if (
    !relay ||
    relay.accessTier !== accessTier ||
    relay.ownerUserId !== ownerUserId ||
    relay.expiresAtMs <= now
  )
    return false;
  return isVoiceSessionOwnerCurrent({
    userId: ownerUserId,
    snapshot: relay.ownerSnapshot,
  });
}
