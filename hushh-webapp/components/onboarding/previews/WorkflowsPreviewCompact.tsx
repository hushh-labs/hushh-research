"use client";

import { Card } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { ChevronRight } from "lucide-react";

import {
  ONE_CAPABILITIES,
  ONE_CAPABILITY_ICON_CLASS_BY_TONE,
  type OneCapability,
} from "@/lib/onboarding/one-capabilities";

// "What lies ahead": a representative slice of the REAL /one dashboard
// capabilities a new user will unlock. Sourced from the shared catalog so it
// can never drift from the dashboard tiles.
const PREVIEW_IDS = ["finance", "gmail", "location"] as const;

const PREVIEW_CAPABILITIES: OneCapability[] = PREVIEW_IDS.map(
  (id) => ONE_CAPABILITIES.find((c) => c.id === id)!,
).filter(Boolean);

export function WorkflowsPreviewCompact() {
  return (
    <Card
      variant="none"
      effect="glass"
      preset="hero"
      glassAccent="balanced"
      showRipple={false}
      className="w-full"
    >
      <div className="morphy-theme-content relative flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-4">
          <span className="type-caption text-muted-foreground">What One can do</span>
          <span className="type-caption inline-flex items-center rounded-full bg-[#0071e3]/12 px-2.5 py-0.5 text-[#0071e3] dark:text-[#2997ff]">
            Your apps
          </span>
        </div>

        <div className="flex flex-col divide-y divide-border/70">
          {PREVIEW_CAPABILITIES.map((cap) => (
            <div key={cap.id} className="flex items-center gap-3 py-2">
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${ONE_CAPABILITY_ICON_CLASS_BY_TONE[cap.tone]}`}
              >
                <Icon icon={cap.icon} className="h-[17px] w-[17px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="type-headline text-[13px] font-medium leading-tight">{cap.title}</p>
                <p className="type-footnote mt-0.5 text-muted-foreground text-[11px] leading-tight">
                  {cap.previewLabel ?? cap.description}
                </p>
              </div>
              <Icon
                icon={ChevronRight}
                className="h-4 w-4 shrink-0 text-muted-foreground"
              />
            </div>
          ))}
        </div>

        <p className="type-footnote border-t border-border/70 pt-2 text-center text-muted-foreground text-[11px]">
          More opens up as you grow, all in one place
        </p>
      </div>
    </Card>
  );
}
