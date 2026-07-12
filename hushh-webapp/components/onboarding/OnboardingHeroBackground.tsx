// components/onboarding/OnboardingHeroBackground.tsx
// The living backdrop shared by the pre-auth onboarding surfaces (welcome "/",
// sign-in "/login"). Linear/Vercel-grade cinematic canvas: a deep, quiet base;
// a single large soft glow that breathes behind the hero; a fine film grain;
// and a whisper of drifting motes. Alive but calm; rich in light and dark.
// Purely decorative and non-interactive; respects prefers-reduced-motion.

"use client";

import type { CSSProperties } from "react";

// A few deterministic motes so SSR/CSR match. Sparse, slow, barely-there.
const MOTES = Array.from({ length: 9 }, (_, i) => {
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
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Base wash. Light = warm pearl; dark = deep ink (Linear near-black). */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_-10%,#FFFFFF_0%,#FBF6EE_45%,#F3EADB_100%)] dark:bg-[radial-gradient(120%_90%_at_50%_-10%,#12101A_0%,#0A0810_45%,#050409_100%)]" />

      {/* Living gold + violet mesh: breathing orbs behind the hero. */}
      <div className="absolute inset-x-0 top-0 bottom-0 pointer-events-none z-0">
        <div
          className="absolute -top-24 -left-12 h-[520px] w-[520px] rounded-full bg-[#D4A574]/20 dark:bg-[#B8894D]/25 glow-mesh-active"
          style={{ transformOrigin: "40% 45%" }}
        />
        <div
          className="absolute -bottom-36 -right-12 h-[560px] w-[560px] rounded-full bg-violet-500/16 dark:bg-violet-500/20 glow-mesh-active"
          style={{ animationDelay: "-3s", transformOrigin: "60% 55%" }}
        />
        <div
          className="absolute top-1/3 right-1/4 h-[360px] w-[360px] rounded-full bg-[#F4D79A]/14 dark:bg-[#E7C078]/16 glow-mesh-active"
          style={{ animationDelay: "-6s", transformOrigin: "50% 50%" }}
        />
      </div>

      {/* THE glow: one large soft molten-gold orb high-center that breathes.
          This is the hero light source, Linear/Vercel signature. */}
      <div
        className="one-hero-glow absolute left-1/2 top-[-18%] h-[74vmin] w-[74vmin] -translate-x-1/2 rounded-full"
        style={
          {
            background:
              "radial-gradient(closest-side, rgba(212,165,116,0.55), rgba(184,137,77,0.22) 45%, rgba(184,137,77,0) 72%)",
          } as CSSProperties
        }
      />
      {/* A cooler counter-glow low-right for depth (violet), very faint. */}
      <div
        className="one-hero-glow one-hero-glow--alt absolute right-[-16%] bottom-[-20%] h-[64vmin] w-[64vmin] rounded-full"
        style={
          {
            background:
              "radial-gradient(closest-side, rgba(129,140,248,0.28), rgba(129,140,248,0) 70%)",
          } as CSSProperties
        }
      />


      {/* Drifting motes: a whisper of life. */}
      <div className="absolute inset-0 text-[#B8894D] dark:text-[#E7C078]">
        {MOTES.map((p, i) => (
          <span
            key={i}
            className="one-mote"
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
      <div className="one-grain absolute inset-0" />

      {/* Vignette to focus the center and seat the bottom chrome. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_38%,transparent_55%,rgba(58,38,12,0.06)_100%)] dark:bg-[radial-gradient(120%_80%_at_50%_38%,transparent_50%,rgba(0,0,0,0.55)_100%)]" />
    </div>
  );
}
