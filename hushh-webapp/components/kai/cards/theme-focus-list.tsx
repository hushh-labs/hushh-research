"use client";

import { Cpu, Percent, Zap, type LucideIcon } from "lucide-react";

import { Icon } from "@/lib/morphy-ux/ui";
import { SettingsGroup } from "@/components/profile/settings-ui";

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
      <SettingsGroup>
        <div className="px-4 py-4 text-sm text-muted-foreground">
          No active market themes are available right now.
        </div>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup>
      {themes.map((theme, idx) => (
        <div
          key={theme.id || theme.title}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-muted-foreground shadow-[var(--shadow-xs)]">
              <Icon icon={theme.icon || FALLBACK_ICON[idx % FALLBACK_ICON.length] || Cpu} size="md" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight text-foreground">{theme.title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{theme.subtitle}</p>
            </div>
          </div>
        </div>
      ))}
    </SettingsGroup>
  );
}
