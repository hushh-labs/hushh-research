import type { CardBrand } from "./card-validation";

export type SharedPaymentCard = {
  pan: string; cardholderName: string; brand: CardBrand;
  expiryMonth: number; expiryYear: number; issuingRegion: string;
};

/** Allowlisted card information, shared by the file and recipient-key envelopes. */
export function projectSharedPaymentCard(value: SharedPaymentCard): SharedPaymentCard {
  const brands = ["visa", "mastercard", "amex", "discover", "diners", "jcb", "unionpay", "rupay", "mir", "elo", "verve", "other"];
  if (!value || typeof value.pan !== "string" || !/^\d{12,19}$/.test(value.pan) || typeof value.cardholderName !== "string" || value.cardholderName.length > 100 ||
      !brands.includes(value.brand) || !Number.isInteger(value.expiryMonth) || value.expiryMonth < 1 || value.expiryMonth > 12 ||
      !Number.isInteger(value.expiryYear) || value.expiryYear < 2000 || value.expiryYear > 2200 ||
      typeof value.issuingRegion !== "string" || value.issuingRegion.length > 3) throw new Error("Card unavailable.");
  return { pan: value.pan, cardholderName: value.cardholderName, brand: value.brand,
    expiryMonth: value.expiryMonth, expiryYear: value.expiryYear, issuingRegion: value.issuingRegion };
}
