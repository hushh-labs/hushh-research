"use client";

/**
 * Secure add-card form, shared by /one/wallet and the Agent One chat widget.
 * Card secrets stay in this form until the wallet service encrypts them with
 * the owner's vault key. They never enter a chat message or a Server Action.
 */

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  ProfilePaneAccountIcon,
  ProfilePaneCalendarIcon,
  ProfilePaneCardIcon,
  ProfilePaneCardNetworkIcon,
  ProfilePaneGlobeIcon,
  ProfilePaneKeyIcon,
  ProfilePanePreviewIcon,
  ProfilePanePreviewOffIcon,
  ProfilePaneSecurityIcon,
} from "@/components/profile/profile-pane-icons";

import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import { cn } from "@/lib/utils";
import { CARD_BRANDS, detectBrand, validateCardForRegion, type CardBrand } from "@/lib/wallet/card-validation";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import type { WalletCardInput } from "@/lib/services/wallet-service";

import styles from "./secure-card-add-form.module.css";

const ERROR_COPY: Record<string, string> = {
  pan_length_invalid: "Enter a complete card number.",
  pan_checksum_invalid: "Check the card number for a typo.",
  pan_length_invalid_for_brand: "The card number length does not match the selected network.",
  brand_invalid: "Choose a card network from the list.",
  cardholder_name_required: "Enter the name on your card.",
  cardholder_name_invalid: "Use the name on your card, up to 80 characters.",
  issuing_region_invalid: "Choose a valid issuing region or leave it blank.",
  brand_region_mismatch: "This card network is not issued in the selected region.",
  cvv_required: "Enter the security code on your card.",
  cvv_invalid: "Check the security code for this card network.",
  pin_invalid: "A card PIN is 4 to 6 digits.",
  expiry_month_invalid: "Enter a valid expiry month.",
  expiry_year_invalid: "Enter a valid expiry year.",
  card_expired: "This card is already expired.",
};

export interface SecureCardAddFormProps {
  onSubmit: (card: WalletCardInput) => Promise<void>;
  onCancel?: () => void;
  compact?: boolean;
  /** @deprecated Manual entry is the sole add-card path. Kept for older hosts. */
  scanEnabled?: boolean;
  /** Mask entered details when a mounted draft is in an inactive tab. */
  active?: boolean;
  /** Compatibility label supplied by a chat offer; never asks for it again. */
  initialNickname?: string;
  /** Decrypted by the host from the owner's Secrets; never passed in a URL. */
  initialPan?: string;
}

