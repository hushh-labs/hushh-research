/**
 * One card, drawn as the object it is: the ISO/IEC 7810 ID-1 proportion
 * (85.60 x 53.98 mm), the standard's corner radius scaled to the card, and
 * approved original artwork or a neutral fallback.
 *
 * Masked, it is built from the summary (nickname, network, last four,
 * expiry, region) and an optional owner-only name projection. Revealed, the
 * caller passes the decrypted number; it lives only in memory for as long
 * as the reveal is on screen. CVV and PIN never belong on a card face.
 */

"use client";

import { useState, type ReactNode } from "react";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";

import { CardNetworkWordmark, cardNetworkLabel } from "@/components/wallet/card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { cn } from "@/lib/utils";
import {
  CARD_CORNER_RADIUS_RATIO,
  formatCardExpiry,
  formatCardNumber,
  maskedCardNumberGroups,
} from "@/lib/wallet/wallet-card-presentation";
import type { WalletCardArtwork } from "@/lib/wallet/card-artwork";

import styles from "./wallet-payment-card-artwork.module.css";

export interface WalletCardFaceProps {
  summary: WalletCardSummary;
  artwork?: WalletCardArtwork;
  /** Approval/recovery is in progress; do not paint the settled fallback yet. */
  artworkPending?: boolean;
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

function FaceNumber({ groups, label, className }: { groups: string[]; label: string; className?: string }) {
  return <span data-slot="wallet-card-number" className={cn(styles.number, className)}>
    <span className="sr-only">{label}</span>
    {groups.map((group, index) => <span key={index} aria-hidden="true">{group}</span>)}
  </span>;
}

export function WalletCardFace({ summary, artwork, artworkPending = false, cardholderName, revealed, children, className }: WalletCardFaceProps) {
  const [imageShape, setImageShape] = useState<{ digest: string; image: string; ratio: number; failed: boolean } | null>(null);
  const network = cardNetworkLabel(summary.brand);
  const title = summary.nickname?.trim();
  const groups = revealed
    ? formatCardNumber(summary.brand, revealed.pan).split(" ")
    : maskedCardNumberGroups(summary.brand, summary.last4);
  const expiry = formatCardExpiry(summary.expiryMonth, summary.expiryYear);
  const holder = revealed?.cardholderName || cardholderName;
  const accessibleLast4 = /^\d{4}$/.test(summary.last4) ? summary.last4 : "hidden";
  const numberLabel = revealed ? `Card number ${formatCardNumber(summary.brand, revealed.pan)}` : `${network} ending ${accessibleLast4}`;
  const printedDetails = <span data-slot="wallet-card-embedded-details" className={styles.artworkDetails}>
    <FaceNumber groups={groups} label={numberLabel} className={styles.artworkNumber} />
    <span className={styles.artworkBottom}>
      <FaceField slot="wallet-card-holder" caption="Cardholder" value={holder || network} />
      <FaceField slot="wallet-card-expiry" caption="Valid thru" value={expiry} align="end" />
    </span>
  </span>;
  if (artworkPending) return <div className={cn(styles.container, className)}>
    <div data-testid="wallet-card-face" data-card-artwork="pending" data-artwork-ready="false" data-revealed={revealed ? "true" : "false"} aria-busy="true" className={cn(styles.face, styles.pendingFace)} style={{ borderRadius: `calc(100cqw * ${CARD_CORNER_RADIUS_RATIO})` }}>
      <span role="status" className="sr-only">Loading card design</span>{printedDetails}{children}
    </div>
  </div>;
  const currentImage = artwork && artwork.source !== "neutral" && imageShape?.digest === artwork.digest && imageShape.image === artwork.image ? imageShape : null;

  if (artwork && artwork.source !== "neutral" && !currentImage?.failed) {
    const overlayAllowed = artwork.source === "catalog" && artwork.allowOverlay;
    const cardRatio = 85.6 / 53.98;
    // Current personalized designs are reviewed in the default landscape
    // proportion. Photos and external restricted originals remain contained.
    const imageRatio = overlayAllowed ? cardRatio : currentImage?.ratio ?? cardRatio;
    const imageReady = Boolean(currentImage);
    return <div className={cn(styles.container, className)}>
    <div data-testid="wallet-card-face" data-card-artwork={artwork.source} data-artwork-asset-id={artwork.source === "catalog" ? artwork.assetId : undefined} data-artwork-digest={artwork.digest} data-artwork-ready={imageReady ? "true" : "false"} data-revealed={revealed ? "true" : "false"} aria-busy={!imageReady} className={cn(styles.face, styles.pendingFace)} style={{ borderRadius: `calc(100cqw * ${CARD_CORNER_RADIUS_RATIO})` }}>
      {!imageReady ? <span role="status" className="sr-only">Loading card design</span> : null}
      <div data-slot="wallet-card-artwork-plane" data-artwork-orientation={imageRatio < 1 ? "portrait" : "landscape"} className={styles.artworkPlane} style={{ width: `${Math.min(1, imageRatio / cardRatio) * 100}%`, height: `${Math.min(1, cardRatio / imageRatio) * 100}%` }}>
        {/* Original approved pixels stay intact; owner details are a separate display layer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={artwork.image} alt={title || "Your card design"} className="absolute inset-0 h-full w-full" style={{ objectFit: overlayAllowed ? "fill" : "contain" }} onLoad={event => {
          const image = event.currentTarget;
          if (image.naturalWidth && image.naturalHeight) setImageShape({ digest: artwork.digest, image: artwork.image, ratio: image.naturalWidth / image.naturalHeight, failed: false });
        }} onError={() => setImageShape({ digest: artwork.digest, image: artwork.image, ratio: cardRatio, failed: true })} />
        {overlayAllowed ? printedDetails : null}
      </div>
      {children}
    </div>
    {!overlayAllowed ? <p className={cn(TYPOGRAPHY_CLASSNAMES.helperText, "mt-2 text-center")}>{holder || network} · {revealed ? formatCardNumber(summary.brand, revealed.pan) : `•••• ${accessibleLast4}`} · {expiry}</p> : null}
  </div>;
  }
  return (
    // The container is what the corner radius is measured against.
    <div className={cn(styles.container, className)}>
      <div
        data-testid="wallet-card-face"
        data-card-artwork="neutral"
        data-revealed={revealed ? "true" : "false"}
        className={styles.face}
        style={{
          borderRadius: `calc(100cqw * ${CARD_CORNER_RADIUS_RATIO})`,
          background: "#172a46",
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
          <FaceNumber groups={groups} label={numberLabel} />
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
