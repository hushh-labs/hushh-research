"use client";

/**
 * Secure add-card form, shared by /one/wallet and the Agent One chat widget.
 * Card secrets stay in this form until the wallet service encrypts them with
 * the owner's vault key. They never enter a chat message or a Server Action.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from "react";
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
import { useBackLayer } from "@/lib/navigation/back-layers";
import { walletOperationId } from "@/lib/wallet/wallet-operation-id";
import { formatCardNumberInput, formatCardExpiryInput } from "@/lib/wallet/wallet-card-presentation";

import { WalletCardFace } from "./wallet-card-face";
import presentationStyles from "./wallet-connect-presentation.module.css";
import type { CardScanDraft } from "@/lib/services/wallet-card-scan";
import { WalletCardScanner } from "./wallet-card-scanner";
import styles from "./secure-card-add-form.module.css";

const ERROR_COPY: Record<string, string> = {
  pan_length_invalid: "Enter a complete card number.",
  pan_checksum_invalid: "Check the card number for a typo.",
  pan_length_invalid_for_brand: "The card number length does not match the selected network.",
  brand_invalid: "Choose a card network from the list.",
  brand_required: "Choose the card network to continue.",
  cardholder_name_required: "Enter the name on your card.",
  cardholder_name_invalid: "Use the name on your card, up to 80 characters.",
  issuing_region_invalid: "Choose a valid issuing region or leave it blank.",
  brand_region_mismatch: "This card network is not issued in the selected region.",
  expiry_month_invalid: "Enter a valid expiry month.",
  expiry_year_invalid: "Enter a valid expiry year.",
  card_expired: "This card is already expired.",
  security_code_invalid: "Enter a 3 or 4 digit CVV, or leave it blank.",
};

export interface SecureCardAddFormProps {
  onSubmit: (card: WalletCardInput) => Promise<void>;
  onCancel?: () => void;
  backRoute?: string;
  getNetworkContext?: () => WalletNetworkContext | null;
  compact?: boolean;
  showIntroduction?: boolean;
  /** Read a physical card locally, then review before saving. */
  scanEnabled?: boolean;
  /** Legacy host flag; approved network illustrations are assigned on save. */
  artworkEnabled?: boolean;
  scanInToolbar?: boolean;
  /** Enabled only by owner Wallet Add, never by the chat entry widget. */
  collectSecurityCode?: boolean;
  /** Mask entered details when a mounted draft is in an inactive tab. */
  active?: boolean;
  /** Compatibility label supplied by a chat offer; never asks for it again. */
  initialNickname?: string;
  /** Decrypted by the host from the owner's Secrets; never passed in a URL. */
  initialPan?: string;
}

