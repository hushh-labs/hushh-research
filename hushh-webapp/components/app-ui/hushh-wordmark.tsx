import { cn } from "@/lib/utils";

/**
 * Hushh wordmark — the brand logo. "hu" in ink, "ssh" in the app accent
 * (the Hu_SSH protocol moat made visual). Renders inline SVG driven by
 * Foundation CSS variables so it is automatically theme-aware AND follows
 * the accent preference (iOS Blue default, Molten Gold opt-in):
 *   - "hu"  = var(--foundation-ink)      (ink / off-white per theme)
 *   - "ssh" = var(--foundation-gold-deep) (aliases --app-accent-deep)
 * No raster, no duplicate light/dark assets. Static public/brand SVG assets
 * keep the historical gold identity.
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
