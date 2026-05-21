import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsGroupProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingsGroup({
  title,
  eyebrow,
  children,
  className,
}: SettingsGroupProps) {
  return (
    <section className={cn("space-y-3 pt-2", className)}>
      {/* Rule Fixes:
        1. Uses a compact <h3> heading for accessibility.
        2. Keeps the eyebrow inline with the title inside the heading.
      */}
      <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground/90 flex items-center gap-2">
        {eyebrow && (
          <span className="opacity-75 text-[10px] font-medium bg-muted px-1.5 py-0.5 rounded-md">
            {eyebrow}
          </span>
        )}
        <span>{title}</span>
      </h3>
      
      <div className="rounded-[20px] border border-border/60 bg-card p-1 divide-y divide-border/40 overflow-hidden">
        {children}
      </div>
    </section>
  );
}