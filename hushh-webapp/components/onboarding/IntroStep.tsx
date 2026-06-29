"use client";

import Image from "next/image";
import type { CSSProperties, ComponentType, SVGProps } from "react";
import { OneLockup } from "@/components/app-ui/gold-period";
import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
import { Button } from "@/lib/morphy-ux/button";
import {
  kaiAppHeroBodyClassName,
  kaiAppHeroTitleClassName,
} from "@/components/kai/shared/kai-typography";

// Inner glyph detail is "knocked out" to the icon's tinted background instead
// of solid white, so the cutout reads as transparent against each tone and
// matches the page aesthetic. Falls back to white if the var is unavailable.
const INTRO_ICON_KNOCKOUT = "var(--intro-feature-bg, #ffffff)";

// Vault: a private space only you can open (BYOK, encrypted even from us).
function VaultLockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="4.2" y="10.2" width="15.6" height="11" rx="3.2" />
      <path
        d="M7.6 10V7.6a4.4 4.4 0 0 1 8.8 0V10"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <circle cx="12" cy="15" r="1.7" fill={INTRO_ICON_KNOCKOUT} />
      <path
        d="M12 15.6v2.1"
        fill="none"
        stroke={INTRO_ICON_KNOCKOUT}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

// Finance: One's money capability (Kai). Generic, explains a sub-app.
// Drawn as a stroked coin + dollar glyph in the tone color (not a solid
// filled disc) so it reads the same as the lock/mail glyphs and never looks
// inverted next to them.
function FinanceCapabilityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Correctly-oriented dollar glyph (matches lucide CircleDollarSign). */}
      <path
        d="M15 9.2H10.6a1.9 1.9 0 0 0 0 3.8h2.8a1.9 1.9 0 0 1 0 3.8H8.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M12 7.2v9.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

// Gmail / inbox: One's email capability. Generic, explains a sub-app.
function InboxCapabilityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="3.2" y="5.4" width="17.6" height="13.2" rx="3" />
      <path
        d="m4.6 7.6 7.4 5.3 7.4-5.3"
        fill="none"
        stroke={INTRO_ICON_KNOCKOUT}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

const INTRO_FEATURES: Array<{
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  subtitle: string;
  tone: "green" | "blue" | "orange";
}> = [
  {
    icon: VaultLockIcon,
    title: "Your vault, guarded by consent",
    subtitle: "Encrypted end to end, shared only when you say yes",
    tone: "blue",
  },
  {
    icon: FinanceCapabilityIcon,
    title: "Finance, made personal",
    subtitle: "Track and act on your money with Kai",
    tone: "blue",
  },
  {
    icon: InboxCapabilityIcon,
    title: "Connect Gmail and more",
    subtitle: "One works across your apps, with consent",
    tone: "blue",
  },
];

function featureStyle(tone: "green" | "blue" | "orange", index: number): CSSProperties {
  return {
    "--intro-feature-tone": `var(--tone-${tone})`,
    "--intro-feature-bg": `var(--tone-${tone}-bg)`,
    "--intro-feature-glow": `var(--tone-${tone}-glow)`,
    "--intro-feature-delay": `${index * 120}ms`,
  } as CSSProperties;
}

export function IntroStep({
  onNext,
  onLogin,
}: {
  onNext: () => void;
  onLogin?: () => void;
}) {
  return (
    <main className="min-h-[100dvh] w-full bg-[#ffffff] text-[#1d1d1f] transition-colors duration-300 dark:bg-[#0a0a0c] dark:text-[#f5f5f7]">
      {/* Reserve bottom room for the global agent bar (conversational voice
          piece) which is anchored above the safe area on this intro screen, so
          the footer CTAs never collide with it. */}
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[440px] flex-col px-6 pt-[calc(34px+var(--app-safe-area-top-effective,0px))] pb-[calc(94px+var(--app-safe-area-bottom-effective,0px))]">
        <div className="flex min-h-0 flex-1 flex-col justify-center py-6">
          <section className="relative flex flex-none flex-col items-center text-center">
            <Image
              src="/one-quiet-emoji.png"
              alt=""
              width={762}
              height={766}
              priority
              unoptimized
              aria-hidden="true"
              draggable={false}
              className="relative h-11 w-11 select-none object-contain"
            />

            <div
              role="heading"
              aria-level={1}
              aria-label="hushh One, a memory that's only yours"
              className={`relative mt-2.5 flex items-baseline justify-center gap-2 ${kaiAppHeroTitleClassName} text-[#1d1d1f] dark:text-[#f5f5f7]`}
            >
              <HushhWordmark className="h-[0.92em] w-auto translate-y-[0.06em]" />
              <OneLockup />
            </div>
            <p className={`relative mt-3 ${kaiAppHeroBodyClassName} text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]`}>
              A memory that&apos;s only yours.
            </p>
          </section>

        <div className="flex-none pt-9 pb-5">
          <div className="relative w-full">
            <div className="relative z-10 mx-auto flex w-full max-w-[340px] flex-col gap-3">
              <div
                aria-hidden="true"
                className="intro-feature-rail absolute left-6 top-6 bottom-6 z-0 w-3 -translate-x-1/2"
              />
              {INTRO_FEATURES.map((feature, index) => (
                <div
                  key={feature.title}
                  className="intro-feature-item relative z-10 grid h-[70px] grid-cols-[48px_minmax(0,1fr)] items-center gap-4 rounded-[22px]"
                  style={featureStyle(feature.tone, index)}
                >
                  <span
                    className="intro-feature-icon grid h-12 w-12 place-items-center rounded-full border border-black/[0.04] dark:border-white/10"
                  >
                    <feature.icon className="relative z-10 h-[22px] w-[22px]" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[16.5px] font-medium leading-[1.22] tracking-normal text-[#1d1d1f] dark:text-[#f5f5f7]">
                      {feature.title}
                    </p>
                    <p className="mt-1 text-[14.5px] leading-[1.35] tracking-normal text-[rgba(0,0,0,0.50)] dark:text-[rgba(245,245,247,0.56)]">
                      {feature.subtitle}
                    </p>
                  </div>
                </div>
                ))}
              </div>
            </div>
          </div>

        <footer className="flex-none pt-3">
          <div className="space-y-4">
            <p className="mx-auto max-w-[34ch] text-center text-[13.5px] leading-5 tracking-normal text-[#86868b] dark:text-[rgba(245,245,247,0.72)]">
              One is consent-first. Your knowledge and information are your
              safewords. Nothing leaves your vault without your approval.
            </p>
            <Button
              size="lg"
              fullWidth
              onClick={onNext}
              showRipple
              className="h-[50px] rounded-full bg-[#1d1d1f] text-[17px] font-medium tracking-normal !text-white shadow-none hover:bg-black dark:bg-[#f5f5f7] dark:!text-[#1d1d1f] dark:hover:bg-white"
            >
              Get started
            </Button>
            {onLogin ? (
              <button
                type="button"
                className="mx-auto block min-h-10 px-4 text-[15px] font-medium tracking-normal text-[#b8894d] transition-colors hover:text-[#9a7038] dark:text-[#d4a574] dark:hover:text-[#e0bb8e]"
                onClick={onLogin}
              >
                Log in
              </button>
            ) : null}
          </div>
        </footer>
      </div>
      </div>
    </main>
  );
}
