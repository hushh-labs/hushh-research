"use client";

import type { ComponentType, SVGProps } from "react";
import { Button } from "@/lib/morphy-ux/button";

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
  tileClassName: string;
}> = [
  {
    icon: ShieldBadgeIcon,
    title: "Verified in minutes",
    subtitle: "Seamless KYC, no paperwork",
    tileClassName:
      "border-[#d7f8e0] bg-[linear-gradient(135deg,rgba(255,255,255,0.94),rgba(240,253,244,0.72))] text-[#34c759] shadow-[0_12px_28px_rgba(52,199,89,0.10)]",
  },
  {
    icon: HoldingsBarsIcon,
    title: "Top holdings, at a glance",
    subtitle: "Your portfolio, always live",
    tileClassName:
      "border-[#e1e2ff] bg-[linear-gradient(135deg,rgba(255,255,255,0.94),rgba(247,247,255,0.76))] text-[#5856d6] shadow-[0_12px_28px_rgba(88,86,214,0.10)]",
  },
  {
    icon: SignalPulseIcon,
    title: "Buy, sell, hold",
    subtitle: "Clear signals when they matter",
    tileClassName:
      "border-[#ffe1bd] bg-[linear-gradient(135deg,rgba(255,255,255,0.94),rgba(255,247,237,0.72))] text-[#ff9500] shadow-[0_12px_28px_rgba(255,149,0,0.10)]",
  },
];

export function IntroStep({
  onNext,
  onLogin,
}: {
  onNext: () => void;
  onLogin?: () => void;
}) {
  return (
    <main className="min-h-[100dvh] w-full bg-[#ffffff] text-[#1d1d1f] dark:bg-[#ffffff] dark:text-[#1d1d1f]">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[440px] flex-col px-6 pt-[calc(28px+var(--app-safe-area-top-effective,0px))]">
        <section className="relative flex flex-none flex-col items-center text-center">
          <span className="relative text-[54px] leading-none">🤫</span>

          <div
            role="heading"
            aria-level={1}
            aria-label="Meet One, Your Personal Financial Advisor"
            className="relative mt-6 text-[38px] font-bold leading-[1.08] tracking-normal text-[#1d1d1f]"
          >
            Meet One.
          </div>
          <p className="relative mt-2.5 text-[21px] font-medium leading-[1.32] tracking-normal text-[#1d1d1f]">
            Your personal financial advisor.
          </p>
        </section>

        <div className="flex min-h-0 flex-1 items-stretch py-6">
          <div className="relative w-full">
            <div className="relative z-10 mx-auto flex h-full w-full max-w-[332px] flex-col justify-evenly gap-3">
              {INTRO_FEATURES.map((feature) => (
                <div key={feature.title} className="grid grid-cols-[46px_minmax(0,1fr)] items-center gap-4">
                  <span
                    className={`grid h-[46px] w-[46px] place-items-center rounded-[14px] border ${feature.tileClassName}`}
                  >
                    <feature.icon className="h-[23px] w-[23px]" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[16.5px] font-semibold leading-[1.25] tracking-normal text-[#1d1d1f]">
                      {feature.title}
                    </p>
                    <p className="mt-0.5 text-[14.5px] leading-[1.35] tracking-normal text-[rgba(0,0,0,0.56)]">
                      {feature.subtitle}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <footer className="flex-none pb-[calc(16px+var(--app-safe-area-bottom-effective,0px))]">
          <div className="space-y-4">
            <p className="mx-auto max-w-[35ch] text-center text-sm leading-5 tracking-normal text-[#9a9a9f]">
              One is consent-first. Your data stays in your vault — nothing is
              shared without your approval.
            </p>
            <Button
              size="lg"
              fullWidth
              onClick={onNext}
              showRipple
              className="h-[50px] rounded-full bg-[#0071e3] text-[17px] font-semibold tracking-normal text-white shadow-none hover:bg-[#0077ed]"
            >
              Get started
            </Button>
            {onLogin ? (
              <button
                type="button"
                className="mx-auto block min-h-10 px-4 text-[15px] font-semibold tracking-normal text-[#0066cc] transition-colors hover:text-[#0071e3]"
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
