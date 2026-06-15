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
      effect="glass"
      size="lg"
      fullWidth
      showRipple={!disabled}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "min-h-14 rounded-full border border-black/[0.08] bg-[#f5f5f7] text-[16px] font-semibold text-[#1d1d1f] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[background,border-color,box-shadow,transform] hover:border-black/[0.12] hover:bg-white hover:shadow-[0_8px_28px_rgba(0,0,0,0.08)] active:translate-y-px dark:border-white/[0.12] dark:bg-white/[0.10] dark:text-[#f5f5f7] dark:hover:border-white/[0.18] dark:hover:bg-white/[0.14]",
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
