import type { DashboardPosition } from "@/components/kai/views/dashboard-portfolio-model";

export interface SinceBought {
  gain: number;
  pct: number | null;
  /** Positions the figure is based on, out of those that could have one. */
  covered: number;
  eligible: number;
}

const counted = (position: DashboardPosition) =>
  !position.isCashEquivalent &&
  typeof position.gainLoss === "number" &&
  Number.isFinite(position.gainLoss);

/**
 * Unrealized gain or loss against what was paid, summed over the positions that report it.
 * It is not a time-weighted return, and it says how many positions it covers so a partial
 * statement is not read as the whole portfolio. Null when no position has a cost basis.
 */
export function sinceBought(positions: readonly DashboardPosition[]): SinceBought | null {
  const eligible = positions.filter((position) => !position.isCashEquivalent && position.marketValue > 0).length;
  const covered = positions.filter(counted);
  if (!covered.length) return null;
  const gain = covered.reduce((sum, position) => sum + (position.gainLoss ?? 0), 0);
  const cost = covered.reduce((sum, position) => sum + (position.costBasis > 0 ? position.costBasis : 0), 0);
  return { gain, pct: cost > 0 ? (gain / cost) * 100 : null, covered: covered.length, eligible: Math.max(eligible, covered.length) };
}

/** Largest dollar gains and losses first. Flat and cash positions are neither. */
export function rankMovers(positions: readonly DashboardPosition[], limit = 3) {
  const ranked = positions.filter(counted);
  return {
    gains: ranked.filter((position) => (position.gainLoss ?? 0) > 0).sort((a, b) => (b.gainLoss ?? 0) - (a.gainLoss ?? 0)).slice(0, limit),
    losses: ranked.filter((position) => (position.gainLoss ?? 0) < 0).sort((a, b) => (a.gainLoss ?? 0) - (b.gainLoss ?? 0)).slice(0, limit),
  };
}

export type BandTone = "down-big" | "down" | "flat" | "up" | "up-big";

export interface BandSegment {
  tone: BandTone;
  label: string;
  count: number;
}

const BANDS: ReadonlyArray<{ match: (band: string) => boolean; tone: BandTone; label: string }> = [
  { match: (band) => band.includes("< -10"), tone: "down-big", label: "Down over 10%" },
  { match: (band) => band.includes("-10% to -2%"), tone: "down", label: "Down 2–10%" },
  { match: (band) => band.includes("-2% to +2%"), tone: "flat", label: "Within 2%" },
  { match: (band) => band.includes("+2% to +10%"), tone: "up", label: "Up 2–10%" },
  { match: (band) => band.includes("> +10"), tone: "up-big", label: "Up over 10%" },
];

/** The five gain/loss bands as one split bar, with the down, flat and up totals. */
export function winnersLosers(bands: ReadonlyArray<{ band: string; count: number }>) {
  const segments: BandSegment[] = BANDS.map(({ match, tone, label }) => ({
    tone,
    label,
    count: bands.filter((entry) => match(entry.band)).reduce((sum, entry) => sum + Math.max(0, entry.count), 0),
  }));
  const count = (...tones: BandTone[]) => segments.filter((segment) => tones.includes(segment.tone)).reduce((sum, segment) => sum + segment.count, 0);
  return { segments, down: count("down-big", "down"), flat: count("flat"), up: count("up", "up-big"), total: count("down-big", "down", "flat", "up", "up-big") };
}

/** How much of the portfolio the listed largest holdings make up. */
export function concentrationSummary(data: ReadonlyArray<{ symbol: string; weightPct: number }>) {
  return { count: data.length, topPct: data.reduce((sum, row) => sum + row.weightPct, 0), largest: data[0] ?? null };
}
