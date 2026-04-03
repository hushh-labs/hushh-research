"use client";

import { useRouter } from "next/navigation";
import { LineChart } from "lucide-react";

import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { Card as MorphyCard, CardContent as MorphyCardContent } from "@/lib/morphy-ux/card";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon } from "@/lib/morphy-ux/ui";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";

type SpotlightDecision = "BUY" | "HOLD" | "WATCH" | "REDUCE";

export function SpotlightCard(props: {
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
}) {
  const router = useRouter();
  const decisionTone =
    props.decision === "BUY"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : props.decision === "WATCH"
        ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
      : props.decision === "HOLD"
        ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
        : "bg-orange-500/10 text-orange-700 dark:text-orange-300";

  const primaryHref = props.contextHref || props.fallbackHref || null;
  const isExternal = Boolean(props.contextHref);

  return (
    <MorphyCard
      preset="surface"
      variant="none"
      effect="glass"
      showRipple={false}
      glassAccent="soft"
      className={cn(
        "group relative isolate !overflow-hidden !gap-0 !py-0 rounded-[24px] transition-[border-color,box-shadow,background-color] duration-200 ease-out",
        primaryHref
          ? "hover:shadow-[0_16px_34px_rgba(15,23,42,0.08)]"
          : undefined
      )}
    >
      <button
        type="button"
        disabled={!primaryHref}
        onClick={() => {
          if (!primaryHref) return;
          if (isExternal) {
            openExternalUrl(primaryHref);
            return;
          }
          router.push(primaryHref);
        }}
        className={cn(
          "relative block h-full w-full overflow-hidden rounded-[inherit] text-left outline-none transition-[background-color] duration-200 ease-out",
          primaryHref
            ? "cursor-pointer hover:bg-white/[0.03] active:bg-white/[0.06]"
            : "cursor-default"
        )}
      >
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200",
            props.decision === "BUY"
              ? "bg-linear-to-br from-emerald-500/[0.06] via-transparent to-sky-500/[0.04] group-hover:opacity-100"
              : props.decision === "REDUCE"
                ? "bg-linear-to-br from-amber-500/[0.07] via-transparent to-rose-500/[0.04] group-hover:opacity-100"
                : "bg-linear-to-br from-sky-500/[0.06] via-transparent to-violet-500/[0.04] group-hover:opacity-100"
          )}
        />
        <MorphyCardContent className="relative z-[1] space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <SymbolAvatar symbol={props.symbol} name={props.companyName} size="md" />
              <div className="min-w-0 space-y-1">
                <h3 className="text-base font-black tracking-tight leading-tight">{props.title}</h3>
                <p className="text-sm text-muted-foreground">{props.price}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {props.confidenceLabel ? (
                <span className="inline-flex items-center rounded-full bg-background/75 px-2 py-1 text-[10px] font-bold tracking-wide text-muted-foreground transition-colors duration-200 group-hover:bg-background/85">
                  {props.confidenceLabel}
                </span>
              ) : null}
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-extrabold tracking-wide",
                  decisionTone
                )}
              >
                {props.decision}
              </span>
            </div>
          </div>

          <p className="text-sm font-medium leading-relaxed">{props.summary}</p>

          <div className="flex items-center gap-2 border-t border-border/40 pt-3 text-xs text-muted-foreground transition-colors duration-200 group-hover:border-border/60">
            <Icon icon={LineChart} size="sm" />
            <span className="line-clamp-1 transition-colors duration-200 group-hover:text-foreground/85">
              {props.context}
            </span>
          </div>
        </MorphyCardContent>
        {primaryHref ? <MaterialRipple variant="none" effect="fade" className="z-10" /> : null}
      </button>
    </MorphyCard>
  );
}
