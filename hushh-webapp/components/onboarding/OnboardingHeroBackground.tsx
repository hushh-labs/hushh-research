// components/onboarding/OnboardingHeroBackground.tsx
// The living backdrop shared by pre-auth surfaces. It is intentionally warm and
// low-contrast: Foundation gold gives the page depth without turning onboarding
// into a competing light show.
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

export function OnboardingHeroBackground() {
  return (
    <div
      aria-hidden
      className={styles.root}
    >
      {/* Base wash. One neutral Foundation surface keeps attention on One,
          rather than introducing coloured edge bands around the composition. */}
      <div className={styles.base} />

      {/* Drifting motes are the only movement: they preserve calm and avoid
          colour shifts behind the brand, content, and navigation. */}
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

      {/* Fine film grain across the whole canvas so it never looks flat. */}
      <div className={styles.grain} />
    </div>
  );
}
