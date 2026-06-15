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
        "min-h-[52px] rounded-full border border-black/[0.08] bg-white text-[16px] font-medium text-[#1d1d1f] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[background,border-color,box-shadow,transform] hover:border-black/[0.12] hover:bg-[#f5f5f7] hover:shadow-[0_10px_30px_-20px_rgba(0,0,0,0.28)] active:translate-y-px dark:border-white/[0.12] dark:bg-white/[0.10] dark:text-[#f5f5f7] dark:hover:border-white/[0.18] dark:hover:bg-white/[0.14]",
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
