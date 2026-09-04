"use client";

import { Card } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { ChevronRight } from "lucide-react";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import {
  getOneCapability,
  isOneCapabilityEnabled,
  type OneCapability,
} from "@/lib/onboarding/one-capabilities";

// "What lies ahead": a representative slice of the REAL /one dashboard
// capabilities a new user will unlock. Sourced from the shared catalog so it
// can never drift from the dashboard tiles.
const PREVIEW_IDS = ["finance", "gmail", "calendar", "location"] as const;

const PREVIEW_CAPABILITIES: OneCapability[] = PREVIEW_IDS.map(
  getOneCapability,
).filter(
  (capability): capability is OneCapability =>
    Boolean(capability) && isOneCapabilityEnabled(capability),
);

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
          <span className="type-caption inline-flex items-center rounded-full bg-[color:var(--app-accent-tint)] px-2.5 py-0.5 text-[color:var(--app-accent-deep)]">
            Your apps
          </span>
        </div>

        <div className="flex flex-col divide-y divide-border/70">
          {PREVIEW_CAPABILITIES.map((cap) => (
            <div key={cap.id} className="flex items-center gap-3 py-2">
              <AgentSectionIcon
                id={cap.id}
                icon={cap.icon}
                tone={cap.tone}
                size="menu"
              />
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
