"use client";

import { useRouter } from "next/navigation";
import { LineChart, ArrowRight } from "lucide-react";

import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { Card as MorphyCard, CardContent as MorphyCardContent } from "@/lib/morphy-ux/card";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon } from "@/lib/morphy-ux/ui";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";

type SpotlightDecision = "BUY" | "HOLD" | "WATCH" | "REDUCE";

interface SpotlightCardProps {
  symbol: string;
  companyName?: string | null;
  title: string;
  price: string;
  decision: SpotlightDecision;
  confidenceLabel?: string | null;
  summary: string;
  context: string;
  contextHref?: string | null;
  fallbackHref?: string | null;
  compact?: boolean; // New Feature: Compact mode
}

// Decision mapping for better maintenance
const DECISION_STYLES: Record<SpotlightDecision, string> = {
  BUY: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  HOLD: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  WATCH: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  REDUCE: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
};

export function SpotlightCard({
  symbol,
  companyName,
  title,
  price,
  decision,
  summary,
  context,
  contextHref,
  fallbackHref,
  compact = false,
}: SpotlightCardProps) {
  const router = useRouter();

  const primaryHref = contextHref || fallbackHref || null;
  const isExternal = Boolean(contextHref);

  const decisionStyle = DECISION_STYLES[decision as SpotlightDecision];

  const handleNavigation = () => {
    if (!primaryHref) return;
    isExternal ? openExternalUrl(primaryHref) : router.push(primaryHref);
  };

  return (
    <MorphyCard
      preset="surface"
      variant="none"
      effect="glass"
      glassAccent="soft"
      className={cn(
        "group relative isolate !overflow-hidden !rounded-[24px] transition-all duration-300",
        primaryHref && "hover:shadow-xl hover:border-border/80 cursor-pointer"
      )}
    >
      <button
        type="button"
        disabled={!primaryHref}
        onClick={handleNavigation}
        aria-label={`View details for ${title}`}
        className="relative block h-full w-full text-left outline-none"
      >
        <MorphyCardContent className={cn("relative z-[1] p-5", compact ? "space-y-2" : "space-y-4")}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <SymbolAvatar symbol={symbol} name={companyName} size={compact ? "sm" : "md"} />
              <div>
                <h3 className="font-semibold leading-tight tracking-tight">{title}</h3>
                <p className="text-xs text-muted-foreground">{price}</p>
              </div>
            </div>
            <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase", decisionStyle)}>
              {decision}
            </span>
          </div>

          <p className={cn("text-sm font-medium leading-relaxed", compact ? "line-clamp-2" : "")}>{summary}</p>

          <div className="flex items-center justify-between border-t border-border/40 pt-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Icon icon={LineChart} size="sm" />
              <span className="line-clamp-1">{context}</span>
            </div>
            {primaryHref && <Icon icon={ArrowRight} size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity" />}
          </div>
        </MorphyCardContent>
        {primaryHref && <MaterialRipple variant="none" className="z-10" />}
      </button>
    </MorphyCard>
  );
}