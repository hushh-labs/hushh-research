"use client";

import Image from "next/image";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────
 * 14a — Immersive welcome (design.md §5.7/5.8/5.10)
 * Dark hero (glass icon tile + indigo-accent wordmark) rising into
 * a white sheet with a timeline feature list + consent note. The
 * "Get started" CTA is intentionally removed — Log in is the single
 * primary action. Content is OURS; the ask bar + theme toggle are
 * global chrome that overlays this screen.
 * ──────────────────────────────────────────────────────────── */

// Indigo stroke glyphs (currentColor) — the parent sets the indigo color.
function VaultLockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <rect x="4.5" y="8.5" width="11" height="8" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6.8 8.5V6.4a3.2 3.2 0 016.4 0v2.1" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function FinanceCapabilityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 7.5c-.5-.9-1.2-1.3-2-1.3-1.2 0-2 .7-2 1.7 0 2.3 4.2 1.2 4.2 3.6 0 1.1-.9 1.8-2.2 1.8-.9 0-1.7-.4-2.2-1.3M10 5v1.2M10 13.6v1.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function InboxCapabilityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 18" fill="none" aria-hidden="true" {...props}>
      <rect x="2.5" y="2.5" width="15" height="12" rx="2.4" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 4L10 9l6.5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Content is OURS (unchanged); presentation is the 14a timeline.
const INTRO_FEATURES: Array<{
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  subtitle: string;
}> = [
  {
    icon: VaultLockIcon,
    title: "Your vault, guarded by consent",
    subtitle: "Encrypted end to end, shared only when you say yes",
  },
  {
    icon: FinanceCapabilityIcon,
    title: "Finance, made personal",
    subtitle: "Track and act on your money with Kai",
  },
  {
    icon: InboxCapabilityIcon,
    title: "Connect Gmail and more",
    subtitle: "One works across your apps, with consent",
  },
];

export function IntroStep({
  onLogin,
}: {
  // Kept optional for the parent's call signature; the 14a welcome no longer
  // renders a "Get started" CTA, so onNext is intentionally unused here.
  onNext?: () => void;
  onLogin?: () => void;
}) {
  return (
    <main className="relative min-h-[100dvh] w-full overflow-hidden bg-[#0A0A0C]">
      {/* Hero glow blobs (decorative) */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[60%]">
        <span
          className="absolute -top-24 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full"
          style={{ background: "rgba(94,92,230,0.40)", filter: "blur(80px)" }}
        />
        <span
          className="absolute -right-16 top-16 h-56 w-56 rounded-full"
          style={{ background: "rgba(18,161,80,0.16)", filter: "blur(80px)" }}
        />
      </div>

      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[440px] flex-col">
        {/* ── Dark hero ── */}
        <div className="flex flex-col items-center px-6 pt-[calc(78px+var(--app-safe-area-top-effective,0px))] pb-9 text-center">
          <div className="relative flex h-[88px] w-[88px] items-center justify-center rounded-[23px] border border-white/20 bg-gradient-to-b from-white/[0.16] to-white/[0.06] shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 rounded-[23px]"
              style={{ boxShadow: "0 0 60px rgba(133,131,255,0.28)" }}
            />
            <Image
              src="/one-quiet-emoji.png"
              alt=""
              width={762}
              height={766}
              priority
              unoptimized
              aria-hidden="true"
              draggable={false}
              className="h-11 w-11 select-none object-contain [filter:drop-shadow(0_4px_10px_rgba(0,0,0,0.35))]"
            />
          </div>

          <div
            role="heading"
            aria-level={1}
            aria-label="hushh One, a memory that's only yours"
            className="mt-6 whitespace-nowrap font-[family-name:var(--font-app-display)] text-[40px] font-extrabold leading-none tracking-[-1.4px] text-white"
          >
            hu<span style={{ color: "#8583FF" }}>sh</span>h{" "}
            <span className="font-bold">One</span>
            <span style={{ color: "#8583FF" }}>.</span>
          </div>
          <p className="mt-3 text-[16px] tracking-[-0.2px] text-white/55">
            A memory that&apos;s only yours.
          </p>
        </div>

        {/* ── White sheet ── */}
        <div className="relative mt-auto flex-1 rounded-t-[34px] bg-white px-6 pt-8 pb-[calc(132px+var(--app-safe-area-bottom-effective,0px))] shadow-[0_-16px_50px_rgba(0,0,0,0.45)] dark:bg-[#141416]">
          {/* Timeline features */}
          <div className="relative flex flex-col">
            {INTRO_FEATURES.map((feature, index) => {
              const last = index === INTRO_FEATURES.length - 1;
              return (
                <div key={feature.title} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(94,92,230,0.09)] text-[#5E5CE6] dark:bg-[rgba(133,131,255,0.14)] dark:text-[#8583FF]">
                      <feature.icon className="h-[19px] w-[19px]" />
                    </span>
                    {!last ? (
                      <span
                        aria-hidden
                        className="w-[1.5px] flex-1 bg-[rgba(94,92,230,0.18)] dark:bg-[rgba(133,131,255,0.22)]"
                      />
                    ) : null}
                  </div>
                  <div className={cn("min-w-0", last ? "pb-0" : "pb-4")}>
                    <p className="text-[16.5px] font-bold leading-tight tracking-[-0.4px] text-[#0A0A0A] dark:text-white [overflow-wrap:anywhere]">
                      {feature.title}
                    </p>
                    <p className="mt-1 text-[13.5px] leading-[1.35] text-black/45 dark:text-white/55 [overflow-wrap:anywhere]">
                      {feature.subtitle}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Consent note (indigo tint) */}
          <div className="mt-6 rounded-2xl bg-[rgba(94,92,230,0.06)] px-4 py-4 text-center text-[13.5px] leading-[1.5] text-black/55 dark:bg-white/[0.05] dark:text-white/60">
            One is consent-first. Your knowledge and information are your
            safewords. Nothing leaves your vault without your approval.
          </div>

          {/* Primary action — Log in (Get started removed) */}
          <div className="mt-6">
            <button
              type="button"
              onClick={onLogin}
              className="flex h-[54px] w-full items-center justify-center rounded-full bg-[#111] text-[17px] font-bold tracking-[-0.3px] text-white shadow-[0_10px_24px_rgba(0,0,0,0.22)] transition-transform duration-150 hover:bg-black active:scale-[0.99] motion-reduce:active:scale-100 dark:bg-white dark:text-[#111] dark:hover:bg-white"
            >
              Log in
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
