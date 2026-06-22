"use client";

import Image from "next/image";
import type { CSSProperties, ComponentType, SVGProps } from "react";
import { OneLockup } from "@/components/app-ui/gold-period";
import { Button } from "@/lib/morphy-ux/button";
import {
  kaiAppHeroBodyClassName,
  kaiAppHeroTitleClassName,
} from "@/components/kai/shared/kai-typography";

function ShieldBadgeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2.5 4.5 5.3v5.8c0 4.7 3.2 7.3 7.5 8.5 4.3-1.2 7.5-3.8 7.5-8.5V5.3L12 2.5Z" />
      <path
        d="m8.4 12 2.3 2.3 4.9-4.9"
        fill="none"
        stroke="#ffffff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
    </svg>
  );
}

function HoldingsBarsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="3.8" y="13.3" width="4.2" height="7.1" rx="1.3" />
      <rect x="9.9" y="8.8" width="4.2" height="11.6" rx="1.3" />
      <rect x="16" y="3.6" width="4.2" height="16.8" rx="1.3" />
    </svg>
  );
}

function SignalPulseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="9.8" />
      <path
        d="M6.3 12h2.2l1.7-3.5 2.5 6.5 1.9-3h3.1"
        fill="none"
        stroke="#ffffff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
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
    icon: ShieldBadgeIcon,
    title: "Verified in minutes",
    subtitle: "Seamless KYC, no paperwork",
    tone: "green",
  },
  {
    icon: HoldingsBarsIcon,
    title: "Top holdings, at a glance",
    subtitle: "Your portfolio, always live",
    tone: "blue",
  },
  {
    icon: SignalPulseIcon,
    title: "Buy, sell, hold",
    subtitle: "Clear signals when they matter",
    tone: "orange",
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
    <main className="min-h-[100dvh] w-full bg-[#ffffff] text-[#1d1d1f] transition-colors duration-300 dark:bg-[#000000] dark:text-[#f5f5f7]">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[440px] flex-col px-6 pt-[calc(34px+var(--app-safe-area-top-effective,0px))] pb-[calc(18px+var(--app-safe-area-bottom-effective,0px))]">
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
              aria-label="Meet One, Your Personal Financial Advisor"
              className={`relative mt-2.5 ${kaiAppHeroTitleClassName} text-[#1d1d1f] dark:text-[#f5f5f7]`}
            >
              Meet <OneLockup />
            </div>
            <p className={`relative mt-3 ${kaiAppHeroBodyClassName} text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]`}>
              Your personal financial advisor.
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
            <p className="mx-auto max-w-[34ch] text-center text-[13.5px] leading-5 tracking-normal text-[#86868b] dark:text-[rgba(245,245,247,0.44)]">
              One is consent-first. Your knowledge and information are your
              safewords — nothing leaves your vault without your approval.
            </p>
            <Button
              size="lg"
              fullWidth
              onClick={onNext}
              showRipple
              className="h-[50px] rounded-full bg-[#0066cc] text-[17px] font-medium tracking-normal !text-white shadow-none hover:bg-[#0071e3] dark:!text-white"
            >
              Get started
            </Button>
            {onLogin ? (
              <button
                type="button"
                className="type-subhead mx-auto block min-h-10 px-4 text-[#0066cc] transition-colors hover:text-[#0071e3] dark:text-[#2997ff] dark:hover:text-[#5eb0ff]"
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
