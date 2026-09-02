"use client";

/**
 * Secure add-card form, shared by /one/cards and the Agent One chat widget.
 * Card secrets are typed into this form only - never into the chat stream -
 * and are encrypted in the browser under the vault key before leaving it.
 */

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { detectBrand, validateCardForRegion } from "@/lib/cards/card-validation";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import type { PaymentCardInput } from "@/lib/services/payment-cards-service";

const ERROR_COPY: Record<string, string> = {
  pan_length_invalid: "That card number does not look complete.",
  pan_checksum_invalid: "That card number fails its checksum. Check for a typo.",
  pan_length_invalid_for_brand: "That length does not match the detected card network.",
  brand_unrecognized: "We could not recognize this card network.",
  issuing_region_invalid: "Pick the region that issued this card.",
  brand_region_mismatch: "This card network is not issued in the selected region.",
  cvv_invalid: "The security code does not match this network's format.",
  pin_invalid: "A card PIN is 4 to 6 digits.",
  expiry_month_invalid: "Pick a valid expiry month.",
  expiry_year_invalid: "Pick a valid expiry year.",
  card_expired: "This card is already expired.",
};

export interface SecureCardAddFormProps {
  onSubmit: (card: PaymentCardInput) => Promise<void>;
  onCancel?: () => void;
  compact?: boolean;
}

export function SecureCardAddForm({ onSubmit, onCancel, compact }: SecureCardAddFormProps) {
  const [nickname, setNickname] = useState("");
  const [cardholderName, setCardholderName] = useState("");
  const [pan, setPan] = useState("");
  const [cvv, setCvv] = useState("");
  const [pin, setPin] = useState("");
  const [expiry, setExpiry] = useState("");
  const [issuingRegion, setIssuingRegion] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const brand = useMemo(() => detectBrand(pan), [pan]);

  const parseExpiry = (): { month: number; year: number } => {
    const match = expiry.trim().match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
    if (!match) return { month: 0, year: 0 };
    const month = Number(match[1]);
    const rawYear = Number(match[2]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return { month, year };
  };

  const handleSubmit = async () => {
    const { month, year } = parseExpiry();
    const card: PaymentCardInput = {
      nickname,
      cardholderName,
      pan,
      cvv: cvv || undefined,
      pin: pin || undefined,
      expiryMonth: month,
      expiryYear: year,
      issuingRegion,
    };
    const result = validateCardForRegion({
      pan: card.pan,
      cvv: card.cvv,
      pin: card.pin,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      issuingRegion: card.issuingRegion,
    });
    if (!result.valid) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit(card);
    } catch (error) {
      setSubmitError(
        error instanceof Error && error.message
          ? error.message
          : "The card could not be saved.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border border-border bg-card p-4 ${compact ? "max-w-md" : "w-full"}`}
      data-testid="secure-card-add-form"
    >
      <p className="text-xs text-muted-foreground">
        Encrypted on this device. Never enters chat.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="card-nickname">Nickname</Label>
          <Input
            id="card-nickname"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Everyday Visa"
            maxLength={60}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="card-holder">Name on card</Label>
          <Input
            id="card-holder"
            value={cardholderName}
            onChange={(event) => setCardholderName(event.target.value)}
            autoComplete="off"
            maxLength={80}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="card-number">Card number{brand ? ` · ${brand}` : ""}</Label>
        <Input
          id="card-number"
          value={pan}
          onChange={(event) => setPan(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="1234 5678 9012 3456"
          maxLength={23}
          data-testid="secure-card-pan-input"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="card-expiry">Expiry (MM/YY)</Label>
          <Input
            id="card-expiry"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="04/28"
            maxLength={7}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="card-cvv">CVV</Label>
          <Input
            id="card-cvv"
            type="password"
            value={cvv}
            onChange={(event) => setCvv(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="card-pin">PIN (optional)</Label>
          <Input
            id="card-pin"
            type="password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="card-region">Issuing region</Label>
        <select
          id="card-region"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={issuingRegion}
          onChange={(event) => setIssuingRegion(event.target.value)}
          data-testid="secure-card-region-select"
        >
          <option value="">Select region…</option>
          {COUNTRY_PHONE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {errors.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-destructive" data-testid="secure-card-errors">
          {errors.map((code) => (
            <li key={code}>{ERROR_COPY[code] ?? code}</li>
          ))}
        </ul>
      ) : null}
      {submitError ? (
        <p className="text-sm text-destructive">{submitError}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button onClick={handleSubmit} disabled={submitting} data-testid="secure-card-save">
          {submitting ? "Encrypting…" : "Save card"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}
