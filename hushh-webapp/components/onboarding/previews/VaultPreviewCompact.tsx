"use client";

import { Card } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { Fingerprint, KeyRound, Lock, ShieldCheck } from "lucide-react";

type VaultRow = {
  label: string;
  sublabel: string;
  icon: typeof Lock;
  iconTone: string;
};

const VAULT_ROWS: VaultRow[] = [
  {
    label: "Encrypted on your device",
    sublabel: "Your key never leaves you",
    icon: KeyRound,
    iconTone: "text-[#0071e3] bg-[#0071e3]/10 dark:text-[#2997ff] dark:bg-[#2997ff]/16",
  },
  {
    label: "Unlock with Face ID",
    sublabel: "Or a phrase only you know",
    icon: Fingerprint,
    iconTone: "text-[#5856d6] bg-[#5856d6]/10 dark:text-[#5e5ce6] dark:bg-[#5e5ce6]/18",
  },
];

export function VaultPreviewCompact() {
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
          <span className="type-caption text-muted-foreground">Your vault</span>
          <span className="type-caption inline-flex items-center rounded-full bg-emerald-500/12 px-2.5 py-0.5 text-emerald-600 dark:text-emerald-300">
            Private
          </span>
        </div>

        <div className="flex flex-col items-center text-center">
          <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-[#0071e3]/10 text-[#0071e3] dark:bg-[#2997ff]/16 dark:text-[#2997ff]">
            <Icon icon={Lock} className="h-[22px] w-[22px]" />
          </span>
          <p className="type-headline mt-2 text-[15px]">Only you hold the key</p>
          <p className="type-footnote mt-0.5 text-muted-foreground text-[11px]">
            No one can read it, not even us
          </p>
        </div>

        <div className="flex flex-col divide-y divide-border/70 border-t border-border/70">
          {VAULT_ROWS.map((row) => (
            <div key={row.label} className="flex items-center gap-3 py-2">
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${row.iconTone}`}
              >
                <Icon icon={row.icon} className="h-[17px] w-[17px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="type-headline text-[13px] font-medium leading-tight">{row.label}</p>
                <p className="type-footnote mt-0.5 text-muted-foreground text-[11px] leading-tight truncate">
                  {row.sublabel}
                </p>
              </div>
              <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
                <Icon icon={ShieldCheck} className="h-[13px] w-[13px]" strokeWidth={2.6} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
