// components/onboarding/CapabilityGlyphs.tsx
// Bespoke, hand-drawn SVG emblems for the pre-auth capability tiles. Each glyph
// is line-art with deliberate imperfection (slightly irregular anchors, uneven
// curvature, a couple of "sketch" ticks) so it feels drawn, not iconographic.
// Strokes use a shared molten-gold gradient and self-draw on mount; a few
// details (a coin glint, a memory spark, a pulse ring, a place pin drop) carry
// their own living micro-motion. Purely decorative.

"use client";

import type { CSSProperties } from "react";

type GlyphProps = { className?: string; style?: CSSProperties };

// Shared gradient defs + filters. Rendered once per glyph (scoped ids per glyph
// keep them self-contained and avoid cross-instance collisions).
function Defs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#F4D79A" />
        <stop offset="45%" stopColor="var(--app-accent)" />
        <stop offset="100%" stopColor="var(--app-accent-deep)" />
      </linearGradient>
      <radialGradient id={`${id}-hot`} cx="35%" cy="30%" r="75%">
        <stop offset="0%" stopColor="#FFF6E0" />
        <stop offset="55%" stopColor="#EFC178" />
        <stop offset="100%" stopColor="#A9702F" />
      </radialGradient>
    </defs>
  );
}

/* ── Finances ── a hand-set coin stack with an upward "worth" line and a live
   glint. Imperfect: coins are slightly ovoid and not perfectly aligned. */
export function FinancesGlyph({ className, style }: GlyphProps) {
  const id = "cg-fin";
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} style={style} aria-hidden>
      <Defs id={id} />
      {/* coin stack (3 ellipses, slightly offset for a hand-stacked look) */}
      <g className="one-glyph-draw">
        <ellipse cx="18.5" cy="33" rx="10" ry="4.2" stroke={`url(#${id}-gold)`} strokeWidth="1.7" />
        <ellipse cx="18" cy="28.4" rx="10" ry="4.2" stroke={`url(#${id}-gold)`} strokeWidth="1.7" opacity="0.85" />
        <ellipse cx="18.8" cy="23.8" rx="10" ry="4.2" stroke={`url(#${id}-gold)`} strokeWidth="1.7" opacity="0.7" />
        {/* sides of the stack (sketchy verticals) */}
        <path d="M8.6 23.9 Q8 28.7 8.5 33.1" stroke={`url(#${id}-gold)`} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M28.8 23.7 Q29.4 28.6 28.7 33" stroke={`url(#${id}-gold)`} strokeWidth="1.5" strokeLinecap="round" />
        {/* upward worth line, drawn like a quick pen flick */}
        <path d="M31 22 Q36 18.5 39.5 11.5" stroke={`url(#${id}-gold)`} strokeWidth="1.9" strokeLinecap="round" />
        <path d="M35.5 11 L39.8 11 L39.4 15.4" stroke={`url(#${id}-gold)`} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {/* living glint on the top coin */}
      <circle className="one-glyph-glint" cx="15" cy="22.4" r="1.4" fill={`url(#${id}-hot)`} />
    </svg>
  );
}

/* ── Memory ── a hand-drawn spark/bloom (a remembered moment). Imperfect: rays
   are uneven length and hand-angled; a soft inner petal. */
export function MemoryGlyph({ className, style }: GlyphProps) {
  const id = "cg-mem";
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} style={style} aria-hidden>
      <Defs id={id} />
      <g className="one-glyph-draw">
        {/* soft four-point bloom, hand-curved so lobes are unequal */}
        <path
          d="M24 9 C26.5 18 30.5 21.5 39 24 C30.5 26.6 26.2 30.5 24 39 C21.6 30.2 17.7 26.4 9 24 C17.9 21.4 21.6 17.6 24 9 Z"
          stroke={`url(#${id}-gold)`}
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        {/* little companion sparks (attention to detail) */}
        <path d="M37.5 12.5 L38.7 15 L41.2 16.2 L38.7 17.4 L37.5 19.9 L36.3 17.4 L33.8 16.2 L36.3 15 Z" stroke={`url(#${id}-gold)`} strokeWidth="1.2" strokeLinejoin="round" opacity="0.85" />
      </g>
      {/* pulsing core */}
      <circle className="one-glyph-pulse" cx="24" cy="24" r="2.6" fill={`url(#${id}-hot)`} />
    </svg>
  );
}

/* ── People ── two hand-drawn figures sharing, with a consent thread between
   them. Imperfect: heads are slightly ovoid, shoulders asymmetric. */
export function PeopleGlyph({ className, style }: GlyphProps) {
  const id = "cg-ppl";
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} style={style} aria-hidden>
      <Defs id={id} />
      <g className="one-glyph-draw">
        {/* left person */}
        <ellipse cx="16.5" cy="16" rx="4.4" ry="4.7" stroke={`url(#${id}-gold)`} strokeWidth="1.8" />
        <path d="M8.5 34 Q9 24.5 16.6 24.2 Q23 24.4 24 31.5" stroke={`url(#${id}-gold)`} strokeWidth="1.8" strokeLinecap="round" />
        {/* right person (slightly different scale, hand-varied) */}
        <ellipse cx="32" cy="18" rx="4" ry="4.3" stroke={`url(#${id}-gold)`} strokeWidth="1.8" opacity="0.9" />
        <path d="M24.5 34 Q25.2 26.5 32 26.2 Q39 26.5 39.4 34" stroke={`url(#${id}-gold)`} strokeWidth="1.8" strokeLinecap="round" opacity="0.9" />
      </g>
      {/* consent thread between them (a travelling gold bead) */}
      <path id={`${id}-thread`} d="M21 20.5 Q24 15.5 28 20" stroke={`url(#${id}-gold)`} strokeWidth="1.3" strokeDasharray="1.5 3" strokeLinecap="round" opacity="0.75" />
      <circle className="one-glyph-bead" r="1.5" fill={`url(#${id}-hot)`}>
        <animateMotion dur="3.4s" repeatCount="indefinite" rotate="auto" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
          <mpath href={`#${id}-thread`} />
        </animateMotion>
      </circle>
    </svg>
  );
}

/* ── Place ── a hand-drawn map pin over a soft locality contour, with a live
   drop/ping. Imperfect: the pin is hand-teardropped, the contour is a loose
   sketch. */
export function PlaceGlyph({ className, style }: GlyphProps) {
  const id = "cg-plc";
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} style={style} aria-hidden>
      <Defs id={id} />
      <g className="one-glyph-draw">
        {/* loose ground contour */}
        <path d="M10 36 Q20 31 38 35" stroke={`url(#${id}-gold)`} strokeWidth="1.4" strokeLinecap="round" opacity="0.6" strokeDasharray="0.5 3.5" />
        {/* hand teardrop pin */}
        <path
          d="M24 10 C30 10 33.5 14.5 33 19.5 C32.4 25 27.5 29 24 33 C20.6 29.2 15.7 25.1 15 19.5 C14.4 14.6 18 10 24 10 Z"
          stroke={`url(#${id}-gold)`}
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <circle cx="24" cy="19.5" r="3.1" stroke={`url(#${id}-gold)`} strokeWidth="1.6" />
      </g>
      {/* living ping ring under the pin */}
      <circle className="one-glyph-ping" cx="24" cy="35.5" r="3" stroke={`url(#${id}-hot)`} strokeWidth="1.3" />
    </svg>
  );
}
