"use client";

/**
 * Secure add-card form, shared by /one/wallet and the Agent One chat widget.
 * Card secrets stay in this form until the wallet service encrypts them with
 * the owner's vault key. They never enter a chat message or a Server Action.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { toast } from "sonner";
import {
  ProfilePaneAccountIcon,
  ProfilePaneCalendarIcon,
  ProfilePaneCardIcon,
  ProfilePaneCardNetworkIcon,
  ProfilePaneGlobeIcon,
} from "@/components/profile/profile-pane-icons";

import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import { cn } from "@/lib/utils";
import { isCardPanLengthValid, normalizePan, validateCardForRegion, type CardBrand } from "@/lib/wallet/card-validation";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import { WalletService, type WalletNetworkContext, type WalletNetworkResult, type WalletCardInput } from "@/lib/services/wallet-service";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { walletOperationId } from "@/lib/wallet/wallet-operation-id";

import { type WalletCardArtwork, type WalletArtworkVariant } from "@/lib/wallet/card-artwork";
import { WalletBankDesignPicker } from "./wallet-bank-design-picker";
import { WalletCardArtworkPicker } from "./wallet-card-artwork-picker";
import { WalletCardFace } from "./wallet-card-face";
import { useWalletArtworkVisibility } from "@/lib/wallet/use-wallet-artwork-visibility";
import type { CardScanDraft } from "@/lib/services/wallet-card-scan";
import { WalletCardScanner } from "./wallet-card-scanner";
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
  expiry_month_invalid: "Enter a valid expiry month.",
  expiry_year_invalid: "Enter a valid expiry year.",
  card_expired: "This card is already expired.",
};

export interface SecureCardAddFormProps {
  onSubmit: (card: WalletCardInput) => Promise<void>;
  onCancel?: () => void;
  getNetworkContext?: () => WalletNetworkContext | null;
  compact?: boolean;
  showIntroduction?: boolean;
  /** Read a physical card locally, then review before saving. */
  scanEnabled?: boolean;
  /** Private design changes are owned by the Wallet page, not chat writers. */
  artworkEnabled?: boolean;
  scanInToolbar?: boolean;
  /** Mask entered details when a mounted draft is in an inactive tab. */
  active?: boolean;
  /** Compatibility label supplied by a chat offer; never asks for it again. */
  initialNickname?: string;
  /** Decrypted by the host from the owner's Secrets; never passed in a URL. */
  initialPan?: string;
  /** Owner host performs usage allocation privately; the picker never gets PAN. */
  suggestBankDesign?: (pan: string, variants: readonly WalletArtworkVariant[], signal: AbortSignal) => Promise<WalletArtworkVariant | null>;
}

