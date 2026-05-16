"use client";

import { Cpu, Percent, Zap, type LucideIcon } from "lucide-react";

import { Icon } from "@/lib/morphy-ux/ui";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { marketCardClassName } from "@/components/kai/shared/market-surface-theme";
import { cn } from "@/lib/utils";

export interface ThemeFocusItem {
  id?: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
}

const FALLBACK_ICON: LucideIcon[] = [Cpu, Percent, Zap];

export function ThemeFocusList({ themes = [] }: { themes?: ThemeFocusItem[] }) {
  if (!themes.length) {
    return (
      <SurfaceCard>
        <SurfaceCardContent className="px-4 py-4 text-sm text-muted-foreground">
          No active market themes are available right now.
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {themes.map((theme, idx) => (
        <SurfaceCard
          key={theme.id || theme.title}
          accent="none"
          className={cn("h-full", marketCardClassName)}
        >
          <SurfaceCardContent className="flex h-full min-w-0 items-start gap-3 p-4">
            <div
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-muted-foreground shadow-[var(--shadow-xs)]"
              )}
            >
              <Icon
                icon={theme.icon || FALLBACK_ICON[idx % FALLBACK_ICON.length] || Cpu}
                size="md"
              />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold leading-tight text-foreground">{theme.title}</p>
              <p className="text-xs leading-5 text-muted-foreground">{theme.subtitle}</p>
            </div>
          </SurfaceCardContent>
        </SurfaceCard>
      ))}
    </div>
  );
}
