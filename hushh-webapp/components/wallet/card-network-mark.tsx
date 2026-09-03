/**
 * A network mark for a detected card brand.
 *
 * These are Hushh's own marks, not the networks'. Visa, Mastercard, American
 * Express, Discover, RuPay, JCB, UnionPay, Mir, Elo, Diners Club and Verve are
 * registered trademarks of their owners, and each network licenses its artwork
 * under its own brand guidelines. Copying those files into this repository
 * would ship someone else's trademark without a licence, so instead each brand
 * gets an original rounded tile carrying its short name in the colour the
 * network is recognised by. A person reading their own wallet identifies the
 * card instantly, and nothing here claims to be, or reproduces, an official
 * logo.
 *
 * If the networks' licensed assets are ever obtained, this component is the one
 * place to swap them in: every surface renders the card's brand through it.
 */

import { cn } from "@/lib/utils";
import type { CardBrand } from "@/lib/wallet/card-validation";

type NetworkStyle = {
  /** What a person calls the network, short enough for a tile. */
  short: string;
  /** The full name, for assistive technology. */
  label: string;
  /** Recognition colour. A brand's colour is not its trademark. */
  background: string;
  foreground: string;
};

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

function styleFor(brand: string | null | undefined): NetworkStyle {
  const key = String(brand || "").trim().toLowerCase() as CardBrand;
  return NETWORKS[key] ?? NETWORKS.other;
}

/** The full name of a network, for prose and assistive technology. */
export function cardNetworkLabel(brand: string | null | undefined): string {
  return styleFor(brand).label;
}

export function CardNetworkMark({
  brand,
  className,
}: {
  brand: string | null | undefined;
  className?: string;
}) {
  const network = styleFor(brand);
  return (
    <span
      role="img"
      aria-label={network.label}
      title={network.label}
      data-testid={`card-network-mark-${String(brand || "other").toLowerCase()}`}
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
