"use client";

import { useEffect, useState } from "react";
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

const THEME_OPTIONS: Array<{
  value: ThemeOption;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function resolveActiveTheme(theme: string | undefined): ThemeOption {
  const normalized = (theme ?? "").trim().toLowerCase();
  if (normalized === "light" || normalized === "dark" || normalized === "system") {
    return normalized as ThemeOption;
  }
  return "system";
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const activeTheme = resolveActiveTheme(theme);
  const isDark = resolvedTheme === "dark";

  if (!mounted) return null;

  return (
    <div
      data-theme-control
      role="radiogroup"
      aria-label="Theme selector"
      className={cn(
        "relative grid w-full min-w-0 grid-cols-3 items-center rounded-full p-1 backdrop-blur-xl sm:w-[216px]",
        isDark
          ? "border border-white/6 bg-black"
          : "border border-slate-200 bg-white",
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
            onClick={() => {
              if (option.value === activeTheme) return;
              setTheme(option.value);
            }}
            className={cn(
              "relative flex min-h-10 min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border px-2 py-2 text-center transition-[background-color,border-color,color,transform] duration-150",
              isDark
                ? isActive
                  ? "border-white/8 bg-neutral-900 text-white"
                  : "border-transparent bg-transparent text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100"
                : isActive
                  ? "border-slate-200/90 bg-[linear-gradient(180deg,rgba(255,255,255,1),rgba(248,250,252,0.98))] text-slate-950"
                  : "border-transparent bg-transparent text-slate-500 hover:bg-white/72 hover:text-slate-900"
            )}
          >
            <span className="relative z-10 inline-flex items-center gap-1.5">
              <Icon icon={option.icon} size="sm" />
              <span className="text-[11px] font-medium leading-none sm:text-xs">
                {option.label}
              </span>
            </span>
            <MaterialRipple variant="none" effect="fade" className="z-0" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Compact icon-only theme switcher for tight surfaces (e.g. onboarding chrome).
 * Closes #506: replaces the full segmented control with a 36px icon button
 * that opens a dropdown with the same Light / Dark / System options.
 */
export function ThemeToggleCompact({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const activeTheme = resolveActiveTheme(theme);
  // resolveActiveTheme always returns one of the THEME_OPTIONS values, so
  // .find() is guaranteed to hit. Assert with a non-null fallback for the
  // type checker under noUncheckedIndexedAccess.
  const activeOption: (typeof THEME_OPTIONS)[number] =
    THEME_OPTIONS.find((option) => option.value === activeTheme) ?? THEME_OPTIONS[0]!;
  const isDark = resolvedTheme === "dark";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Theme: ${activeOption.label}. Click to change.`}
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-xl transition-[background-color,border-color,color] duration-150",
            isDark
              ? "border-white/8 bg-black/85 text-zinc-100 hover:bg-neutral-900"
              : "border-slate-200 bg-white/85 text-slate-700 hover:bg-white",
            className
          )}
        >
          <Icon icon={activeOption.icon} size="sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-[140px]">
        {THEME_OPTIONS.map((option) => {
          const isActive = option.value === activeTheme;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => {
                if (!isActive) setTheme(option.value);
              }}
              className={cn(
                "flex items-center gap-2",
                isActive && "font-medium"
              )}
            >
              <Icon icon={option.icon} size="sm" />
              <span className="flex-1">{option.label}</span>
              {isActive ? <span aria-hidden className="text-xs">✓</span> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
