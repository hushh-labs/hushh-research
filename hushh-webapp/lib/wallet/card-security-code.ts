/** Only manually entered owner codes use this namespace; legacy CVV/PIN stay ignored. */
export interface WalletSecurityCodeChange { cardId: string; value: string }

export function isWalletSecurityCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{3,4}$/.test(value);
}

export function readWalletSecurityCode(record: unknown): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const value = (record as Record<string, unknown>).manual_cvv;
  return isWalletSecurityCode(value) ? value : undefined;
}

/** Called on each canonical build, including conflict reconstruction. Other
 * writers may preserve a code or remove its entire card, never change its value. */
export function assertWalletSecurityCodeWrite(before: Record<string, unknown>, after: Record<string, unknown>, change: WalletSecurityCodeChange | undefined, authorized: boolean): void {
  const records = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const previous = records(before.secrets), next = records(after.secrets);
  if (change && (!authorized || !isWalletSecurityCode(change.value) || readWalletSecurityCode(next[change.cardId]) !== change.value)) throw new Error("Security code write unavailable.");
  for (const cardId of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const value = next[cardId];
    const oldCode = records(previous[cardId]).manual_cvv, nextCode = records(value).manual_cvv;
    // Deleting a card removes both branches. Dropping only its private record
    // must not silently erase a code while the card still exists.
    if (!Object.hasOwn(next, cardId) && !Object.hasOwn(records(after.summary), cardId)) continue;
    if (nextCode !== undefined && !isWalletSecurityCode(nextCode)) throw new Error("Security code write unavailable.");
    const pan = (record: unknown) => String(records(record).pan ?? "").replace(/[\s-]/g, "");
    if (oldCode && nextCode && pan(previous[cardId]) !== pan(value) && (!authorized || change?.cardId !== cardId || change.value !== nextCode)) throw new Error("Security code write unavailable.");
    if (oldCode !== nextCode && (!authorized || change?.cardId !== cardId || change.value !== nextCode)) throw new Error("Security code write unavailable.");
  }
}
