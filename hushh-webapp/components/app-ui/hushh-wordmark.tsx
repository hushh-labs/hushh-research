import { cn } from "@/lib/utils";

/**
 * Hushh wordmark — the brand logo. "hu" in ink, "ssh" in Foundation gold
 * (the Hu_SSH protocol moat made visual). Mirrors the hushh-search-console
 * wordmark (`public/brand/hussh-wordmark-ssh-gold.svg`) but renders inline SVG
 * driven by Foundation CSS variables, so it is automatically theme-aware:
 *   - light: hu = #1d1d1f (ink),      ssh = #b8894d (deep gold)
 *   - dark:  hu = #f5f5f7 (off-white), ssh = #d4a574 (bright gold)
 * No raster, no duplicate light/dark assets.
 */
export function HushhWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="73 8 460 146"
      role="img"
      aria-label="hushh"
      className={cn("h-7 w-auto select-none", className)}
    >
      <title>hushh</title>
      <text
        x="300"
        y="135"
        textAnchor="middle"
        fontFamily='"SF Pro Display", "SF Pro", "Helvetica Neue", Inter, system-ui, sans-serif'
        fontWeight={700}
        fontSize={160}
        letterSpacing={-5.6}
      >
        <tspan fill="var(--foundation-ink)">hu</tspan>
        <tspan fill="var(--foundation-gold-deep)">ssh</tspan>
      </text>
    </svg>
  );
}
