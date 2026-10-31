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
  voiceControlId?: string;
};

export function AuthProviderButton({
  label,
  icon,
  disabled = false,
  onClick,
  className,
  voiceControlId,
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
      data-voice-control-id={voiceControlId}
      className={cn(
        "type-headline min-h-[60px] rounded-[var(--app-radius-lg)] border border-black/[0.03] bg-white/[0.72] text-[#1d1d1f] shadow-none [backdrop-filter:blur(12px)] transition-[background] hover:bg-white dark:border-white/[0.04] dark:bg-[#1c1c1e] dark:text-[#f5f5f7] dark:hover:bg-[#26262a]",
        className
      )}
    >
      <span data-auth-provider-content className="inline-flex max-w-full items-center justify-center gap-3">
        {icon ? <span data-auth-provider-icon aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center">{icon}</span> : null}
        <span className="min-w-0">{label}</span>
      </span>
    </Button>
  );
}
