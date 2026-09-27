/**
 * Accounts this browser is deleting or has deleted.
 *
 * Background vault work (memory writes, connector setup) can still be in flight
 * while the erasure transaction locks or removes that account's rows. Those
 * failures are an expected consequence of the deletion, not application errors,
 * so callers use this to report them quietly. A deleted UID never signs in
 * again, so a mark only needs clearing when the deletion definitely did not
 * happen.
 */
const deletingUserIds = new Set<string>();

export function markAccountDeletionActive(userId: string): void {
  if (userId) deletingUserIds.add(userId);
}

/** The deletion definitely did not happen; the account keeps working normally. */
export function clearAccountDeletionActive(userId: string): void {
  deletingUserIds.delete(userId);
}

export function isAccountDeletionActive(userId: string | null | undefined): boolean {
  return Boolean(userId) && deletingUserIds.has(userId as string);
}
