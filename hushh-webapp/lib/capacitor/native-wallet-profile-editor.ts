import { WALLET_CARD_FIELD_LIMITS, EMPTY_WALLET_CARD_DRAFT, type WalletCardDraft } from "@/lib/wallet/wallet-card-draft";

export type NativeWalletProfileDraft = WalletCardDraft;
/** Structural bridge validation only; the existing Wallet Profile owner still
 * applies product validation and the service applies its closed payload policy. */
export function validNativeWalletProfileDraft(value: unknown): value is NativeWalletProfileDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return Object.keys(draft).length === Object.keys(EMPTY_WALLET_CARD_DRAFT).length &&
    Object.keys(draft).every(key => key in EMPTY_WALLET_CARD_DRAFT) &&
    Object.entries(WALLET_CARD_FIELD_LIMITS).every(([key, maximum]) => typeof draft[key] === "string" && draft[key].length <= maximum) &&
    ["email", "phone", "linkedin", "website"].includes(draft.preferredContact as string);
}
