/**
 * Research uses the same quiet Foundation material as onboarding and the
 * public One surfaces.  The module name is retained for import compatibility
 * while the old bright, independent palette is deliberately retired.
 */

export type SummerColor = {
  name: string;
  text: string;
  softBg: string;
  border: string;
  iconTile: string;
  dot: string;
  gradientFrom: string;
  gradientTo: string;
  activePill: string;
};

const FOUNDATION_GOLD: SummerColor = {
  name: "foundation-gold",
  text: "text-[#9B651E] dark:text-[#E2B35C]",
  softBg: "bg-[#B88635]/[0.10] dark:bg-[#E2B35C]/[0.10]",
  border: "border-[#B88635]/30 dark:border-[#E2B35C]/25",
  iconTile: "border border-[#B88635]/20 bg-[#B88635]/[0.10] text-[#9B651E] dark:border-[#E2B35C]/25 dark:bg-[#E2B35C]/[0.10] dark:text-[#E2B35C]",
  dot: "bg-[#B88635] dark:bg-[#E2B35C]",
  gradientFrom: "from-[#B88635]/20",
  gradientTo: "to-[#B88635]/0",
  activePill: "bg-[#B88635]/[0.12] text-[#8A5718] dark:text-[#E2B35C]",
};

const FOUNDATION_INK: SummerColor = {
  name: "foundation-ink",
  text: "text-[#332817] dark:text-[#F4E9D4]",
  softBg: "bg-[#332817]/[0.06] dark:bg-[#F4E9D4]/[0.08]",
  border: "border-[#332817]/15 dark:border-[#F4E9D4]/20",
  iconTile: "border border-[#332817]/15 bg-[#332817]/[0.06] text-[#332817] dark:border-[#F4E9D4]/20 dark:bg-[#F4E9D4]/[0.08] dark:text-[#F4E9D4]",
  dot: "bg-[#332817] dark:bg-[#F4E9D4]",
  gradientFrom: "from-[#332817]/12",
  gradientTo: "to-[#332817]/0",
  activePill: "bg-[#332817]/[0.08] text-[#332817] dark:bg-[#F4E9D4]/[0.10] dark:text-[#F4E9D4]",
};

export const SUMMER_PALETTE: SummerColor[] = [FOUNDATION_GOLD, FOUNDATION_INK];

export function summerColorByIndex(index: number): SummerColor {
  return SUMMER_PALETTE[index % SUMMER_PALETTE.length] as SummerColor;
}

export function summerColorForKey(key: string): SummerColor {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) & 0xffffffff;
  }
  return summerColorByIndex(Math.abs(hash));
}

export const SUMMER_HERO_WASH =
  "pointer-events-none absolute inset-0 -z-10 opacity-100 " +
  "[background:radial-gradient(70%_90%_at_0%_0%,rgba(184,134,53,0.14),transparent_62%)," +
  "radial-gradient(60%_80%_at_100%_100%,rgba(91,70,35,0.08),transparent_65%)] " +
  "dark:[background:radial-gradient(70%_90%_at_0%_0%,rgba(226,179,92,0.13),transparent_62%)," +
  "radial-gradient(60%_80%_at_100%_100%,rgba(244,233,212,0.06),transparent_65%)]";
