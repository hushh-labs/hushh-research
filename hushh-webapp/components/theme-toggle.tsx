"use client";

import * as React from "react";
import { Moon, Monitor, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

type ThemeOption = "light" | "dark" | "system";

const THEME_OPTIONS: Array<{ value: ThemeOption; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function resolveActiveTheme(theme: string | undefined): ThemeOption {
  const normalized = (theme ?? "").trim().toLowerCase();
  return (["light", "dark", "system"].includes(normalized) ? normalized : "system") as ThemeOption;
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  if (!mounted) return <div className={cn("h-12 w-full sm:w-[216px]", className)} />;

  const activeTheme = resolveActiveTheme(theme);
  const isDark = resolvedTheme === "dark";

  return (
    <div
      role="radiogroup"
      aria-label="Theme selector"
      className={cn(
        "relative grid w-full grid-cols-3 rounded-full p-1 backdrop-blur-xl sm:w-[216px]",
        isDark ? "border border-white/6 bg-black" : "border border-slate-200 bg-white",
        className
      )}
    >
      {THEME_OPTIONS.map((option) => {
        const isActive = option.value === activeTheme;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => setTheme(option.value)}
            className={cn(
              "relative flex min-h-10 items-center justify-center gap-1.5 rounded-full border transition-all duration-150",
              isDark
                ? (isActive ? "border-white/8 bg-neutral-900 text-white" : "border-transparent text-zinc-400 hover:text-zinc-100")
                : (isActive ? "border-slate-200/90 bg-white text-slate-950 shadow-sm" : "border-transparent text-slate-500 hover:text-slate-900")
            )}
          >
            <span className="relative z-10 flex items-center gap-1.5">
              <Icon icon={option.icon} size="sm" aria-hidden="true" />
              <span className="text-[11px] font-medium sm:text-xs">{option.label}</span>
            </span>
            <MaterialRipple variant="none" effect="fade" />
          </button>
        );
      })}
    </div>
  );
}

export function ThemeToggleCompact({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const activeTheme = resolveActiveTheme(theme);
  const activeOption = THEME_OPTIONS.find((o) => o.value === activeTheme) ?? THEME_OPTIONS[0]!;
  const isDark = resolvedTheme === "dark";

  if (!mounted) return <div className="h-9 w-9" />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Change theme"
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-xl transition-colors",
            isDark ? "border-white/8 bg-black/85 text-zinc-100" : "border-slate-200 bg-white/85 text-slate-700",
            className
          )}
        >
          <Icon icon={activeOption.icon} size="sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8}>
        {THEME_OPTIONS.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => setTheme(option.value)}>
            <Icon icon={option.icon} size="sm" className="mr-2" />
            <span className="flex-1">{option.label}</span>
            {option.value === activeTheme && <span className="text-xs">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}