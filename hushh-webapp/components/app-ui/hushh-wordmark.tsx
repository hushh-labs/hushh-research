import { cn } from "@/lib/utils";

/**
 * Hushh wordmark — the brand logo. "hu" in ink, "ssh" in the standardized
 * hero foil gradient (the Hu_SSH protocol moat made visual). Renders inline
 * SVG driven by Foundation CSS variables so it is automatically theme-aware
 * AND follows the accent preference (iOS Blue default, Molten Gold opt-in):
 *   - "hu"  = var(--foundation-ink) (ink / off-white per theme)
 *   - "ssh" = the shared --app-accent-hero-from/mid/to stops, the same
 *     blue-to-dark foil the intro "One" hero uses, so brand glyphs stay
 *     consistent wherever the shine treatment appears.
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
      <defs>
        <linearGradient id="hushh-wordmark-ssh" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--app-accent-hero-from)" />
          <stop offset="50%" stopColor="var(--app-accent-hero-mid)" />
          <stop offset="100%" stopColor="var(--app-accent-hero-to)" />
        </linearGradient>
      </defs>
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
        <tspan fill="url(#hushh-wordmark-ssh)">ssh</tspan>
      </text>
    </svg>
  );
}
