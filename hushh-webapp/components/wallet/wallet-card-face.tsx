/**
 * One card, drawn as the object it is: the ISO/IEC 7810 ID-1 proportion
 * (85.60 x 53.98 mm), the standard's corner radius scaled to the card, a flat
 * face tone of Hussh's own and a single photographic shadow.
 *
 * Masked, it is built from the summary alone (nickname, network, last four,
 * expiry, region) and never receives the full number. Revealed, the caller
 * passes the decrypted number and name; both live only in memory for as long
 * as the reveal is on screen.
 */

import type { ReactNode } from "react";

import { CardNetworkWordmark, cardNetworkLabel } from "@/components/wallet/card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { cn } from "@/lib/utils";
import {
  CARD_CORNER_RADIUS_RATIO,
  cardFaceTone,
  formatCardExpiry,
  formatCardNumber,
  maskedCardNumberGroups,
} from "@/lib/wallet/wallet-card-presentation";

export interface WalletCardFaceProps {
  summary: WalletCardSummary;
  /** Add collection finish; the default Cards surface remains unchanged. */
  collection?: boolean;
  revealed?: { pan: string; cardholderName: string } | null;
  /** Overlay slot (the press ripple), clipped to the card's corners. */
  children?: ReactNode;
  className?: string;
}

const FACE_SHADOW = "inset 0 0 0 1px rgb(255 255 255 / 0.08), var(--app-shadow-product)";

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
      className={cn("flex min-w-0 flex-col", align === "end" ? "items-end text-right" : "items-start")}
    >
      <span className="text-[11px] font-semibold leading-[13px] tracking-[0.02em] text-white/[0.72]">
        {caption}
      </span>
      <span className="max-w-full truncate text-[13px] font-semibold leading-4 tracking-[0.02em] text-white tabular-nums">
        {value}
      </span>
    </span>
  );
}

export function WalletCardFace({ summary, revealed, children, className, collection = false }: WalletCardFaceProps) {
  const tone = cardFaceTone(summary.cardId);
  const network = cardNetworkLabel(summary.brand);
  const title = summary.nickname || network;
  const groups = revealed
    ? formatCardNumber(summary.brand, revealed.pan).split(" ")
    : maskedCardNumberGroups(summary.brand, summary.last4);
  const expiry = formatCardExpiry(summary.expiryMonth, summary.expiryYear);

  return (
    // The container is what the corner radius is measured against.
    <div className={cn("@container w-full", className)}>
      <div
        data-testid="wallet-card-face"
        data-card-tone={tone.id}
        data-revealed={revealed ? "true" : "false"}
        className="relative isolate flex aspect-[85.6/53.98] w-full flex-col justify-between overflow-hidden p-5 text-left text-white"
        style={{
          backgroundColor: tone.background,
          borderRadius: `calc(100cqw * ${CARD_CORNER_RADIUS_RATIO})`,
          boxShadow: FACE_SHADOW,
        }}
      >
        <span data-slot="wallet-card-top" className="flex h-5 items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[15px] font-semibold leading-5 text-white">
            {title}
          </span>
          <CardNetworkWordmark brand={summary.brand} />
        </span>

        {collection ? <span className="flex items-center gap-3" aria-hidden="true">
          <svg viewBox="0 0 48 36" className="h-[7cqw] w-[9cqw] text-white/70" fill="none">
            <rect x="1" y="1" width="46" height="34" rx="7" fill="currentColor" fillOpacity=".16" stroke="currentColor" />
            <rect x="16" y="9" width="16" height="18" rx="4" stroke="currentColor" />
            <path d="M16 13H1m15 10H1m31-10h15M32 23h15M20 9V1m8 8V1M20 27v8m8-8v8" stroke="currentColor" />
          </svg>
          <svg viewBox="0 0 24 28" className="h-[6cqw] w-[5cqw] text-white/60" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M5 10a8 8 0 0 1 0 8m5-12a15 15 0 0 1 0 16m5-20a22 22 0 0 1 0 24" />
          </svg>
        </span> : null}
        <span className="flex flex-col gap-3">
          <span
            data-slot="wallet-card-number"
            className="flex flex-wrap gap-x-2 text-[17px] font-semibold leading-[22px] tracking-[0.06em] text-white tabular-nums"
          >
            <span className="sr-only">
              {revealed
                ? `Card number ${formatCardNumber(summary.brand, revealed.pan)}`
                : `${network} ending ${summary.last4}`}
            </span>
            {groups.map((group, index) => (
              <span key={index} aria-hidden="true">
                {group}
              </span>
            ))}
          </span>
          <span data-slot="wallet-card-bottom" className="flex items-end justify-between gap-4">
            {revealed ? (
              <FaceField slot="wallet-card-holder" caption="Cardholder" value={revealed.cardholderName || "Not saved"} />
            ) : (
              <FaceField slot="wallet-card-region" caption="Issued in" value={summary.issuingRegion || "Not saved"} />
            )}
            <FaceField slot="wallet-card-expiry" caption="Expires" value={expiry} align="end" />
          </span>
        </span>
        {children}
      </div>
    </div>
  );
}
