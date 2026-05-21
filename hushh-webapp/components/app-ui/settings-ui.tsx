"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// =============================================================================
// INTERFACE DEFINITIONS
// =============================================================================

export interface SettingsGroupProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
}

export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

// =============================================================================
// 1. SETTINGS GROUP COMPONENT (Fixed to resolve structural gate failures)
// =============================================================================

export function SettingsGroup({
  title,
  eyebrow,
  children,
  className,
}: SettingsGroupProps) {
  return (
    <section className={cn("space-y-3 py-2", className)}>
      {/* CRITICAL ARCHITECTURE FIXES:
        - Rendered via a semantic <h3> heading tag to satisfy the accessible compact heading rule.
        - Flexbox aligns the eyebrow tag inline with the title text on the exact same row.
      */}
      <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80 flex items-center gap-2 select-none">
        {eyebrow && (
          <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-muted/80 border border-border/40 text-muted-foreground/90 normal-case tracking-normal">
            {eyebrow}
          </span>
        )}
        <span>{title}</span>
      </h3>
      
      {/* Container encapsulating multi-row line selections */}
      <div className="rounded-[20px] border border-border/60 bg-card p-1 divide-y divide-border/40 overflow-hidden shadow-sm">
        {children}
      </div>
    </section>
  );
}

// =============================================================================
// 2. SETTINGS ROW COMPONENT
// =============================================================================

export function SettingsRow({
  label,
  description,
  action,
  className,
}: SettingsRowProps) {
  return (
    <div 
      className={cn(
        "flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-muted/5",
        className
      )}
    >
      <div className="space-y-0.5 min-w-0 flex-1">
        <p className="text-sm font-semibold tracking-tight text-foreground">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground leading-relaxed max-w-2xl">{description}</p>
        )}
      </div>
      
      {action && (
        <div className="flex items-center shrink-0 self-start sm:self-auto min-h-8">
          {action}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// 3. SETTINGS DETAIL PANEL COMPONENT
// =============================================================================

export function SettingsDetailPanel({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-4 p-1", className)}>
      <div className="border-b border-border/40 pb-3">
        <h4 className="text-sm font-bold tracking-tight text-foreground">{title}</h4>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div className="text-sm text-foreground/90 leading-relaxed">{children}</div>
    </div>
  );
}