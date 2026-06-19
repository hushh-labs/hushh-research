"use client";

import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";

import { cn } from "@/lib/utils";

type PrivacyToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
};

export function PrivacyToggle({
  checked,
  onCheckedChange,
  ariaLabel,
  disabled = false,
  className,
}: PrivacyToggleProps) {
  function toggle() {
    if (disabled) return;
    onCheckedChange(!checked);
  }

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    toggle();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    toggle();
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }

  return (
    <button
      type="button"
      role="switch"
      tabIndex={disabled ? -1 : 0}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input dark:bg-input/80",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "block size-4 rounded-full bg-background ring-0 transition-transform dark:bg-foreground",
          checked && "translate-x-4 dark:bg-primary-foreground"
        )}
      />
    </button>
  );
}