export function SecureCardAddForm({ onSubmit, onCancel, backRoute, getNetworkContext, compact, showIntroduction = true, scanEnabled = true, scanInToolbar = false, collectSecurityCode = false, active = true, initialNickname, initialPan }: SecureCardAddFormProps) {
  const id = useId();
  const saving = useRef(false);
  useBackLayer(backRoute ?? "", backRoute && active && onCancel ? 2 : 0, () => {
    if (!active || !onCancel) return false;
    if (!saving.current) onCancel();
    return true;
  });
  const errorsRef = useRef<HTMLUListElement>(null);
  const [cardholderName, setCardholderName] = useState("");
  const [securityCode, setSecurityCode] = useState("");
  const [pan, setPan] = useState(initialPan ?? "");
  const [network, setNetwork] = useState<CardBrand | "">("");
  const draftId = useRef(walletOperationId());
  const edited = useRef({ pan: Boolean(initialPan), expiry: false, cardholderName: false });
  const [scanReading, setScanReading] = useState<CardScanDraft | null>(null);
  const [expiry, setExpiry] = useState("");
  const [issuingRegion, setIssuingRegion] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const nameCaret = useRef<{ input: HTMLInputElement; start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    const pending = nameCaret.current; nameCaret.current = null;
    if (pending && document.activeElement === pending.input) pending.input.setSelectionRange(pending.start, pending.end);
  }, [cardholderName]);
  const entryCaret = useRef<{ input: HTMLInputElement; digits: number } | null>(null);
  useLayoutEffect(() => {
    const pending = entryCaret.current;
    entryCaret.current = null;
    if (!pending || document.activeElement !== pending.input) return;
    let position = 0, count = 0;
    while (position < pending.input.value.length && count < pending.digits) {
      if (/\d/.test(pending.input.value[position]!)) count++;
      position++;
    }
    if (/[ /]/.test(pending.input.value[position] ?? "")) position++;
    pending.input.setSelectionRange(position, position);
  }, [pan, expiry]);
  const changeEntry = (event: ChangeEvent<HTMLInputElement>, field: "pan" | "expiry") => {
    const input = event.currentTarget;
    const previous = field === "pan" ? formatCardNumberInput(pan) : expiry;
    let digits = input.value.replace(/\D/g, "");
    let before = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, "").length;
    const deletion = (event.nativeEvent as InputEvent).inputType;
    // Deleting a generated separator also removes its adjacent digit.
    if (deletion?.startsWith("delete") && input.value.length < previous.length && digits === previous.replace(/\D/g, "")) {
      const index = deletion === "deleteContentBackward" ? Math.max(0, before - 1) : before;
      digits = digits.slice(0, index) + digits.slice(index + 1);
      before = index;
    }
    edited.current[field] = true;
    entryCaret.current = { input, digits: before };
    if (field === "pan") setPan(digits.slice(0, 19));
    else setExpiry(formatCardExpiryInput(digits));
  };
  useEffect(() => { if (!active) { setScanReading(null); } }, [active]);
  useEffect(() => { if (!active || !collectSecurityCode) setSecurityCode(""); }, [active, collectSecurityCode]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") setSecurityCode(""); };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
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
  useEffect(() => {
    if (previousOwner.current === ownerKey) return;
    previousOwner.current = ownerKey;
    setPan(""); setCardholderName(""); setExpiry(""); setNetwork(""); setScanReading(null); setSecurityCode("");
    setIssuingRegion(""); setErrors([]); entryCaret.current = null;
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
  const networkLengthMismatch = length >= 12 && length <= 19 && !isCardPanLengthValid(length, network || brand);
  const networkHint = networkLengthMismatch ? ERROR_COPY.pan_length_invalid_for_brand : networkLoading || !currentReply ? null : !currentReply.result
    ? "Choose the card network to continue."
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
    if (!active || !current || !prefix || length < 12 || length > 19) return;
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
      expiryMonth: Number(match?.[1] ?? 0),
      expiryYear: match ? (rawYear < 100 ? 2000 + rawYear : rawYear) : 0,
      issuingRegion: issuingRegion || undefined,
      ...(collectSecurityCode && securityCode ? { securityCode } : {}),
    };
    const result = validateCardForRegion({ ...card, brand: network || brand });
    if (!network && brand === "other") result.errors.push("brand_required");
    result.valid = result.errors.length === 0;
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
      draftId.current = walletOperationId();
      edited.current = { pan: false, expiry: false, cardholderName: false };
      setScanReading(null);
      setCardholderName("");
      setSecurityCode("");
      setExpiry("");
      setNetwork("");
      setIssuingRegion("");
    } catch {
      // Raw service errors can contain request details; keep the draft for retry.
      toast.error("Your card could not be saved. Please try again.");
    } finally {
      saving.current = false;
      setSubmitting(false);
    }
  };

  const scanner = scanEnabled ? <WalletCardScanner backRoute={backRoute} key={ownerKey} active={draftVisible} disabled={submitting} featured={scanInToolbar && !scanReading} showPhotoActions={!scanInToolbar || Boolean(scanReading)} onBusyChange={setScanning} onRead={(draft) => {
        setScanReading(draft);
        if (draft.fields.pan && (!edited.current.pan || !pan.trim())) setPan(draft.fields.pan);
        if (draft.fields.expiry && (!edited.current.expiry || !expiry.trim())) setExpiry(formatCardExpiryInput(draft.fields.expiry));
        if (draft.fields.cardholderName && (!edited.current.cardholderName || !cardholderName.trim())) setCardholderName(draft.fields.cardholderName.toUpperCase());
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
      {draftVisible && (scanReading || digits.length >= 12) ? <div className="mx-auto w-full max-w-[26.5rem]">
        <WalletCardFace cardholderName={cardholderName} summary={{ cardId: "draft", nickname: "", brand, last4: digits.slice(-4), expiryMonth: Number(expiry.split("/")[0]) || 0, expiryYear: Number(expiry.split("/")[1]) || 0, issuingRegion, createdAt: "" }} />
      </div> : null}
      <fieldset disabled={submitting || scanning || !draftVisible} className={styles.fields}>
        {showIntroduction ? <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Encrypted on this device. Never enters chat.</p> : null}
        <div className={styles.row}>
          <div className={cn(styles.field, styles.number)}>
            <Label htmlFor={`${id}-number`}><ProfilePaneCardIcon className={styles.fieldIcon} />Card number<sup aria-hidden="true" className={styles.required} /></Label>
            <Input
              id={`${id}-number`}
              dir="ltr"
              value={draftVisible ? formatCardNumberInput(pan) : ""}
              onChange={(event) => changeEntry(event, "pan")}
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
            <Label htmlFor={`${id}-holder`}><ProfilePaneAccountIcon className={styles.fieldIcon} />Name on card<sup aria-hidden="true" className={styles.required} /></Label>
            <Input
              id={`${id}-holder`}
              value={draftVisible ? cardholderName : ""}
              onChange={(event) => {
                const input = event.currentTarget;
                nameCaret.current = { input, start: input.value.slice(0, input.selectionStart ?? input.value.length).toUpperCase().length, end: input.value.slice(0, input.selectionEnd ?? input.value.length).toUpperCase().length };
                edited.current.cardholderName = true; setCardholderName(input.value.toUpperCase());
              }}
              autoCapitalize="characters"
              spellCheck={false}
              autoComplete="off"
              maxLength={80}
              required
              {...fieldErrors("cardholder_name_required", "cardholder_name_invalid")}
            />
          </div>
        </div>
        <div className={cn(styles.row, styles.pairedRow)}>
          <div className={styles.field}>
            <Label htmlFor={`${id}-expiry`}><ProfilePaneCalendarIcon className={styles.fieldIcon} />Expiry (MM/YY)<sup aria-hidden="true" className={styles.required} /></Label>
            <Input
              id={`${id}-expiry`}
              value={draftVisible ? expiry : ""}
              onChange={(event) => changeEntry(event, "expiry")}
              inputMode="numeric"
              autoComplete="off"
              placeholder="MM/YY"
              maxLength={7}
              required
              {...fieldErrors("expiry_month_invalid", "expiry_year_invalid", "card_expired")}
            />
          </div>
          <div className={styles.field}>
            <Label htmlFor={`${id}-network`}><ProfilePaneCardNetworkIcon className={styles.fieldIcon} />Card network<sup aria-hidden="true" className={styles.required} /></Label>
            <Select required value={network || "auto"} onValueChange={(value) => setNetwork(value === "auto" ? "" : value as CardBrand)} disabled={submitting || scanning || !active}>
              <SelectTrigger id={`${id}-network`} aria-required="true" className={styles.selectTrigger} data-testid="secure-card-network-select" {...fieldErrors("brand_invalid", "brand_required")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={cn(styles.selectMenu, presentationStyles.walletPortal)}>
                <SelectItem value="auto">{brand !== "other" ? `Auto-detect · ${cardNetworkLabel(brand)}` : "Auto-detect"}</SelectItem>
                {(supportedNetworks.length ? supportedNetworks : ["other"]).map((value) => <SelectItem key={value} value={value}>{value === "other" ? "Other" : cardNetworkLabel(value)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        {catalogFailed ? <div role="status" className={styles.scanHint}>
          <p>Network options could not load. Auto-detect is still available.</p>
          <Button type="button" variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={submitting || scanning || !active} onClick={() => setCatalogRevision(value => value + 1)}>Retry network options</Button>
        </div> : null}
        <div className={styles.row}>
          <div className={styles.field}>
            <Label htmlFor={`${id}-region`}><ProfilePaneGlobeIcon className={styles.fieldIcon} />Issuing region</Label>
            <Select value={issuingRegion || "none"} onValueChange={(value) => setIssuingRegion(value === "none" ? "" : value)} disabled={submitting || scanning || !active}>
              <SelectTrigger id={`${id}-region`} className={styles.selectTrigger} data-testid="secure-card-region-select" {...fieldErrors("issuing_region_invalid", "brand_region_mismatch")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={cn(styles.selectMenu, presentationStyles.walletPortal)}>
                <SelectItem value="none">Select region…</SelectItem>
                {COUNTRY_PHONE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {collectSecurityCode ? <div className={styles.field}>
            <Label htmlFor={`${id}-security-code`}><ProfilePaneCardIcon className={styles.fieldIcon} />CVV</Label>
            <Input id={`${id}-security-code`} type="password" inputMode="numeric" autoComplete="off" maxLength={4}
              value={draftVisible ? securityCode : ""} placeholder="3 or 4 digits"
              onChange={event => setSecurityCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
              {...fieldErrors("security_code_invalid")} />
            <p className={styles.scanHint}>Only visible to you in Wallet.</p>
          </div> : null}
        </div>
      </fieldset>
      {errors.length > 0 ? (
        <ul ref={errorsRef} tabIndex={-1} role="alert" className={styles.errors} data-testid="secure-card-errors">
          {errors.map((code) => <li id={`${id}-${code}`} key={code}>{ERROR_COPY[code] ?? "Check your card details."}</li>)}
        </ul>
      ) : null}
      <FlowActionGroup
        className={styles.actions}
        separateSecondary={false}
        primary={<Button type="submit" size="prominent" disabled={submitting || scanning || networkLoading || !draftVisible} data-testid="secure-card-save">{submitting ? "Saving…" : "Add to Wallet"}</Button>}
        secondary={onCancel ? <Button type="button" variant="ghost" size="prominent" className="bg-transparent hover:bg-transparent" onClick={onCancel} disabled={submitting}>Cancel</Button> : undefined}
      />
    </form>
    </>
  );
}
