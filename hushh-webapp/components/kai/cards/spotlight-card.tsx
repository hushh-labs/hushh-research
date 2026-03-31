"use client";

import { useRouter } from "next/navigation";
import { LineChart } from "lucide-react";

import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon } from "@/lib/morphy-ux/ui";
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
    <SurfaceCard
      accent={
        props.decision === "BUY"
          ? "emerald"
          : props.decision === "REDUCE"
            ? "amber"
            : "sky"
      }
      className="overflow-hidden"
    >
      <button
        type="button"
        disabled={!primaryHref}
        onClick={() => {
          if (!primaryHref) return;
          if (isExternal) {
            window.open(primaryHref, "_blank", "noopener,noreferrer");
            return;
          }
          router.push(primaryHref);
        }}
        className={cn(
          "group relative block w-full overflow-hidden rounded-[inherit] text-left outline-none transition-colors",
          primaryHref ? "hover:bg-foreground/[0.03] active:bg-foreground/[0.055]" : "cursor-default"
        )}
      >
        <SurfaceCardContent className="space-y-4 p-5">
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
                <span className="inline-flex items-center rounded-full bg-background/70 px-2 py-1 text-[10px] font-bold tracking-wide text-muted-foreground">
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

          <div className="flex items-center gap-2 border-t border-border/40 pt-3 text-xs text-muted-foreground">
            <Icon icon={LineChart} size="sm" />
            <span className="line-clamp-1">{props.context}</span>
          </div>
        </SurfaceCardContent>
        {primaryHref ? <MaterialRipple variant="none" effect="fade" className="z-10" /> : null}
      </button>
    </SurfaceCard>
  );
}
