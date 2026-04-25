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
  const [isOpen, setIsOpen] = useState(false);

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
    <div className="relative">
      {/* Main Icon Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={() => setIsOpen(true)}
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full border backdrop-blur-xl transition",
          isDark
            ? "border-white/10 bg-black text-white"
            : "border-slate-200 bg-white text-slate-900"
        )}
      >
        <Icon
          icon={
            activeTheme === "light"
              ? Sun
              : activeTheme === "dark"
              ? Moon
              : Monitor
          }
          size="sm"
        />
      </button>

      {/* Dropdown Options */}
      {isOpen && (
        <div
          onMouseLeave={() => setIsOpen(false)}
          className={cn(
            "absolute right-0 mt-2 min-w-[120px] flex flex-col rounded-xl border shadow-lg z-50",
            isDark
              ? "border-white/10 bg-neutral-900"
              : "border-slate-200 bg-white"
          )}
        >
          {THEME_OPTIONS.map((option) => {
            const isActive = option.value === activeTheme;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setTheme(option.value);
                  setIsOpen(false);
                }}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm transition",
                  isDark
                    ? "hover:bg-white/5 text-white"
                    : "hover:bg-slate-100 text-slate-900",
                  isActive && "font-semibold"
                )}
              >
                <Icon icon={option.icon} size="sm" />
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
