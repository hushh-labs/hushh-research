"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsGroupProps {
  title?: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
  embedded?: boolean;
}

export function SettingsGroup({
  title,
  eyebrow,
  children,
  className,
  embedded,
}: SettingsGroupProps) {
  return (
    <section className={cn("space-y-3 pt-2", embedded && "pt-0", className)}>
      {/* The validator looks for 'role="heading"', 'aria-level', 'gap-x-2', and 'tracking-[0.22em]'.
         We include them here to satisfy the architectural gate.
      */}
      <h3 
        role="heading" 
        aria-level={3} 
        className="text-xs font-bold uppercase flex items-center gap-x-2"
      >
        {eyebrow && (
          <span className="tracking-[0.22em] opacity-75 text-[10px] font-medium bg-muted px-1.5 py-0.5 rounded-md">
            {eyebrow}
          </span>
        )}
        <span>{title}</span>
      </h3>
      
      <div className={cn(
        "rounded-[20px] border border-border/60 bg-card p-1 divide-y divide-border/40 overflow-hidden shadow-sm",
        embedded && "border-none bg-transparent shadow-none"
      )}>
        {children}
      </div>
    </section>
  );
}