export function SecureCardAddForm({ onSubmit, onCancel, compact, active = true, initialNickname, initialPan }: SecureCardAddFormProps) {
  const id = useId();
  const saving = useRef(false);
  const errorsRef = useRef<HTMLUListElement>(null);
  const [cardholderName, setCardholderName] = useState("");
  const [pan, setPan] = useState(initialPan ?? "");
  const [network, setNetwork] = useState<CardBrand | "">("");
  const [cvv, setCvv] = useState("");
  const [pin, setPin] = useState("");
  const [expiry, setExpiry] = useState("");
  const [issuingRegion, setIssuingRegion] = useState("");
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!active) setRevealSecrets(false);
  }, [active]);
  useEffect(() => {
    if (errors.length) errorsRef.current?.focus();
  }, [errors]);

  const detectedBrand = useMemo(() => detectBrand(pan), [pan]);
  const brand = network || detectedBrand || "other";
  const fieldErrors = (...codes: string[]) => {
    const matches = errors.filter((error) => codes.includes(error));
    return {
      "aria-invalid": matches.length > 0 || undefined,
      "aria-describedby": matches.length ? matches.map((code) => `${id}-${code}`).join(" ") : undefined,
    };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current || !active) return;
    const match = expiry.trim().match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
    const rawYear = Number(match?.[2] ?? 0);
    const card: WalletCardInput = {
      nickname: initialNickname?.trim() || cardNetworkLabel(brand),
      cardholderName: cardholderName.trim(),
      pan,
      brand: network || undefined,
      cvv: cvv.trim(),
      pin: pin.trim() || undefined,
      expiryMonth: Number(match?.[1] ?? 0),
      expiryYear: match ? (rawYear < 100 ? 2000 + rawYear : rawYear) : 0,
      issuingRegion: issuingRegion || undefined,
    };
    const result = validateCardForRegion(card);
    if (!result.valid) {
      setErrors(result.errors);
      return;
    }
    saving.current = true;
    setErrors([]);
    setSubmitting(true);
    try {
      await onSubmit(card);
      // Some hosts leave the form mounted after saving. Never retain its secrets.
      setPan("");
      setCvv("");
      setPin("");
      setCardholderName("");
      setExpiry("");
      setNetwork("");
      setIssuingRegion("");
      setRevealSecrets(false);
    } catch {
      // Raw service errors can contain request details; keep the draft for retry.
      toast.error("Your card could not be saved. Please try again.");
    } finally {
      saving.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form
      className={cn(styles.form, compact && styles.compact)}
      data-testid="secure-card-add-form"
      onSubmit={handleSubmit}
      noValidate
      aria-busy={submitting}
    >
      {!compact ? <div className={styles.heading}>
        <h2 className={TYPOGRAPHY_CLASSNAMES.sectionTitle}>Add your card</h2>
        <p>Enter the details printed on your card.</p>
      </div> : null}
      <fieldset disabled={submitting || !active} className={styles.fields}>
        <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Encrypted on this device. Never enters chat.</p>
        <div className={cn(styles.field, styles.number)}>
          <Label htmlFor={`${id}-number`}><ProfilePaneCardIcon className={styles.fieldIcon} />Card number</Label>
          <Input
            id={`${id}-number`}
            dir="ltr"
            value={pan}
            onChange={(event) => setPan(event.target.value.replace(/\D/g, "").slice(0, 19))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="XXXX XXXX XXXX XXXX"
            maxLength={32}
            required
            data-testid="secure-card-pan-input"
            {...fieldErrors("pan_length_invalid", "pan_checksum_invalid", "pan_length_invalid_for_brand")}
          />
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <Label htmlFor={`${id}-holder`}><ProfilePaneAccountIcon className={styles.fieldIcon} />Name on card</Label>
            <Input
              id={`${id}-holder`}
              value={cardholderName}
              onChange={(event) => setCardholderName(event.target.value)}
              autoComplete="off"
              maxLength={80}
              required
              {...fieldErrors("cardholder_name_required", "cardholder_name_invalid")}
            />
          </div>
          <div className={styles.field}>
            <Label htmlFor={`${id}-network`}><ProfilePaneCardNetworkIcon className={styles.fieldIcon} />Card network (optional)</Label>
            <Select value={network || "auto"} onValueChange={(value) => setNetwork(value === "auto" ? "" : value as CardBrand)} disabled={submitting || !active}>
              <SelectTrigger id={`${id}-network`} className={styles.selectTrigger} data-testid="secure-card-network-select" {...fieldErrors("brand_invalid")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={styles.selectMenu}>
                <SelectItem value="auto">{detectedBrand ? `Auto-detect · ${cardNetworkLabel(detectedBrand)}` : "Auto-detect"}</SelectItem>
                {CARD_BRANDS.map((value) => <SelectItem key={value} value={value}>{value === "other" ? "Other" : cardNetworkLabel(value)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <Label htmlFor={`${id}-expiry`}><ProfilePaneCalendarIcon className={styles.fieldIcon} />Expiry (MM/YY)</Label>
            <Input
              id={`${id}-expiry`}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="MM/YY"
              maxLength={7}
              required
              {...fieldErrors("expiry_month_invalid", "expiry_year_invalid", "card_expired")}
            />
          </div>
          <div className={styles.field}>
            <Label htmlFor={`${id}-cvv`}><ProfilePaneSecurityIcon className={styles.fieldIcon} />CVV</Label>
            <Input
              id={`${id}-cvv`}
              type={revealSecrets ? "text" : "password"}
              value={cvv}
              onChange={(event) => setCvv(event.target.value.replace(/\D/g, "").slice(0, 4))}
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              required
              {...fieldErrors("cvv_required", "cvv_invalid")}
            />
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <div className={styles.secretLabel}>
              <Label htmlFor={`${id}-pin`}><ProfilePaneKeyIcon className={styles.fieldIcon} />PIN (optional)</Label>
              <button
                type="button"
                className={styles.reveal}
                onClick={() => setRevealSecrets((current) => !current)}
                aria-pressed={revealSecrets}
                aria-label={revealSecrets ? "Hide CVV and PIN" : "Show CVV and PIN"}
                data-testid="secure-card-toggle-secrets"
              >
                {revealSecrets ? <ProfilePanePreviewOffIcon /> : <ProfilePanePreviewIcon />}
                {revealSecrets ? "Hide" : "Show"}
              </button>
            </div>
            <Input
              id={`${id}-pin`}
              placeholder="Leave blank to skip"
              type={revealSecrets ? "text" : "password"}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              {...fieldErrors("pin_invalid")}
            />
          </div>
          <div className={styles.field}>
            <Label htmlFor={`${id}-region`}><ProfilePaneGlobeIcon className={styles.fieldIcon} />Issuing region (optional)</Label>
            <Select value={issuingRegion || "none"} onValueChange={(value) => setIssuingRegion(value === "none" ? "" : value)} disabled={submitting || !active}>
              <SelectTrigger id={`${id}-region`} className={styles.selectTrigger} data-testid="secure-card-region-select" {...fieldErrors("issuing_region_invalid", "brand_region_mismatch")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={styles.selectMenu}>
                <SelectItem value="none">Select region…</SelectItem>
                {COUNTRY_PHONE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </fieldset>
      {errors.length > 0 ? (
        <ul ref={errorsRef} tabIndex={-1} role="alert" className={styles.errors} data-testid="secure-card-errors">
          {errors.map((code) => <li id={`${id}-${code}`} key={code}>{ERROR_COPY[code] ?? "Check your card details."}</li>)}
        </ul>
      ) : null}
      <FlowActionGroup
        stacked
        primary={<Button type="submit" size="prominent" disabled={submitting || !active} data-testid="secure-card-save">{submitting ? "Saving…" : "Save card"}</Button>}
        secondary={onCancel ? <Button type="button" variant="secondary" size="prominent" onClick={onCancel} disabled={submitting}>Cancel</Button> : undefined}
      />
    </form>
  );
}
