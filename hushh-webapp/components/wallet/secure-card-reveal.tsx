"use client";

/**
 * Secure on-device card reveal, shared by /one/wallet and the Agent One chat
 * widget. The browser decrypts the card under the vault key and renders it
 * here; the values never enter chat messages, model context, telemetry or
 * browser storage. They are held in component state only, and they leave the
 * screen after a short window, on Hide, or as soon as the page is hidden
 * (the app sent to the background, the tab switched away).
 */

import { useCallback, useEffect, useState } from "react";

import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { Check, Copy } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import type {
  WalletCardSecrets,
  WalletCardSummary,
} from "@/lib/services/wallet-service";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";
import { formatCardExpiry, formatCardNumber } from "@/lib/wallet/wallet-card-presentation";

const AUTO_HIDE_SECONDS = 45;
const COPIED_MS = 2000;

export interface SecureCardRevealProps {
  summary: WalletCardSummary;
  secrets: WalletCardSecrets;
  onDismiss?: () => void;
  /** When set, hiding (tap or auto-hide) hands control back immediately, with no interstitial. */
  onHide?: () => void;
  /**
   * Draw the revealed card face above the details. The Wallet page passes
   * false because the focused card in its stack already shows the face.
   */
  showFace?: boolean;
}

type SecretRow = {
  id: string;
  /** What the confirmation names, e.g. "Card number copied." */
  noun: string;
  copyLabel: string;
  label: string;
  value: string;
  copyValue: string;
  testId?: string;
};

function rowsFor(summary: WalletCardSummary, secrets: WalletCardSecrets): SecretRow[] {
  const rows: SecretRow[] = [
    {
      id: "number",
      noun: "Card number",
      copyLabel: "Copy card number",
      label: "Card number",
      value: formatCardNumber(summary.brand, secrets.pan),
      copyValue: secrets.pan,
      testId: "secure-card-reveal-pan",
    },
    {
      id: "expiry",
      noun: "Expiry date",
      copyLabel: "Copy expiry date",
      label: "Expires",
      value: formatCardExpiry(summary.expiryMonth, summary.expiryYear),
      copyValue: `${String(summary.expiryMonth).padStart(2, "0")}/${summary.expiryYear}`,
    },
  ];
  if (secrets.cvv) {
    rows.push({ id: "cvv", noun: "CVV", copyLabel: "Copy CVV", label: "CVV", value: secrets.cvv, copyValue: secrets.cvv });
  }
  if (secrets.pin) {
    rows.push({ id: "pin", noun: "PIN", copyLabel: "Copy PIN", label: "PIN", value: secrets.pin, copyValue: secrets.pin });
  }
  if (secrets.cardholderName) {
    rows.push({
      id: "name",
      noun: "Name on card",
      copyLabel: "Copy name on card",
      label: "Name on card",
      value: secrets.cardholderName,
      copyValue: secrets.cardholderName,
    });
  }
  return rows;
}

export function SecureCardReveal({
  summary,
  secrets,
  onDismiss,
  onHide,
  showFace = true,
}: SecureCardRevealProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_HIDE_SECONDS);
  const [hidden, setHidden] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const hide = useCallback(() => {
    if (onHide) {
      onHide();
      return;
    }
    setHidden(true);
  }, [onHide]);

  useEffect(() => {
    if (hidden) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hidden]);

  useEffect(() => {
    if (!hidden && secondsLeft === 0) hide();
  }, [hidden, hide, secondsLeft]);

  // Leaving the app hides the card, so it is not on screen when the person
  // returns or in the app switcher's snapshot.
  useEffect(() => {
    if (hidden) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [hidden, hide]);

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(null), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const copy = async (row: SecretRow) => {
    try {
      await navigator.clipboard.writeText(row.copyValue);
      setCopiedId(row.id);
      setAnnouncement(`${row.noun} copied.`);
    } catch {
      setCopiedId(null);
      setAnnouncement("Copying is not available here.");
    }
  };

  if (hidden) {
    return (
      <div
        className="flex min-h-14 w-full max-w-[26.5rem] items-center justify-between gap-3 rounded-[var(--app-radius-lg)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] pl-4 pr-2"
        data-testid="secure-card-reveal-hidden"
      >
        <span className={TYPOGRAPHY_CLASSNAMES.helperText}>Hidden again.</span>
        {onDismiss ? (
          <Button variant="secondary" size="compact" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
    );
  }

  const title = summary.nickname || cardNetworkLabel(summary.brand);
  const rows = rowsFor(summary, secrets);

  return (
    <section
      aria-label={`${title} details`}
      className="flex w-full max-w-[26.5rem] flex-col gap-4"
      data-testid="secure-card-reveal"
    >
      {showFace ? (
        <WalletCardFace
          summary={summary}
          revealed={{ pan: secrets.pan, cardholderName: secrets.cardholderName }}
        />
      ) : null}

      <ul
        data-slot="secure-card-rows"
        className="m-0 list-none overflow-hidden rounded-[var(--app-radius-lg)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-0"
      >
        {rows.map((row, index) => {
          const copied = copiedId === row.id;
          return (
            <li key={row.id} className="relative">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-4 right-0 top-0 h-px bg-[color:var(--app-separator)]"
                />
              ) : null}
              <button
                type="button"
                onClick={() => void copy(row)}
                aria-label={row.copyLabel}
                data-testid={row.testId}
                data-copied={copied ? "true" : "false"}
                className="relative flex min-h-[60px] w-full items-center gap-3 overflow-hidden px-4 py-2 text-left outline-none focus-visible:bg-[color:var(--app-neutral-fill)]"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={TYPOGRAPHY_CLASSNAMES.helperText}>{row.label}</span>{" "}
                  <span className={cn(TYPOGRAPHY_CLASSNAMES.rowLabel, "truncate tabular-nums")}>
                    {row.value}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-6 shrink-0 items-center gap-1.5",
                    copied ? "text-[color:var(--app-accent)]" : "text-muted-foreground",
                  )}
                >
                  {copied ? (
                    <>
                      <Check className="size-4" />
                      <span className={TYPOGRAPHY_CLASSNAMES.statusText}>Copied</span>
                    </>
                  ) : (
                    <Copy className="size-5" />
                  )}
                </span>
                <MaterialRipple variant="none" effect="fade" />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex min-h-11 items-center justify-between gap-3 pl-4">
        <span className={TYPOGRAPHY_CLASSNAMES.helperText} data-testid="secure-card-countdown">
          Hides in {secondsLeft}s
        </span>
        <Button variant="secondary" size="compact" onClick={hide} data-testid="secure-card-hide">
          Hide
        </Button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
