/**
 * The network mark for a detected card brand.
 *
 * Two tiers, deliberately. When a network's official artwork is present in
 * `public/brand/cards/`, it is rendered unmodified in a transparent cell, the
 * same handling the runtime provider marks follow
 * (docs/reference/one/runtime-provider-brand-inventory.md). Until an asset is
 * recorded in `CARD_MARK_ASSETS`, the brand falls back to a plain lettermark
 * tile that is Hussh's own and claims to be nobody's logo.
 *
 * The asset map is the only thing that changes when artwork arrives: drop the
 * file into `public/brand/cards/`, add one line here, record the source in
 * docs/reference/one/card-network-brand-inventory.md. No other file moves.
 *
 * Visa, Mastercard, American Express, Discover, RuPay, JCB, UnionPay, Mir, Elo,
 * Diners Club and Verve are trademarks of their owners. Showing a network's
 * mark against a card the owner actually holds is identification, not
 * endorsement, which is why the geometry must never be altered or recoloured.
 */

import Image from "next/image";

import { cn } from "@/lib/utils";
import type { CardBrand } from "@/lib/wallet/card-validation";

type NetworkStyle = {
  /** Short enough for a lettermark tile. */
  short: string;
  /** The full name, for prose and assistive technology. */
  label: string;
  /** Recognition colour for the fallback tile only. A colour is not a mark. */
  background: string;
  foreground: string;
};

/**
 * Official artwork, once recorded. Empty entries fall back to the lettermark.
 * Every entry here must have a matching row in the card network brand
 * inventory naming where the file came from.
 */
const CARD_MARK_ASSETS: Partial<Record<CardBrand, string>> = {};

const NETWORKS: Readonly<Record<CardBrand, NetworkStyle>> = {
  visa: { short: "VISA", label: "Visa", background: "#1a1f71", foreground: "#ffffff" },
  mastercard: {
    short: "MC",
    label: "Mastercard",
    background: "#1a1a1a",
    foreground: "#ff9e0f",
  },
  amex: {
    short: "AMEX",
    label: "American Express",
    background: "#006fcf",
    foreground: "#ffffff",
  },
  discover: {
    short: "DISC",
    label: "Discover",
    background: "#f2f2f2",
    foreground: "#e35205",
  },
  diners: {
    short: "DC",
    label: "Diners Club",
    background: "#0079be",
    foreground: "#ffffff",
  },
  jcb: { short: "JCB", label: "JCB", background: "#0e4c96", foreground: "#ffffff" },
  unionpay: {
    short: "UP",
    label: "UnionPay",
    background: "#0d2c6c",
    foreground: "#e21836",
  },
  rupay: { short: "RuPay", label: "RuPay", background: "#0d2c6c", foreground: "#f6871f" },
  mir: { short: "MIR", label: "Mir", background: "#0f754e", foreground: "#ffffff" },
  elo: { short: "ELO", label: "Elo", background: "#111111", foreground: "#ffcb05" },
  verve: { short: "VERVE", label: "Verve", background: "#0b7a3b", foreground: "#ffffff" },
  other: { short: "CARD", label: "Card", background: "#6b7280", foreground: "#ffffff" },
};

function normalizeBrand(brand: string | null | undefined): CardBrand {
  const key = String(brand || "").trim().toLowerCase() as CardBrand;
  return key in NETWORKS ? key : "other";
}

/** The full name of a network, for prose and assistive technology. */
export function cardNetworkLabel(brand: string | null | undefined): string {
  return NETWORKS[normalizeBrand(brand)].label;
}

/** True when this brand renders the network's own artwork rather than a lettermark. */
export function hasOfficialCardMark(brand: string | null | undefined): boolean {
  return Boolean(CARD_MARK_ASSETS[normalizeBrand(brand)]);
}

export function CardNetworkMark({
  brand,
  className,
}: {
  brand: string | null | undefined;
  className?: string;
}) {
  const key = normalizeBrand(brand);
  const network = NETWORKS[key];
  const asset = CARD_MARK_ASSETS[key];

  if (asset) {
    // Official artwork: transparent cell, unmodified geometry, no tint.
    return (
      <span
        role="img"
        aria-label={network.label}
        title={network.label}
        data-testid={`card-network-mark-${key}`}
        className={cn(
          "inline-flex h-7 w-11 shrink-0 items-center justify-center",
          className,
        )}
      >
        <Image
          src={asset}
          alt=""
          width={44}
          height={28}
          className="h-auto w-full object-contain"
        />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={network.label}
      title={network.label}
      data-testid={`card-network-mark-${key}`}
      className={cn(
        "inline-grid h-7 w-11 shrink-0 place-items-center rounded-md text-[9px] font-bold tracking-wide tabular-nums",
        className,
      )}
      style={{ backgroundColor: network.background, color: network.foreground }}
    >
      {network.short}
    </span>
  );
}
