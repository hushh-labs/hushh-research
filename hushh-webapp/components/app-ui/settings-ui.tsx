"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsGroupProps {
  title?: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
  embedded?: boolean;
  description?: ReactNode;
  trailing?: ReactNode;
  [key: string]: any;
}

// Ensure the "export" keyword is here
export function SettingsGroup({
  title,
  eyebrow,
  children,
  className,
  embedded,
  description,
  trailing,
  ...props
}: SettingsGroupProps) {
  return (
    <section className={cn("space-y-3 pt-2", embedded && "pt-0", className)} {...props}>
      <h3 role="heading" aria-level={3} className="text-xs font-bold uppercase flex items-center gap-x-2">
        {eyebrow && (
          <span className="tracking-[0.22em] opacity-75 text-[10px] font-medium bg-muted px-1.5 py-0.5 rounded-md">
            {eyebrow}
          </span>
        )}
        <span>{title}</span>
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

// Ensure the "export" keyword is here
export function SettingsRow({ 
  title, 
  description,
  icon,
  trailing,
  chevron,
  onClick,
  ...props
}: { 
  title: ReactNode; 
  description?: ReactNode;
  icon?: any;
  trailing?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  [key: string]: any;
}) {
  return (
    <div 
      className={cn("px-4 py-3 text-sm flex items-center gap-3", onClick && "cursor-pointer hover:bg-muted/50")}
      onClick={onClick}
      {...props}
    >
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <div className="flex-1">
        <div className="font-medium text-foreground">{title}</div>
        {description && <div className="text-muted-foreground">{description}</div>}
      </div>
      {trailing && <div>{trailing}</div>}
      {chevron && <div className="text-muted-foreground">›</div>}
    </div>
  );
}