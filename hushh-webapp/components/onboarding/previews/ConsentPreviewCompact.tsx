"use client";

import { Card } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { Check, ShieldCheck, X } from "lucide-react";

type ConsentRow = {
  app: string;
  ask: string;
  iconTone: string;
  decision: "allow" | "deny";
};

const CONSENT_ROWS: ConsentRow[] = [
  {
    app: "Finance",
    ask: "Read your portfolio",
    iconTone:
      "text-emerald-700 bg-emerald-500/12 dark:text-emerald-300 dark:bg-emerald-500/16",
    decision: "allow",
  },
  {
    app: "A brand",
    ask: "See your purchases",
    iconTone: "text-rose-700 bg-rose-500/12 dark:text-rose-300 dark:bg-rose-500/16",
    decision: "deny",
  },
];

export function ConsentPreviewCompact() {
  return (
    <Card
      variant="none"
      effect="glass"
      preset="hero"
      glassAccent="balanced"
      showRipple={false}
      className="w-full"
    >
      <div className="morphy-theme-content relative flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-4">
          <span className="type-caption text-muted-foreground">You decide</span>
          <span className="type-caption inline-flex items-center rounded-full bg-violet-500/12 px-2.5 py-0.5 text-violet-600 dark:text-violet-300">
            Consent
          </span>
        </div>

        <div className="flex flex-col items-center text-center">
          <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-violet-500/12 text-violet-600 dark:text-violet-300">
            <Icon icon={ShieldCheck} className="h-[22px] w-[22px]" />
          </span>
          <p className="type-headline mt-2 text-[15px]">Nothing moves without your yes</p>
        </div>

        <div className="flex flex-col gap-2">
          {CONSENT_ROWS.map((row) => {
            const allow = row.decision === "allow";
            return (
              <div
                key={row.app}
                className="flex items-center gap-3 rounded-[12px] border border-border/70 px-3 py-2"
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-[9px] ${row.iconTone}`}
                >
                  <span className="type-caption font-semibold text-[13px]">
                    {row.app.charAt(0)}
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="type-subhead text-[13px] font-medium leading-tight">{row.app}</p>
                  <p className="type-footnote text-[11px] text-muted-foreground truncate">{row.ask}</p>
                </div>
                <span
                  className={`grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full text-white ${
                    allow ? "bg-emerald-500" : "bg-muted-foreground/70"
                  }`}
                >
                  <Icon icon={allow ? Check : X} className="h-[12px] w-[12px]" strokeWidth={3} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
