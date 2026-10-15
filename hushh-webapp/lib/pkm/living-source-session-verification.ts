import type { LivingSourceInput } from "@/lib/pkm/living-source-records";

type Kind = LivingSourceInput["kind"];
type SessionVerification = { epoch: number; verifiedAt: Partial<Record<Kind, string>> };

/**
 * In-memory times of the last successful source verification in this owner's
 * unlocked session. An unchanged sync skips its encrypted write, so the stored
 * inventory time can lag a verification that really happened. Never persisted;
 * a different owner or vault epoch reads nothing.
 */
const sessions = new Map<string, SessionVerification>();

export function recordLivingSourceSessionVerification(
  userId: string,
  epoch: number,
  kinds: readonly Kind[],
  verifiedAt: string,
): void {
  if (!userId || !Number.isFinite(Date.parse(verifiedAt))) return;
  const prior = sessions.get(userId);
  const current = prior?.epoch === epoch ? { ...prior.verifiedAt } : {};
  for (const kind of kinds) current[kind] = verifiedAt;
  sessions.set(userId, { epoch, verifiedAt: current });
}

export function getLivingSourceSessionVerification(
  userId: string,
  epoch: number,
): Partial<Record<Kind, string>> {
  const session = sessions.get(userId);
  return session?.epoch === epoch ? { ...session.verifiedAt } : {};
}

export function clearLivingSourceSessionVerification(userId?: string): void {
  if (userId) sessions.delete(userId);
  else sessions.clear();
}
