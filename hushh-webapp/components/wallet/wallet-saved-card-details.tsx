"use client";

import { useState } from "react";
import { Check, RefreshCw } from "@/components/icons";
import {
  ProfilePaneAccountIcon,
  ProfilePaneCalendarIcon,
  ProfilePaneCardIcon,
  ProfilePaneCopyIcon,
  ProfilePaneCardNetworkIcon,
  ProfilePaneDeleteIcon,
  ProfilePaneGlobeIcon,
  ProfilePaneKeyIcon,
  ProfilePaneSecurityIcon,
} from "@/components/profile/profile-pane-icons";
import { SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { formatCardNumber } from "@/lib/wallet/wallet-card-presentation";
import { cardNetworkLabel } from "./card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";

export function WalletSavedCardDetails({ card, name, pan, numberUnavailable = false, onRetryNumber, onCopyCardNumber, onRemove, disabled = false }: {
  card: WalletCardSummary;
  name?: string;
  pan?: string;
  numberUnavailable?: boolean;
  onRetryNumber?: () => void;
  onCopyCardNumber: () => Promise<boolean>;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const [copying, setCopying] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const expiry = `${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).slice(-2)}`;
  const network = cardNetworkLabel(card.brand);
  const rows = [
    { icon: ProfilePaneCardIcon, label: "Card number", value: pan ? formatCardNumber(card.brand, pan) : numberUnavailable ? "Unavailable" : "Loading…", copy: onCopyCardNumber },
    { icon: ProfilePaneAccountIcon, label: "Name on card", value: name || "Not provided", copyValue: name },
    { icon: ProfilePaneCardNetworkIcon, label: "Card network", value: network, copyValue: network },
    { icon: ProfilePaneCalendarIcon, label: "Expiry (MM/YY)", value: expiry, copyValue: expiry, copyLabel: "Copy expiry date" },
    { icon: ProfilePaneSecurityIcon, label: "CVV", value: "Hidden" },
    { icon: ProfilePaneKeyIcon, label: "PIN (optional)", value: "Hidden if saved" },
    { icon: ProfilePaneGlobeIcon, label: "Issuing region", value: card.issuingRegion || "Not provided", copyValue: card.issuingRegion },
  ];

  const copy = async (row: typeof rows[number]) => {
    if (copying || disabled) return;
    setCopying(row.label);
    setCopied(null);
    try {
      if (row.copy) {
        if (!await row.copy()) return;
      } else {
        if (!row.copyValue || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(row.copyValue);
      }
      setCopied(row.label);
      morphyToast.success("Copied.");
    } catch {
      morphyToast.error("Could not copy. Try again.");
    } finally {
      setCopying(null);
    }
  };

  return <SettingsPresentationProvider separatorInset density="compact">
    <section aria-label="Saved card details" className={`${profileStyles.walletContent} space-y-4`}>
      <SettingsGroup title="Card details">
        {rows.map((row) => <SettingsRow key={row.label} density="compact" icon={row.icon} iconTone="transparent" title={row.label} trailing={
          <span className="flex min-w-0 items-center justify-end gap-2">
            <span className="min-w-0 break-words text-right">{row.value}</span>
            {row.label === "Card number" && numberUnavailable && onRetryNumber ? <button type="button" className="inline-flex size-11 shrink-0 items-center justify-center text-[color:var(--app-accent)]" aria-label="Retry card number" onClick={onRetryNumber} disabled={disabled}><RefreshCw className="size-4" aria-hidden="true" /></button> : null}
            {row.copy || row.copyValue ? <button
              type="button"
              className="-my-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[color:var(--app-accent)] hover:bg-[color:var(--app-neutral-fill)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-accent)] disabled:opacity-50"
              aria-label={row.copyLabel || `Copy ${row.label.toLowerCase()}`}
              disabled={disabled || copying !== null}
              onClick={() => void copy(row)}
            >
              {copied === row.label ? <Check className="size-4" aria-hidden="true" /> : <ProfilePaneCopyIcon className="size-4" />}
            </button> : <span className="-my-0.5 size-11 shrink-0" aria-hidden="true" />}
          </span>
        } />)}
        <SettingsRow
          icon={ProfilePaneDeleteIcon}
          title="Remove card"
          description="Delete this saved card."
          className="profile-account-delete-row"
          tone="destructive"
          chevron
          disabled={disabled}
          onClick={onRemove}
          ariaLabel="Remove card"
          testId="one-wallet-remove"
        />
      </SettingsGroup>
    </section>
  </SettingsPresentationProvider>;
}
