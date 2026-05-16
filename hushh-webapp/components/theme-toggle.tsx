"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({
  className = "",
}: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();

  return (
    <button
      onClick={() =>
        setTheme(theme === "dark" ? "light" : "dark")
      }
      className={`
        p-2
        rounded-lg
        border
        border-zinc-300
        dark:border-zinc-700
        bg-white
        dark:bg-zinc-900
        transition-all
        duration-300
        ${className}
      `}
      aria-label="Toggle Theme"
    >
      {theme === "dark" ? (
        <Sun size={18} />
      ) : (
        <Moon size={18} />
      )}
    </button>
  );
}

export function ThemeToggleCompact({
  className = "",
}: ThemeToggleProps) {
  return <ThemeToggle className={className} />;
}