// components/onboarding/OnboardingHeroBackground.tsx
// The living backdrop shared by pre-auth surfaces. Neutral Apple-parchment
// canvas with quiet Action Blue corner glows gives the page depth without
// turning onboarding into a competing light show.
// Purely decorative and non-interactive; respects prefers-reduced-motion.

"use client";

import type { CSSProperties } from "react";
import styles from "./OnboardingHeroBackground.module.css";

// A few deterministic motes so SSR/CSR match. Sparse, slow, barely-there.
const MOTES = Array.from({ length: 5 }, (_, i) => {
  const seed = (i * 9301 + 49297) % 233280;
  const r = seed / 233280;
  const r2 = ((i * 4021 + 12345) % 233280) / 233280;
  return {
    left: `${8 + Math.round(r * 84)}%`,
    top: `${10 + Math.round(r2 * 78)}%`,
    size: 1.5 + r2 * 2,
    dur: `${9 + Math.round(r * 9)}s`,
    delay: `${Math.round(r2 * 7000)}ms`,
    opacity: 0.18 + r * 0.24,
  };
});

/**
 * `ambient` (the default) is the long-standing treatment every pre-auth
 * surface already uses. `plain` is the quiet welcome canvas: one opaque
 * near-white sheet, no motes, no grain. It is a variant rather than a second
 * component so sign-in, the phone step, and the preview carousel keep their
 * current backdrop byte for byte.
 */
export function OnboardingHeroBackground({
  variant = "ambient",
}: {
  variant?: "ambient" | "plain";
}) {
  const plain = variant === "plain";

  return (
    <div
      aria-hidden
      className={plain ? `${styles.root} ${styles.plainRoot}` : styles.root}
    >
      {/* Base wash. One neutral Foundation surface keeps attention on One,
          rather than introducing coloured edge bands around the composition.
          The plain variant paints its own opaque canvas here so the welcome
          reads near-white rather than inheriting the grouped-grey app
          background — and, because this layer is viewport-fixed, it also
          covers the strip the scroll root reserves for the Agent Bar, so no
          background seam appears under the bar. */}
      <div className={plain ? styles.plainBase : styles.base} />

      {/* Drifting motes are the only movement: they preserve calm and avoid
          colour shifts behind the brand, content, and navigation. */}
      {plain ? null : (
        <div className={styles.moteLayer}>
          {MOTES.map((p, i) => (
            <span
              key={i}
              className={styles.mote}
              style={
                {
                  left: p.left,
                  top: p.top,
                  width: p.size,
                  height: p.size,
                  ["--m-dur" as string]: p.dur,
                  ["--m-delay" as string]: p.delay,
                  ["--m-opacity" as string]: String(p.opacity),
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}

      {/* Fine film grain across the whole canvas so it never looks flat. */}
      {plain ? null : <div className={styles.grain} />}
    </div>
  );
}
