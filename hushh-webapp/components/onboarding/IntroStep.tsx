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
import { cn } from "@/lib/utils";

// Inner glyph detail is "knocked out" to the icon tile's background so the
// cutout reads as transparent against the dark tile. Falls back to white.
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

// Finance: One's money capability (Kai). Stroked coin + dollar glyph.
function FinanceCapabilityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
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

// Gmail / inbox: One's email capability.
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

// Content is OURS (unchanged); only the presentation moved into the 2b dark card.
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

// Knockout color for the icon cutouts, tuned to the dark tile over the card.
const INTRO_ICON_TILE_STYLE = {
  ["--intro-feature-bg" as string]: "#181530",
} as CSSProperties;

export function IntroStep({
  onNext,
  onLogin,
}: {
  onNext: () => void;
  onLogin?: () => void;
}) {
  return (
    <main className="min-h-[100dvh] w-full bg-[#ffffff] text-[#1d1d1f] transition-colors duration-300 dark:bg-[#0a0a0c] dark:text-[#f5f5f7]">
      {/* Reserve bottom room for the global agent bar anchored above the safe
          area on this intro screen, so the footer CTAs never collide with it. */}
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[440px] flex-col px-6 pt-[calc(34px+var(--app-safe-area-top-effective,0px))] pb-[calc(94px+var(--app-safe-area-bottom-effective,0px))]">
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-8 py-6">
          {/* Hero: app-icon tile + wordmark + subtitle */}
          <section className="relative flex flex-none flex-col items-center text-center">
            <div className="grid h-20 w-20 place-items-center rounded-[22px] bg-[#141118] shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
              <Image
                src="/one-quiet-emoji.png"
                alt=""
                width={762}
                height={766}
                priority
                unoptimized
                aria-hidden="true"
                draggable={false}
                className="h-12 w-12 select-none object-contain"
              />
            </div>

            <div
              role="heading"
              aria-level={1}
              aria-label="hushh One, a memory that's only yours"
              className={`relative mt-4 flex items-baseline justify-center gap-2 ${kaiAppHeroTitleClassName} text-[#1d1d1f] dark:text-[#f5f5f7]`}
            >
              <HushhWordmark className="h-[0.92em] w-auto translate-y-[0.06em]" />
              <OneLockup />
            </div>
            <p className={`relative mt-3 ${kaiAppHeroBodyClassName} text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]`}>
              A memory that&apos;s only yours.
            </p>
          </section>

          {/* 2b dark card — near-black indigo base, indigo glow, emerald PRIVATE */}
          <div
            className="relative flex-none overflow-hidden rounded-[26px] p-5"
            style={{
              background: "linear-gradient(150deg, #0D0B18 0%, #171334 100%)",
              boxShadow:
                "0 14px 30px rgba(94,92,230,0.22), inset 0 0 0 0.5px rgba(255,255,255,0.06)",
            }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute -right-9 -top-14 h-44 w-44 rounded-full"
              style={{ background: "rgba(94,92,230,0.55)", filter: "blur(38px)" }}
            />

            <div className="relative flex items-center justify-between">
              <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-white/45">
                What you get
              </span>
              <span className="rounded-full bg-[rgba(48,209,88,0.15)] px-3 py-1 text-[12px] font-bold tracking-[0.06em] text-[#30D158]">
                PRIVATE
              </span>
            </div>

            <div className="relative mt-3 flex flex-col">
              {INTRO_FEATURES.map((feature, index) => (
                <div
                  key={feature.title}
                  className={cn(
                    "flex items-center gap-3.5 py-3.5",
                    index > 0 && "border-t border-white/[0.08]",
                  )}
                >
                  <span
                    className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-white/[0.06] text-white/90"
                    style={INTRO_ICON_TILE_STYLE}
                  >
                    <feature.icon className="h-[22px] w-[22px]" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[16px] font-semibold leading-[1.2] tracking-[-0.1px] text-white [overflow-wrap:anywhere]">
                      {feature.title}
                    </p>
                    <p className="mt-0.5 text-[14px] leading-[1.32] text-white/55 [overflow-wrap:anywhere]">
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
                className="mx-auto block min-h-10 px-4 text-[15px] font-semibold tracking-normal text-[#5E5CE6] transition-colors hover:text-[#4a48c9] dark:text-[#8b8aff] dark:hover:text-[#a3a2ff]"
                onClick={onLogin}
              >
                Log in
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </main>
  );
}
