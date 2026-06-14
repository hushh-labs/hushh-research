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
        "text-[17px] font-medium border border-border/70 bg-background/80 dark:bg-background/55",
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
