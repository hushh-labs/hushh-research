"use client";

import { Card } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { Check, Home, Landmark, User, Zap } from "lucide-react";

type KycDisplayItem = {
  label: string;
  icon: typeof User;
  iconTone: string;
};

const KYC_ITEMS: KycDisplayItem[] = [
  {
    label: "Identity",
    icon: User,
    iconTone: "text-[#0071e3] bg-[#0071e3]/10 dark:text-[#2997ff] dark:bg-[#2997ff]/16",
  },
  {
    label: "Address",
    icon: Home,
    iconTone: "text-[#5856d6] bg-[#5856d6]/10 dark:text-[#5e5ce6] dark:bg-[#5e5ce6]/18",
  },
  {
    label: "Bank link",
    icon: Landmark,
    iconTone: "text-[#ff9500] bg-[#ff9500]/12 dark:text-[#ff9f0a] dark:bg-[#ff9f0a]/18",
  },
];

export function KycPreviewCompact() {
  return (
    <Card
      variant="none"
      effect="glass"
      preset="hero"
      glassAccent="balanced"
      showRipple={false}
      className="h-full w-full"
    >
      <div className="morphy-theme-content relative flex h-full flex-col overflow-hidden p-5 sm:p-6">
        <div className="relative flex h-full flex-col">
          <div>
            <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Identity check
            </span>
            <span className="inline-flex items-center rounded-full bg-emerald-500/12 px-[11px] py-[5px] text-xs font-bold text-emerald-600 dark:text-emerald-300">
              Verified
            </span>
            </div>

            <div className="mt-4 flex gap-1.5">
              <span className="h-[5px] flex-1 rounded-full bg-emerald-500" />
              <span className="h-[5px] flex-1 rounded-full bg-emerald-500" />
              <span className="h-[5px] flex-1 rounded-full bg-emerald-500" />
            </div>
          </div>

          <div className="flex flex-1 flex-col justify-center divide-y divide-border/70 py-3">
            {KYC_ITEMS.map((item) => (
              <div
                key={item.label}
                className="flex items-center gap-[13px] py-3"
              >
                <span
                  className={`grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] ${item.iconTone}`}
                >
                  <Icon icon={item.icon} size="md" />
                </span>
                <span className="flex-1 text-[15px] font-semibold tracking-normal">
                  {item.label}
                </span>
                <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
                  <Icon icon={Check} size={13} strokeWidth={3} />
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-[13px] border-t border-border/70 pt-4">
            <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[11px] bg-[#0071e3]/10 text-[#0071e3] dark:bg-[#2997ff]/16 dark:text-[#2997ff]">
              <Icon icon={Zap} size="md" />
            </span>
            <div>
              <p className="text-[14.5px] font-bold leading-tight tracking-normal">
                KYC completed in minutes
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                90% faster than traditional KYC
              </p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
