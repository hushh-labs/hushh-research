"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/utils"; // Ensure this path is correct for your project

export interface SettingsGroupProps {
  title?: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
  embedded?: boolean;
  description?: ReactNode;
  trailing?: ReactNode;
}

export function SettingsGroup({
  title,
  eyebrow,
  children,
  className,
  embedded,
  description,
  trailing,
}: SettingsGroupProps) {
  return (
    <section className={cn("space-y-3 pt-2", embedded && "pt-0", className)}>
      <h3 role="heading" aria-level={3} className="text-xs font-bold uppercase flex items-center gap-x-2">
        {eyebrow && (
          <span className="tracking-[0.22em] opacity-75 text-[10px] font-medium bg-muted px-1.5 py-0.5 rounded-md">
            {eyebrow}
          </span>
        )}
        <span>{title}</span>
        {trailing && <span className="ml-auto">{trailing}</span>}
      </h3>
      
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      
      <div className={cn(
        "rounded-[20px] border border-border/60 bg-card p-1 divide-y divide-border/40 overflow-hidden shadow-sm",
        embedded && "border-none bg-transparent shadow-none"
      )}>
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({ 
  title, 
  description 
}: { 
  title: ReactNode; 
  description?: ReactNode 
}) {
  return (
    <div className="px-4 py-3 text-sm">
      <div className="font-medium text-foreground">{title}</div>
      {description && <div className="text-muted-foreground">{description}</div>}
    </div>
  );
}