export function SecureCardAddForm({ onSubmit, onCancel, getNetworkContext, compact, showIntroduction = true, scanEnabled = true, artworkEnabled = true, scanInToolbar = false, active = true, initialNickname, initialPan, suggestBankDesign }: SecureCardAddFormProps) {
  const id = useId();
  const saving = useRef(false);
  const errorsRef = useRef<HTMLUListElement>(null);
  const [cardholderName, setCardholderName] = useState("");
  const [pan, setPanValue] = useState(initialPan ?? "");
  const [bankDraftRevision, setBankDraftRevision] = useState(0);
  const setPan = (value: string) => { setPanValue(value); setBankDraftRevision(revision => revision + 1); };
  const [bankSelection, setBankSelection] = useState<string | null>(null);
  const [network, setNetwork] = useState<CardBrand | "">("");
  const draftId = useRef(walletOperationId());
  const edited = useRef({ pan: Boolean(initialPan), expiry: false, cardholderName: false });
  const [scanReading, setScanReading] = useState<CardScanDraft | null>(null);
  const [artwork, setArtwork] = useState<WalletCardArtwork | undefined>();
  const [expiry, setExpiry] = useState("");
  const [issuingRegion, setIssuingRegion] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [additionalOpen, setAdditionalOpen] = useState(false);
  useEffect(() => { if (!active) { setScanReading(null); setArtwork(undefined); } }, [active]);
  useEffect(() => {
    if (errors.length) errorsRef.current?.focus();
  }, [errors]);

  const [supportedNetworks, setSupportedNetworks] = useState<CardBrand[]>([]);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [networkReply, setNetworkReply] = useState<{ key: string; vaultOwnerToken: string; result: WalletNetworkResult | null } | null>(null);
  const [networkLoading, setNetworkLoading] = useState(false);
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const context = getNetworkContext?.() ?? null;
  const ownerKey = `${epoch}:${context?.userId ?? ""}`;
  const previousOwner = useRef(ownerKey);
  const draftVisible = active && previousOwner.current === ownerKey;
  const artworkVisible = useWalletArtworkVisibility(context, artwork?.source === "catalog" ? artwork : undefined, draftVisible);
  useEffect(() => {
    if (previousOwner.current === ownerKey) return;
    previousOwner.current = ownerKey;
    setPan(""); setCardholderName(""); setExpiry(""); setNetwork(""); setScanReading(null); setArtwork(undefined);
    setIssuingRegion(""); setErrors([]); setAdditionalOpen(false);
    edited.current = { pan: false, cardholderName: false, expiry: false }; draftId.current = walletOperationId();
  }, [ownerKey]);
  const contextRef = useRef(context);
  contextRef.current = context;
  const digits = normalizePan(pan);
  const prefix = /^[0-9]{6,19}$/.test(digits) ? digits.slice(0, 6) : "";
  const length = digits.length;
  const lookupKey = JSON.stringify([epoch, context?.userId, prefix, length, network]);
  const currentReply = networkReply?.key === lookupKey && networkReply.vaultOwnerToken === context?.vaultOwnerToken ? networkReply : null;
  const brand = currentReply?.result?.network ?? "other";
  // An unchanged owner/draft keeps its confirmed network during token renewal.
  // This is presentation continuity, never authority to skip save validation.
  const bankNetwork = currentReply?.result?.network ?? (networkReply?.key === lookupKey ? networkReply.result?.network : undefined) ?? "other";
  const bankContextKey = `${ownerKey}:${bankNetwork}:${issuingRegion}`;
  const bankMode = bankSelection === bankContextKey;
  useLayoutEffect(() => {
    if (bankSelection && bankSelection !== bankContextKey) { setBankSelection(null); setArtwork(undefined); }
  }, [bankSelection, bankContextKey]);
  const networkLengthMismatch = length >= 13 && length <= 19 && !isCardPanLengthValid(length, network || brand);
  const networkHint = networkLengthMismatch ? ERROR_COPY.pan_length_invalid_for_brand : networkLoading || !currentReply ? null : !currentReply.result
    ? "Network identification is unavailable. Your card will use a neutral Card label."
    : currentReply.result.source === "ambiguous"
      ? "This number matches more than one network. Choose the network printed on your card."
      : currentReply.result.source === "unknown"
        ? "Network not recognized. Choose the network printed on your card, or save it as Card."
        : currentReply.result.source === "owner_selected"
          ? "You selected this network. This does not verify the card or its issuer."
          : "Network identified from the card prefix. This does not verify the card or its issuer.";
  useEffect(() => {
    const current = contextRef.current;
    const controller = new AbortController();
    setSupportedNetworks([]);
    setCatalogFailed(false);
    if (current && active) void WalletService.supportedCardNetworks(current, controller.signal).then(values => {
      if (!controller.signal.aborted) setSupportedNetworks(values);
    }).catch(() => { if (!controller.signal.aborted) setCatalogFailed(true); });
    return () => controller.abort();
  }, [context?.userId, context?.vaultOwnerToken, active, epoch, catalogRevision]);
  useEffect(() => {
    const current = contextRef.current;
    const controller = new AbortController();
    setNetworkLoading(false);
    if (!active || !current || !prefix || length < 13 || length > 19) return;
    setNetworkLoading(true);
    const timer = window.setTimeout(() => {
      void WalletService.resolveCardNetwork(current, { iinPrefix: prefix, panLength: length, selectedNetwork: network || undefined }, controller.signal).then(result => {
        if (!controller.signal.aborted) setNetworkReply({ key: lookupKey, vaultOwnerToken: current.vaultOwnerToken, result });
      }).catch(() => { if (!controller.signal.aborted) setNetworkReply({ key: lookupKey, vaultOwnerToken: current.vaultOwnerToken, result: null }); })
        .finally(() => { if (!controller.signal.aborted) setNetworkLoading(false); });
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [context?.userId, context?.vaultOwnerToken, active, prefix, length, network, lookupKey]);
  const fieldErrors = (...codes: string[]) => {
    const matches = errors.filter((error) => codes.includes(error));
    return {
      "aria-invalid": matches.length > 0 || undefined,
      "aria-describedby": matches.length ? matches.map((code) => `${id}-${code}`).join(" ") : undefined,
    };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current || scanning || networkLoading || !draftVisible) return;
    const match = expiry.trim().match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
    const rawYear = Number(match?.[2] ?? 0);
    const card: WalletCardInput = {
      nickname: initialNickname?.trim() || cardNetworkLabel(network || brand),
      cardholderName: cardholderName.trim(),
      pan,
      brand: network || undefined,
      draftId: draftId.current,
      artwork,
      expiryMonth: Number(match?.[1] ?? 0),
      expiryYear: match ? (rawYear < 100 ? 2000 + rawYear : rawYear) : 0,
      issuingRegion: issuingRegion || undefined,
    };
    const result = validateCardForRegion({ ...card, brand: network || brand });
    if (!result.valid) {
      if (result.errors.some(code => ["brand_region_mismatch", "issuing_region_invalid"].includes(code))) setAdditionalOpen(true);
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
      draftId.current = walletOperationId();
      edited.current = { pan: false, expiry: false, cardholderName: false };
      setScanReading(null); setArtwork(undefined);
      setCardholderName("");
      setExpiry("");
      setNetwork("");
      setIssuingRegion("");
      setAdditionalOpen(false);
    } catch {
      // Raw service errors can contain request details; keep the draft for retry.
      toast.error("Your card could not be saved. Please try again.");
    } finally {
      saving.current = false;
      setSubmitting(false);
    }
  };

  const scanner = scanEnabled ? <WalletCardScanner key={ownerKey} active={draftVisible} disabled={submitting} featured={scanInToolbar && !scanReading} showPhotoActions={!scanInToolbar} onBusyChange={setScanning} onRead={(draft) => {
        setScanReading(draft); setArtwork(undefined);
        if (draft.fields.pan && (!edited.current.pan || !pan.trim())) setPan(draft.fields.pan);
        if (draft.fields.expiry && (!edited.current.expiry || !expiry.trim())) setExpiry(draft.fields.expiry);
        if (draft.fields.cardholderName && (!edited.current.cardholderName || !cardholderName.trim())) setCardholderName(draft.fields.cardholderName);
        setNetwork(""); setErrors([]);
      }} /> : null;

  return (
    <>
    {scanInToolbar ? <div className="mb-3.5">{scanner}</div> : null}
    <form
      className={cn(styles.form, compact && styles.compact)}
      aria-label="Add a card"
      data-testid="secure-card-add-form"
      onSubmit={handleSubmit}
      noValidate
      aria-busy={submitting || scanning}
    >
      {showIntroduction && !compact ? <div className={styles.heading}>
        <h2 className={TYPOGRAPHY_CLASSNAMES.sectionTitle}>Add your card</h2>
        <p>Enter the details printed on your card.</p>
      </div> : null}
      {!scanInToolbar ? scanner : null}
      {draftVisible && scanReading ? <p role="status" className={TYPOGRAPHY_CLASSNAMES.helperText} data-testid="wallet-scan-field-status">{(["pan", "cardholderName", "expiry"] as const).map(key => `${key === "pan" ? "Number" : key === "expiry" ? "Expiry" : "Name"}: ${edited.current[key] ? "edited" : scanReading.states[key].replace("_", " ")}`).join(" · ")}</p> : null}
      {draftVisible && (scanReading || digits.length >= 13) ? <div className="mx-auto w-full max-w-[26.5rem]">
        <WalletCardFace artwork={artworkVisible ? artwork : undefined} cardholderName={cardholderName} summary={{ cardId: "draft", nickname: "", brand, last4: digits.slice(-4), expiryMonth: Number(expiry.split("/")[0]) || 0, expiryYear: Number(expiry.split("/")[1]) || 0, issuingRegion, createdAt: "" }} />
      </div> : null}
      <fieldset disabled={submitting || scanning || !draftVisible} className={styles.fields}>
        {showIntroduction ? <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Encrypted on this device. Never enters chat.</p> : null}
        <div className={styles.row}>
          <div className={cn(styles.field, styles.number)}>
            <Label htmlFor={`${id}-number`}><ProfilePaneCardIcon className={styles.fieldIcon} />Card number</Label>
            <Input
              id={`${id}-number`}
              dir="ltr"
              value={draftVisible ? pan : ""}
              onChange={(event) => { edited.current.pan = true; setArtwork(undefined); setPan(event.target.value.replace(/\D/g, "").slice(0, 19)); }}
              inputMode="numeric"
              autoComplete="off"
              placeholder="XXXX XXXX XXXX XXXX"
              maxLength={32}
              required
              data-testid="secure-card-pan-input"
              {...fieldErrors("pan_length_invalid", "pan_checksum_invalid", "pan_length_invalid_for_brand")}
            />
            {networkHint ? <p className={cn(TYPOGRAPHY_CLASSNAMES.helperText, "text-muted-foreground")} role="status">{networkHint}</p> : null}
          </div>
          <div className={styles.field}>
            <Label htmlFor={`${id}-holder`}><ProfilePaneAccountIcon className={styles.fieldIcon} />Name on card</Label>
            <Input
              id={`${id}-holder`}
              value={draftVisible ? cardholderName : ""}
              onChange={(event) => { edited.current.cardholderName = true; setCardholderName(event.target.value); }}
              autoComplete="off"
              maxLength={80}
              required
              {...fieldErrors("cardholder_name_required", "cardholder_name_invalid")}
            />
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <Label htmlFor={`${id}-expiry`}><ProfilePaneCalendarIcon className={styles.fieldIcon} />Expiry (MM/YY)</Label>
            <Input
              id={`${id}-expiry`}
              value={draftVisible ? expiry : ""}
              onChange={(event) => { edited.current.expiry = true; setExpiry(event.target.value); }}
              inputMode="numeric"
              autoComplete="off"
              placeholder="MM/YY"
              maxLength={7}
              required
              {...fieldErrors("expiry_month_invalid", "expiry_year_invalid", "card_expired")}
            />
          </div>
        </div>
          <div className={styles.field}>
            <Label htmlFor={`${id}-network`}><ProfilePaneCardNetworkIcon className={styles.fieldIcon} />Card network (optional)</Label>
            <Select value={network || "auto"} onValueChange={(value) => setNetwork(value === "auto" ? "" : value as CardBrand)} disabled={submitting || scanning || !active}>
              <SelectTrigger id={`${id}-network`} className={styles.selectTrigger} data-testid="secure-card-network-select" {...fieldErrors("brand_invalid")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={styles.selectMenu}>
                <SelectItem value="auto">{brand !== "other" ? `Auto-detect · ${cardNetworkLabel(brand)}` : "Auto-detect"}</SelectItem>
                {supportedNetworks.map((value) => <SelectItem key={value} value={value}>{value === "other" ? "Other" : cardNetworkLabel(value)}</SelectItem>)}
              </SelectContent>
            </Select>
            {catalogFailed ? <div role="status" className={styles.scanHint}>
              <p>Network options could not load. Auto-detect is still available.</p>
              <Button type="button" variant="ghost" size="compact" disabled={submitting || scanning || !active} onClick={() => setCatalogRevision(value => value + 1)}>Retry network options</Button>
            </div> : null}
          </div>
        <details className={styles.additional} open={additionalOpen} onToggle={event => setAdditionalOpen(event.currentTarget.open)}>
          <summary>Additional details</summary>
          <div className={styles.fields}>
        <div className={styles.row}>
          <div className={styles.field}>
            <Label htmlFor={`${id}-region`}><ProfilePaneGlobeIcon className={styles.fieldIcon} />Issuing region (optional)</Label>
            <Select value={issuingRegion || "none"} onValueChange={(value) => setIssuingRegion(value === "none" ? "" : value)} disabled={submitting || scanning || !active}>
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
          </div>
        </details>
      </fieldset>
      {artworkEnabled ? <>
        <WalletBankDesignPicker key={bankContextKey} context={context} network={bankNetwork} country={issuingRegion || undefined} active={draftVisible && !submitting && !scanning && Boolean(currentReply?.result || (networkReply?.key === lookupKey && networkReply.result))} draftRevision={bankDraftRevision} onChange={setArtwork} onModeChange={enabled => setBankSelection(enabled ? bankContextKey : null)} suggest={suggestBankDesign ? (variants, signal) => suggestBankDesign(digits, variants, signal) : undefined} hasPhoto={Boolean(scanReading?.sanitized || scanReading?.candidate)} />
        <WalletCardArtworkPicker compact context={context} prefix={digits.length >= 13 ? digits.slice(0, 8) : ""} panLength={length} active={draftVisible && !submitting && !scanning && !bankMode} sanitized={scanReading?.sanitized} candidate={scanReading?.candidate} value={artwork} onChange={setArtwork} />
      </> : null}
      {errors.length > 0 ? (
        <ul ref={errorsRef} tabIndex={-1} role="alert" className={styles.errors} data-testid="secure-card-errors">
          {errors.map((code) => <li id={`${id}-${code}`} key={code}>{ERROR_COPY[code] ?? "Check your card details."}</li>)}
        </ul>
      ) : null}
      <FlowActionGroup
        className="mx-auto max-w-[244px]"
        stacked
        primary={<Button type="submit" size="prominent" disabled={submitting || scanning || networkLoading || !draftVisible} data-testid="secure-card-save">{submitting ? "Saving…" : "Add to Wallet"}</Button>}
        secondary={onCancel ? <Button type="button" variant="ghost" size="standard" className="bg-transparent hover:bg-transparent" onClick={onCancel} disabled={submitting}>Cancel</Button> : undefined}
      />
    </form>
    </>
  );
}
