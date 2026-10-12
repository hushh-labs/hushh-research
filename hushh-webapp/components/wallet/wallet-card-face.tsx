/**
 * One card, drawn as the object it is: the ISO/IEC 7810 ID-1 proportion
 * (85.60 x 53.98 mm), the standard's corner radius scaled to the card, and
 * one of the owner's twenty supplied finishes selected by immutable card id.
 *
 * Masked, it is built from the summary (nickname, network, last four,
 * expiry, region) and an optional owner-only name projection. Revealed, the
 * caller passes the decrypted number; it lives only in memory for as long
 * as the reveal is on screen. CVV and PIN never belong on a card face.
 */

import type { ReactNode } from "react";

import { CardNetworkWordmark, cardNetworkLabel } from "@/components/wallet/card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { cn } from "@/lib/utils";
import {
  CARD_CORNER_RADIUS_RATIO,
  formatCardExpiry,
  formatCardNumber,
  maskedCardNumberGroups,
} from "@/lib/wallet/wallet-card-presentation";
import { paymentCardArtwork } from "@/lib/wallet/wallet-payment-card-artwork";

import styles from "./wallet-payment-card-artwork.module.css";

export interface WalletCardFaceProps {
  summary: WalletCardSummary;
  /** Decrypted owner-only display projection, never a chat/index summary. */
  cardholderName?: string;
  /** Retained for callers; all payment-card surfaces share one finish. */
  collection?: boolean;
  revealed?: { pan: string; cardholderName: string } | null;
  /** Overlay slot (the press ripple), clipped to the card's corners. */
  children?: ReactNode;
  className?: string;
}

function FaceField({
  caption,
  value,
  align = "start",
  slot,
}: {
  caption: string;
  value: string;
  align?: "start" | "end";
  slot: string;
}) {
  return (
    <span
      data-slot={slot}
      className={cn(styles.field, align === "end" && styles.fieldEnd)}
    >
      <span className={styles.caption}>
        {caption}
      </span>
      <span className={styles.value}>
        {value}
      </span>
    </span>
  );
}

export function WalletCardFace({ summary, cardholderName, revealed, children, className }: WalletCardFaceProps) {
  const artwork = paymentCardArtwork(summary.cardId);
  const network = cardNetworkLabel(summary.brand);
  const title = summary.nickname?.trim();
  const groups = revealed
    ? formatCardNumber(summary.brand, revealed.pan).split(" ")
    : maskedCardNumberGroups(summary.brand, summary.last4);
  const expiry = formatCardExpiry(summary.expiryMonth, summary.expiryYear);
  const holder = revealed?.cardholderName || cardholderName;
  const accessibleLast4 = /^\d{4}$/.test(summary.last4) ? summary.last4 : "hidden";

  return (
    // The container is what the corner radius is measured against.
    <div className={cn(styles.container, className)}>
      <div
        data-testid="wallet-card-face"
        data-card-artwork={artwork.id}
        data-revealed={revealed ? "true" : "false"}
        className={cn(styles.face, styles[`art${artwork.id.toUpperCase()}`])}
        style={{
          borderRadius: `calc(100cqw * ${CARD_CORNER_RADIUS_RATIO})`,
        }}
      >
        <span className={styles.content}>
          <span data-slot="wallet-card-top" className={styles.top}>
            <span className={styles.title}>
              {title && title.toLowerCase() !== network.toLowerCase() ? title : null}
            </span>
            <CardNetworkWordmark brand={summary.brand} className={styles.network} />
          </span>

          <span className={styles.chip} aria-hidden="true">
            <svg viewBox="0 0 48 36" width="100%" height="100%" fill="none" stroke="currentColor">
              <rect x="16" y="9" width="16" height="18" rx="4" />
              <path d="M16 13H0m16 10H0m32-10h16M32 23h16M20 9V0m8 9V0M20 27v9m8-9v9" />
            </svg>
          </span>
          <span
            data-slot="wallet-card-number"
            className={styles.number}
          >
            <span className="sr-only">
              {revealed
                ? `Card number ${formatCardNumber(summary.brand, revealed.pan)}`
                : `${network} ending ${accessibleLast4}`}
            </span>
            {groups.map((group, index) => (
              <span key={index} aria-hidden="true">
                {group}
              </span>
            ))}
          </span>
          <span data-slot="wallet-card-bottom" className={styles.bottom}>
            {holder ? (
              <FaceField slot="wallet-card-holder" caption="Cardholder" value={holder} />
            ) : (
              <FaceField slot="wallet-card-region" caption="Issued in" value={summary.issuingRegion || "Not saved"} />
            )}
            <FaceField slot="wallet-card-expiry" caption="Expires" value={expiry} align="end" />
            {holder && summary.issuingRegion ? (
              <FaceField slot="wallet-card-region" caption="Region" value={summary.issuingRegion} align="end" />
            ) : null}
          </span>
        </span>
        {children}
      </div>
    </div>
  );
}
