"use client";

import Image from "next/image";
import { Card } from "@/lib/morphy-ux/card";
import { cn } from "@/lib/utils";

const ANALYSIS_ROWS = [
  {
    text: "Record deliveries and expanding margins",
  },
  {
    text: "Strong momentum and institutional backing",
  },
  {
    text: "Attractive entry point for long-term growth",
  },
] as const;

export function DecisionPreviewCompact() {
  return (
    <Card
      variant="none"
      effect="glass"
      preset="hero"
      showRipple={false}
      className="h-full w-full"
    >
      <div className="morphy-theme-content flex h-full flex-col p-6">
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <TeslaLogoChip />
              <span className="min-w-0">
                <p className="type-title3 text-[#1d1d1f] dark:text-[#f5f5f7]">
                  Tesla
                </p>
                <p className="type-caption mt-0.5 text-muted-foreground">
                  TSLA · NASDAQ
                </p>
              </span>
            </div>
            <span className="ml-auto shrink-0 text-right">
              <p className="type-headline type-numeric text-[#1d1d1f] dark:text-[#f5f5f7]">
                $248.50
              </p>
              <span className="type-footnote type-numeric mt-1 inline-flex rounded-full bg-[#34c759]/10 px-[9px] py-1 text-[#1f9d55] dark:bg-[#30d158]/16 dark:text-[#30d158]">
                ▲ 5.2%
              </span>
            </span>
          </div>

          <div className="flex flex-1 flex-col justify-center py-5">
            <div className="space-y-1">
              <p className="type-caption text-muted-foreground">
                Recommendation
              </p>
              <div className="flex items-end justify-between gap-4">
                <p className="type-display text-[#1d1d1f] dark:text-[#f5f5f7]">
                  Buy
                </p>
                <span className="type-footnote mb-1 rounded-full bg-[#34c759]/10 px-3 py-1.5 text-[#1f9d55] dark:bg-[#30d158]/16 dark:text-[#30d158]">
                  High conviction
                </span>
              </div>
              <p className="type-footnote text-muted-foreground">
                Horizon 12+ months
              </p>
            </div>

            <div className="mt-6 space-y-3.5">
              {ANALYSIS_ROWS.map((item) => (
                <div key={item.text} className="flex items-start gap-3">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#34c759] dark:bg-[#30d158]" />
                  <span className="type-subhead min-w-0 text-[#1d1d1f] dark:text-[#f5f5f7]">
                    {item.text}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="grid grid-cols-3 gap-2">
              <ActionPill active label="Buy" />
              <ActionPill label="Hold" />
              <ActionPill label="Sell" />
            </div>

            <p className="type-footnote mt-3 text-center text-muted-foreground">
              Clear signal, no noise.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ActionPill({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <div
      className={cn(
        "type-subhead flex-1 rounded-[14px] px-2 py-3 text-center",
        active
          ? "bg-[#34c759] text-white shadow-[0_12px_26px_-14px_rgba(52,199,89,0.62)] dark:bg-[#30d158] dark:text-black"
          : "bg-[#f5f5f7] text-muted-foreground dark:bg-white/10"
      )}
    >
      {label}
    </div>
  );
}

function TeslaLogoChip() {
  return (
    <span className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[13px] bg-red-500/10 text-red-500">
      <Image
        src="/logos/tesla.svg"
        alt="Tesla logo"
        width={30}
        height={30}
        unoptimized
        className="h-[30px] w-[30px] object-contain"
      />
    </span>
  );
}
