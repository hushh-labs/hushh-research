"use client";

/**
 * Secure on-device card reveal, shared by /one/cards and the Agent One chat
 * widget. The browser decrypts the card under the vault key and renders it
 * here; the values never enter chat messages, model context, or telemetry.
 * Auto-hides after a short window.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  PaymentCardSecrets,
  PaymentCardSummary,
} from "@/lib/services/payment-cards-service";

const AUTO_HIDE_SECONDS = 45;

export interface SecureCardRevealProps {
  summary: PaymentCardSummary;
  secrets: PaymentCardSecrets;
  onDismiss?: () => void;
}

function groupPan(pan: string): string {
  return pan.replace(/(.{4})/g, "$1 ").trim();
}

export function SecureCardReveal({ summary, secrets, onDismiss }: SecureCardRevealProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_HIDE_SECONDS);
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (hidden) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          setHidden(true);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
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
        className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground"
        data-testid="secure-card-reveal-hidden"
      >
        Card details were shown privately on this device and are hidden again.
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
      className="flex max-w-md flex-col gap-2 rounded-xl border border-border bg-card p-4"
      data-testid="secure-card-reveal"
    >
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {summary.nickname || summary.brand} · {summary.brand} · {summary.issuingRegion}
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
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{copied ? `Copied ${copied}.` : "Tap a value to copy it."}</span>
        <Button variant="ghost" size="sm" onClick={() => setHidden(true)} data-testid="secure-card-hide">
          Hide now
        </Button>
      </div>
    </div>
  );
}
