"use client";

import * as React from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface PasswordStrengthMeterProps extends React.HTMLAttributes<HTMLDivElement> {
  password?: string;
}

/**
 * Accessible Password Strength Meter
 * Provides real-time visual and screen-reader feedback for password complexity.
 * Essential for Hushh's security-first onboarding flows.
 */
export function PasswordStrengthMeter({
  password = "",
  className,
  ...props
}: PasswordStrengthMeterProps) {
  // Evaluation Logic
  const hasMinLength = password.length >= 8;
  const hasNumber = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  const hasUpperCase = /[A-Z]/.test(password);

  const score = [hasMinLength, hasNumber, hasSpecialChar, hasUpperCase].filter(Boolean).length;

  const strengthLabels = ["Very Weak", "Weak", "Fair", "Good", "Strong"];
  const currentLabel = strengthLabels[score];

  // Visual mapping for the progress bar
  const strengthColors = [
    "bg-muted", // 0
    "bg-destructive", // 1
    "bg-orange-500", // 2
    "bg-amber-500", // 3
    "bg-emerald-500", // 4
  ];

  const RequirementItem = ({ met, text }: { met: boolean; text: string }) => (
    <div className={cn("flex items-center gap-2 text-xs transition-colors duration-300", met ? "text-emerald-500" : "text-muted-foreground")}>
      {met ? <Check className="size-3.5" aria-hidden="true" /> : <X className="size-3.5" aria-hidden="true" />}
      <span>{text}</span>
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-3 w-full", className)} {...props}>
      
      {/* Visual Progress Bar */}
      <div className="flex items-center gap-1 h-1.5 w-full rounded-full overflow-hidden bg-muted/30" aria-hidden="true">
        {[1, 2, 3, 4].map((level) => (
          <div
            key={level}
            className={cn(
              "h-full w-1/4 transition-colors duration-500",
              score >= level ? strengthColors[score] : "bg-transparent"
            )}
          />
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground tracking-tight">
          {password.length === 0 ? "Enter a password" : currentLabel}
        </span>
        
        {/* A11y: Screen reader live region explicitly announces strength changes */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {password.length === 0 ? "Awaiting password input." : `Password strength is currently ${currentLabel}.`}
        </span>
      </div>

      {/* Requirements Checklist */}
      <div className="grid grid-cols-2 gap-2 mt-1">
        <RequirementItem met={hasMinLength} text="8+ characters" />
        <RequirementItem met={hasUpperCase} text="Uppercase letter" />
        <RequirementItem met={hasNumber} text="At least 1 number" />
        <RequirementItem met={hasSpecialChar} text="Special character" />
      </div>
    </div>
  );
}