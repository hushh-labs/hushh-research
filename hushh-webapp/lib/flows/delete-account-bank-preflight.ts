export const ACCOUNT_ERASURE_BANKS_NOT_DISCONNECTED_MESSAGE =
  "We couldn't disconnect your linked banks at Plaid, so nothing was deleted. Check your connection and try again.";

/** Raised before anything is erased: a sealed bank connection could not be revoked. */
export class AccountErasureBanksNotDisconnectedError extends Error {
  readonly code = "ACCOUNT_ERASURE_BANKS_NOT_DISCONNECTED";

  constructor(readonly failed: number) {
    super(ACCOUNT_ERASURE_BANKS_NOT_DISCONNECTED_MESSAGE);
    this.name = "AccountErasureBanksNotDisconnectedError";
  }
}

/**
 * Deleting or resetting the account erases the vault, and with it the only
 * copy of each sealed Plaid token. Revoke every connection at Plaid first, or
 * it would stay live with nobody able to disconnect it. Without the vault key
 * (the vault cannot be opened) there is nothing this device can revoke.
 */
export async function revokeVaultBanksBeforeErasure(params: {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string;
  isCurrent?: () => boolean;
}): Promise<void> {
  if (params.isCurrent?.() === false) throw new Error("Account deletion cancelled before submission.");
  if (!params.vaultKey) return;
  const { revokeAllVaultPlaidAtPlaid } = await import("@/lib/kai/plaid-vault/vault-sync");
  if (params.isCurrent?.() === false) throw new Error("Account deletion cancelled before submission.");
  const outcome = await revokeAllVaultPlaidAtPlaid({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    isCurrent: params.isCurrent,
  }).catch(() => ({ revoked: 0, failed: -1 }));
  if (outcome.failed !== 0) throw new AccountErasureBanksNotDisconnectedError(outcome.failed);
}
