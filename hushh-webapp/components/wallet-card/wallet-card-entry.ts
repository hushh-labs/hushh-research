/**
 * Whether the Wallet Profile entry point is offered in Profile > Your account.
 *
 * The backend `ONE_WALLET_CARD_ENABLED` flag stays the authority on whether the
 * feature works at all — every owner route answers 404 while it is off. This
 * client flag exists only so the settings row is not rendered against a dark
 * backend, which would put a dead end inside a settings list.
 *
 * Unset means off. A feature that ships dark must stay dark on any deployment
 * that has not deliberately turned it on, so this deliberately inverts the
 * default used by `isObservabilityEnabled`.
 */
const TRUTHY = ["1", "true", "yes", "on"];

export function isWalletCardEntryEnabled(): boolean {
  const raw = String(process.env.NEXT_PUBLIC_ONE_WALLET_CARD_ENABLED || "")
    .trim()
    .toLowerCase();
  return TRUTHY.includes(raw);
}
