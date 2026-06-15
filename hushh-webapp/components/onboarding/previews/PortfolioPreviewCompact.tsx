"use client";

import Image from "next/image";
import { Card } from "@/lib/morphy-ux/card";
import { cn } from "@/lib/utils";

const HOLDINGS = [
  {
    name: "Tesla",
    symbol: "TSLA",
    detail: "38 sh",
    price: "$248.50",
    change: "+5.2%",
    direction: "up",
    logo: "tsla",
  },
  {
    name: "Apple",
    symbol: "AAPL",
    detail: "64 sh",
    price: "$189.20",
    change: "+1.1%",
    direction: "up",
    logo: "apple",
  },
  {
    name: "Nvidia",
    symbol: "NVDA",
    detail: "21 sh",
    price: "$121.40",
    change: "-0.8%",
    direction: "down",
    logo: "nvidia",
  },
] as const;

export function PortfolioPreviewCompact() {
  return (
    <Card
      variant="none"
      effect="glass"
      preset="hero"
      showRipple={false}
      className="h-full w-full"
    >
      <div className="morphy-theme-content flex h-full flex-col p-5 sm:p-6">
        <div className="flex h-full flex-col">
          <div>
            <div className="flex items-center justify-between gap-4">
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Total value
              </span>
              <span className="inline-flex items-center rounded-full bg-emerald-500/12 px-[9px] py-1 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-300">
                ▲ 2.4%
              </span>
            </div>

            <div className="mt-3 text-[38px] font-medium leading-none tracking-normal text-foreground sm:text-[48px]">
              $142,893
            </div>
          </div>

          <div className="flex flex-1 items-center py-3">
            <svg
              viewBox="0 0 300 70"
              preserveAspectRatio="none"
              className="h-[clamp(4rem,10vh,5.25rem)] w-full overflow-visible text-[#5856d6] dark:text-[#5e5ce6]"
              aria-hidden
            >
              <defs>
                <linearGradient id="portfolioPreviewGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d="M0 52 L25 48 L50 54 L75 40 L100 44 L125 30 L150 34 L175 22 L200 26 L225 14 L250 18 L275 8 L300 12 L300 70 L0 70 Z"
                fill="url(#portfolioPreviewGradient)"
              />
              <path
                d="M0 52 L25 48 L50 54 L75 40 L100 44 L125 30 L150 34 L175 22 L200 26 L225 14 L250 18 L275 8 L300 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <div className="divide-y divide-border/70">
            {HOLDINGS.map((holding) => (
              <div key={holding.symbol} className="flex items-center gap-3 py-2 first:pt-0">
                <LogoChip type={holding.logo} />
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] font-medium leading-tight tracking-normal">
                    {holding.name}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] tracking-[0.04em] text-muted-foreground">
                    {holding.symbol} · {holding.detail}
                  </p>
                </div>
                <div className="ml-auto text-right">
                  <p className="text-sm font-medium tabular-nums">
                    {holding.price}
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 text-[11.5px] font-medium tabular-nums",
                      holding.direction === "up"
                        ? "text-emerald-600 dark:text-emerald-300"
                        : "text-red-500 dark:text-red-300"
                    )}
                  >
                    {holding.change}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

function LogoChip({ type }: { type: (typeof HOLDINGS)[number]["logo"] }) {
  if (type === "apple") {
    return (
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-[#f5f5f7] text-[#1d1d1f] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)] dark:bg-white/10 dark:text-[#f5f5f7] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
        <Image
          src="/logos/apple.svg"
          alt="Apple logo"
          width={20}
          height={20}
          unoptimized
          className="h-5 w-5 object-contain dark:invert"
        />
      </span>
    );
  }

  if (type === "nvidia") {
    return (
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-[#76b900]/12 text-[#76b900] shadow-[inset_0_0_0_1px_rgba(118,185,0,0.10)] dark:bg-[#76b900]/18">
        <Image
          src="/logos/nvidia.svg"
          alt="Nvidia logo"
          width={22}
          height={22}
          unoptimized
          className="h-[22px] w-[22px] object-contain"
        />
      </span>
    );
  }

  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-[#e82127]/12 text-[#e82127] shadow-[inset_0_0_0_1px_rgba(232,33,39,0.10)] dark:text-[#ff4b50]">
      <Image
        src="/logos/tesla.svg"
        alt="Tesla logo"
        width={22}
        height={22}
        unoptimized
        className="h-[22px] w-[22px] object-contain"
      />
    </span>
  );
}
