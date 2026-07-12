/**
 * 🤫 Apple Summer 2026 palette — the bright, multi-color theme for the Research
 * & Papers surface. Colors are what the world loves right now; this surface
 * leans into them.
 *
 * IMPORTANT: Tailwind only keeps classes it can see as complete literal strings,
 * so every entry lists FULL static class names (no runtime string building).
 * Each color is tuned to read well in both light and dark mode.
 */

export type SummerColor = {
  name: string;
  /** Colored text (eyebrows, links, active labels). */
  text: string;
  /** Soft tinted surface (chips, rails, cards). */
  softBg: string;
  /** Soft border to match. */
  border: string;
  /** Icon tile: border + tint + text. */
  iconTile: string;
  /** Small dot marker. */
  dot: string;
  /** Gradient stops for hero washes. */
  gradientFrom: string;
  gradientTo: string;
  /** Active nav pill. */
  activePill: string;
};

export const SUMMER_PALETTE: SummerColor[] = [
  {
    name: "sky",
    text: "text-sky-700 dark:text-sky-300",
    softBg: "bg-sky-500/[0.08]",
    border: "border-sky-400/40",
    iconTile:
      "border border-sky-500/15 bg-sky-500/[0.08] text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/[0.10] dark:text-sky-200",
    dot: "bg-sky-500",
    gradientFrom: "from-sky-400/25",
    gradientTo: "to-sky-400/0",
    activePill: "bg-sky-500/[0.12] text-sky-700 dark:text-sky-300",
  },
  {
    name: "indigo",
    text: "text-indigo-700 dark:text-indigo-300",
    softBg: "bg-indigo-500/[0.08]",
    border: "border-indigo-400/40",
    iconTile:
      "border border-indigo-500/15 bg-indigo-500/[0.08] text-indigo-700 dark:border-indigo-400/20 dark:bg-indigo-400/[0.10] dark:text-indigo-200",
    dot: "bg-indigo-500",
    gradientFrom: "from-indigo-400/25",
    gradientTo: "to-indigo-400/0",
    activePill: "bg-indigo-500/[0.12] text-indigo-700 dark:text-indigo-300",
  },
  {
    name: "violet",
    text: "text-violet-700 dark:text-violet-300",
    softBg: "bg-violet-500/[0.08]",
    border: "border-violet-400/40",
    iconTile:
      "border border-violet-500/15 bg-violet-500/[0.08] text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/[0.10] dark:text-violet-200",
    dot: "bg-violet-500",
    gradientFrom: "from-violet-400/25",
    gradientTo: "to-violet-400/0",
    activePill: "bg-violet-500/[0.12] text-violet-700 dark:text-violet-300",
  },
  {
    name: "fuchsia",
    text: "text-fuchsia-700 dark:text-fuchsia-300",
    softBg: "bg-fuchsia-500/[0.08]",
    border: "border-fuchsia-400/40",
    iconTile:
      "border border-fuchsia-500/15 bg-fuchsia-500/[0.08] text-fuchsia-700 dark:border-fuchsia-400/20 dark:bg-fuchsia-400/[0.10] dark:text-fuchsia-200",
    dot: "bg-fuchsia-500",
    gradientFrom: "from-fuchsia-400/25",
    gradientTo: "to-fuchsia-400/0",
    activePill: "bg-fuchsia-500/[0.12] text-fuchsia-700 dark:text-fuchsia-300",
  },
  {
    name: "rose",
    text: "text-rose-700 dark:text-rose-300",
    softBg: "bg-rose-500/[0.08]",
    border: "border-rose-400/40",
    iconTile:
      "border border-rose-500/15 bg-rose-500/[0.08] text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/[0.10] dark:text-rose-200",
    dot: "bg-rose-500",
    gradientFrom: "from-rose-400/25",
    gradientTo: "to-rose-400/0",
    activePill: "bg-rose-500/[0.12] text-rose-700 dark:text-rose-300",
  },
  {
    name: "orange",
    text: "text-orange-700 dark:text-orange-300",
    softBg: "bg-orange-500/[0.08]",
    border: "border-orange-400/40",
    iconTile:
      "border border-orange-500/15 bg-orange-500/[0.08] text-orange-700 dark:border-orange-400/20 dark:bg-orange-400/[0.10] dark:text-orange-200",
    dot: "bg-orange-500",
    gradientFrom: "from-orange-400/25",
    gradientTo: "to-orange-400/0",
    activePill: "bg-orange-500/[0.12] text-orange-700 dark:text-orange-300",
  },
  {
    name: "amber",
    text: "text-amber-700 dark:text-amber-300",
    softBg: "bg-amber-500/[0.08]",
    border: "border-amber-400/40",
    iconTile:
      "border border-amber-500/15 bg-amber-500/[0.08] text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/[0.10] dark:text-amber-200",
    dot: "bg-amber-500",
    gradientFrom: "from-amber-400/25",
    gradientTo: "to-amber-400/0",
    activePill: "bg-amber-500/[0.12] text-amber-700 dark:text-amber-300",
  },
  {
    name: "teal",
    text: "text-teal-700 dark:text-teal-300",
    softBg: "bg-teal-500/[0.08]",
    border: "border-teal-400/40",
    iconTile:
      "border border-teal-500/15 bg-teal-500/[0.08] text-teal-700 dark:border-teal-400/20 dark:bg-teal-400/[0.10] dark:text-teal-200",
    dot: "bg-teal-500",
    gradientFrom: "from-teal-400/25",
    gradientTo: "to-teal-400/0",
    activePill: "bg-teal-500/[0.12] text-teal-700 dark:text-teal-300",
  },
  {
    name: "emerald",
    text: "text-emerald-700 dark:text-emerald-300",
    softBg: "bg-emerald-500/[0.08]",
    border: "border-emerald-400/40",
    iconTile:
      "border border-emerald-500/15 bg-emerald-500/[0.08] text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/[0.10] dark:text-emerald-200",
    dot: "bg-emerald-500",
    gradientFrom: "from-emerald-400/25",
    gradientTo: "to-emerald-400/0",
    activePill: "bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-300",
  },
  {
    name: "cyan",
    text: "text-cyan-700 dark:text-cyan-300",
    softBg: "bg-cyan-500/[0.08]",
    border: "border-cyan-400/40",
    iconTile:
      "border border-cyan-500/15 bg-cyan-500/[0.08] text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-400/[0.10] dark:text-cyan-200",
    dot: "bg-cyan-500",
    gradientFrom: "from-cyan-400/25",
    gradientTo: "to-cyan-400/0",
    activePill: "bg-cyan-500/[0.12] text-cyan-700 dark:text-cyan-300",
  },
];

/** Deterministic color for a section by index (cycles the full palette). */
export function summerColorByIndex(index: number): SummerColor {
  return SUMMER_PALETTE[index % SUMMER_PALETTE.length] as SummerColor;
}

/** Stable color for a tag/string via a simple hash. */
export function summerColorForKey(key: string): SummerColor {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) & 0xffffffff;
  }
  const index = Math.abs(hash) % SUMMER_PALETTE.length;
  return SUMMER_PALETTE[index] as SummerColor;
}

/**
 * A bright multi-stop "summer" wash used behind hero headers. Layered radial
 * gradients in the corners give the warm, colorful iOS-27 launch feel.
 */
export const SUMMER_HERO_WASH =
  "pointer-events-none absolute inset-0 -z-10 opacity-[0.55] " +
  "[background:radial-gradient(60%_80%_at_0%_0%,rgba(56,189,248,0.20),transparent_60%)," +
  "radial-gradient(55%_70%_at_100%_0%,rgba(217,70,239,0.16),transparent_60%)," +
  "radial-gradient(70%_90%_at_100%_100%,rgba(251,146,60,0.16),transparent_60%)," +
  "radial-gradient(60%_80%_at_0%_100%,rgba(16,185,129,0.14),transparent_60%)]";
