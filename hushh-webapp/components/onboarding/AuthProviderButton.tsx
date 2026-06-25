"use client";

import * as React from "react";

import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

type AuthProviderButtonProps = {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void | Promise<void>;
  className?: string;
};

export function AuthProviderButton({
  label,
  icon,
  disabled = false,
  onClick,
  className,
}: AuthProviderButtonProps) {
  return (
    <Button
      type="button"
      variant="none"
      effect="fade"
      size="lg"
      fullWidth
      showRipple={!disabled}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "type-headline min-h-[52px] rounded-full border-0 bg-black/[0.05] text-[#1d1d1f] shadow-none [backdrop-filter:none] transition-[background,transform] hover:bg-black/[0.08] active:translate-y-px dark:bg-white/[0.07] dark:text-[#f5f5f7] dark:hover:bg-white/[0.10]",
        className
      )}
    >
      <span className="inline-flex items-center gap-3">
        {icon}
        <span>{label}</span>
      </span>
    </Button>
  );
}
