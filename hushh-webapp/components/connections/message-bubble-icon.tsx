import { cn } from "@/lib/utils";

/**
 * iOS-style Messages glyph: an Apple system-blue (#007AFF) disc holding a white speech bubble.
 * Inline SVG so it stays crisp at any density and needs no network asset.
 */
export function MessageBubbleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      className={cn("size-7 shrink-0", className)}
    >
      <circle cx="256" cy="256" r="230" fill="#007AFF" />
      <ellipse cx="256" cy="250" rx="152" ry="118" fill="#fff" />
      <path d="M146 318 L134 384 L208 358 Z" fill="#fff" />
    </svg>
  );
}
