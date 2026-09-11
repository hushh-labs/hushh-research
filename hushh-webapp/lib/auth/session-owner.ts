/**
 * Browser-local identity generation shared by the validated AuthProvider and
 * lower-level API transport. HCT/VAULT_OWNER tokens are intentionally opaque,
 * so the transport cannot recover their UID the way it can from a Firebase
 * JWT. Snapshotting the already-published owner lets a terminal HCT response
 * be scoped without ever parsing or persisting the vault token itself.
 *
 * All functions are inert during SSR. Module-level state on a server must
 * never become an identity channel between requests.
 */

export type AuthSessionGenerationSnapshot = Readonly<{
  userId: string | null;
  generation: number;
}>;

export type AuthSessionOwnerSnapshot = AuthSessionGenerationSnapshot & Readonly<{ userId: string }>;

let browserUserId: string | null = null;
let browserGeneration = 0;

export function publishValidatedAuthSessionOwner(userId: string | null): void {
  if (typeof window === "undefined") return;
  const normalizedUserId = String(userId || "").trim() || null;
  if (browserUserId === normalizedUserId) return;
  browserUserId = normalizedUserId;
  browserGeneration += 1;
}

/** Includes anonymous transitions so a prior guest session cannot become current again. */
export function snapshotAuthSessionGeneration(): AuthSessionGenerationSnapshot | null {
  if (typeof window === "undefined") return null;
  return { userId: browserUserId, generation: browserGeneration };
}

export function snapshotValidatedAuthSessionOwner(): AuthSessionOwnerSnapshot | null {
  if (typeof window === "undefined" || !browserUserId) return null;
  return { userId: browserUserId, generation: browserGeneration };
}

export function isValidatedAuthSessionOwnerCurrent(
  snapshot: AuthSessionGenerationSnapshot,
): boolean {
  return (
    typeof window !== "undefined" &&
    browserUserId === snapshot.userId &&
    browserGeneration === snapshot.generation
  );
}
