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

export type AuthSessionOwnerSnapshot = AuthSessionGenerationSnapshot &
  Readonly<{ userId: string }>;

/** Firebase remains authentication identity; application ownership is immutable. */
export type AccountPrincipalBinding = Readonly<{
  firebaseUid: string;
  ownerId: string;
  accountGeneration: number;
}>;

export function parseAccountPrincipal(
  payload: unknown, expectedFirebaseUid: string,
): AccountPrincipalBinding | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value.active !== true || value.firebase_uid !== expectedFirebaseUid
      || typeof value.owner_id !== "string" || !value.owner_id.trim()
      || value.owner_id !== value.owner_id.trim() || value.owner_id.length > 128
      || !Number.isSafeInteger(value.account_generation) || (value.account_generation as number) < 0) return null;
  const generation = value.account_generation as number;
  if (generation === 0 ? value.owner_id !== expectedFirebaseUid
      : !/^acct_[0-9a-f]{32}$/.test(value.owner_id)) return null;
  return { firebaseUid: expectedFirebaseUid, ownerId: value.owner_id, accountGeneration: generation };
}

export const AUTH_SESSION_VERIFICATION_REQUIRED_EVENT =
  "auth-session-verification-required";

export type AuthSessionVerificationRequiredDetail = AuthSessionOwnerSnapshot &
  Readonly<{ reason: string }>;

/** Availability uncertainty gates access without destroying a local unlock. */
export function dispatchAuthSessionVerificationRequired(
  owner: AuthSessionOwnerSnapshot,
  reason: string,
): void {
  if (!isValidatedAuthSessionOwnerCurrent(owner)) return;
  window.dispatchEvent(new CustomEvent<AuthSessionVerificationRequiredDetail>(
    AUTH_SESSION_VERIFICATION_REQUIRED_EVENT,
    { detail: { ...owner, reason } },
  ));
}

let browserUserId: string | null = null;
let browserGeneration = 0;
let browserPrincipal: AccountPrincipalBinding | null = null;
let browserFirebaseUid: string | null = null;
// Kept through a withdrawal of the same identity so departure cleanup still reaches that owner.
let lastAdmittedPrincipal: AccountPrincipalBinding | null = null;
const generationListeners = new Set<() => void>();

/** Identity payloads stay in this module; subscribers only learn that it changed. */
export function subscribeAuthSessionGeneration(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

function notifyAuthSessionGeneration(): void {
  for (const listener of generationListeners) listener();
}

/** Includes anonymous periods, so A -> signed out -> A cannot reuse old work. */
export function getAuthSessionGeneration(): number | null {
  return typeof window === "undefined" ? null : browserGeneration;
}

export function publishValidatedAuthSessionOwner(userId: string | null): void {
  if (typeof window === "undefined") return;
  const normalizedUserId = String(userId || "").trim() || null;
  if (browserUserId === normalizedUserId && browserPrincipal === null && browserFirebaseUid === normalizedUserId) return;
  if (lastAdmittedPrincipal?.firebaseUid !== normalizedUserId) lastAdmittedPrincipal = null;
  browserPrincipal = null;
  browserFirebaseUid = normalizedUserId;
  browserUserId = normalizedUserId;
  browserGeneration += 1;
  notifyAuthSessionGeneration();
}

/** A pending identity can own recovery, never application information. */
export function publishPendingAuthSessionIdentity(firebaseUid: string, forceNewEpisode = false): void {
  if (typeof window === "undefined") return;
  if (!forceNewEpisode && browserUserId === null && browserPrincipal === null && browserFirebaseUid === firebaseUid) return;
  if (lastAdmittedPrincipal?.firebaseUid !== firebaseUid) lastAdmittedPrincipal = null;
  browserUserId = null;
  browserPrincipal = null;
  browserFirebaseUid = firebaseUid;
  browserGeneration += 1;
  notifyAuthSessionGeneration();
}

export function publishValidatedAuthSessionPrincipal(principal: AccountPrincipalBinding | null): void {
  if (typeof window === "undefined") return;
  if (!principal) { publishValidatedAuthSessionOwner(null); return; }
  if (browserPrincipal?.firebaseUid === principal.firebaseUid
      && browserPrincipal.ownerId === principal.ownerId
      && browserPrincipal.accountGeneration === principal.accountGeneration) return;
  browserUserId = principal.ownerId;
  browserFirebaseUid = principal.firebaseUid;
  browserPrincipal = { ...principal };
  lastAdmittedPrincipal = { ...principal };
  browserGeneration += 1;
  notifyAuthSessionGeneration();
}

export function snapshotValidatedAuthSessionPrincipal(): (AccountPrincipalBinding & AuthSessionOwnerSnapshot) | null {
  if (typeof window === "undefined" || !browserPrincipal || !browserUserId) return null;
  return { ...browserPrincipal, userId: browserUserId, generation: browserGeneration };
}

/** Maps only the current session's owner to its Firebase identity; any other value passes through. */
export function firebaseUidForOwner(ownerId: string): string {
  const principal = snapshotValidatedAuthSessionPrincipal();
  return principal?.ownerId === ownerId ? principal.firebaseUid : ownerId;
}

/** The owner last admitted for this Firebase identity, even after a withdrawal. Departure cleanup only. */
export function lastAdmittedOwnerFor(firebaseUid: string | null | undefined): string | null {
  if (typeof window === "undefined" || !firebaseUid) return null;
  return lastAdmittedPrincipal?.firebaseUid === firebaseUid ? lastAdmittedPrincipal.ownerId : null;
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
