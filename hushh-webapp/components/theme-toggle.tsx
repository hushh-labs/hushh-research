"use client";

import { useEffect, useState } from "react";
import { Moon, Monitor, Sun } from "lucide-react";
import { useTheme } from "next-themes";

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

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const normalizedTheme = (theme ?? "").trim().toLowerCase();
  const activeTheme: ThemeOption =
    normalizedTheme === "light" || normalizedTheme === "dark" || normalizedTheme === "system"
      ? (normalizedTheme as ThemeOption)
      : "system";
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
