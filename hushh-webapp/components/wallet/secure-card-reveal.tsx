import {
  CardNetworkMark,
  cardNetworkLabel,
} from "@/components/wallet/card-network-mark";
"use client";

/**
 * Secure on-device card reveal, shared by /one/wallet and the Agent One chat
 * widget. The browser decrypts the card under the vault key and renders it
 * here; the values never enter chat messages, model context, or telemetry.
 * Auto-hides after a short window.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  WalletCardSecrets,
  WalletCardSummary,
} from "@/lib/services/wallet-service";

const AUTO_HIDE_SECONDS = 45;

export interface SecureCardRevealProps {
  summary: WalletCardSummary;
  secrets: WalletCardSecrets;
  onDismiss?: () => void;
  /** When set, hiding (tap or auto-hide) hands control back immediately, with no interstitial. */
  onHide?: () => void;
}

function groupPan(pan: string): string {
  return pan.replace(/(.{4})/g, "$1 ").trim();
}

export function SecureCardReveal({ summary, secrets, onDismiss, onHide }: SecureCardRevealProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_HIDE_SECONDS);
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const hide = () => {
    if (onHide) {
      onHide();
      return;
    }
    setHidden(true);
  };

  useEffect(() => {
    if (hidden) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          hide();
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  if (hidden) {
    return (
      <div
        className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[var(--motion-duration-sm)] motion-safe:ease-[var(--motion-ease-decelerate)]"
        data-testid="secure-card-reveal-hidden"
      >
        Hidden again.
        {onDismiss ? (
          <Button variant="ghost" size="sm" className="ml-2" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="flex max-w-md flex-col gap-2 rounded-xl border border-border bg-card p-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-[var(--motion-duration-md)] motion-safe:ease-[var(--motion-ease-decelerate)]"
      data-testid="secure-card-reveal"
    >
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <CardNetworkMark brand={summary.brand} />
          <span className="truncate">
            {summary.nickname || cardNetworkLabel(summary.brand)} ·{" "}
            {cardNetworkLabel(summary.brand)} · {summary.issuingRegion}
          </span>
        </span>
        <span>hides in {secondsLeft}s</span>
      </div>
      <button
        type="button"
        className="text-left font-mono text-lg tracking-wider"
        onClick={() => copy("number", secrets.pan)}
        data-testid="secure-card-reveal-pan"
      >
        {groupPan(secrets.pan)}
      </button>
      <div className="flex gap-4 font-mono text-sm">
        <button type="button" onClick={() => copy("expiry", `${String(summary.expiryMonth).padStart(2, "0")}/${summary.expiryYear}`)}>
          Exp {String(summary.expiryMonth).padStart(2, "0")}/{String(summary.expiryYear).slice(-2)}
        </button>
        {secrets.cvv ? (
          <button type="button" onClick={() => copy("CVV", secrets.cvv)}>CVV {secrets.cvv}</button>
        ) : null}
        {secrets.pin ? (
          <button type="button" onClick={() => copy("PIN", secrets.pin)}>PIN {secrets.pin}</button>
        ) : null}
      </div>
      <div className="text-sm text-muted-foreground">{secrets.cardholderName}</div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{copied ? `Copied ${copied}.` : "Tap to copy."}</span>
        <Button variant="ghost" size="sm" onClick={hide} data-testid="secure-card-hide">
          Hide
        </Button>
      </div>
    </div>
  );
}
