"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// ... [Keep your SettingsGroup and SettingsRow definitions as they were] ...

// Add these explicit type exports so they can be imported correctly
export function SettingsDetailPanel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

export function SettingsSegmentedTabs({ 
  options, 
  value, 
  onChange 
}: { 
  options: { id: string; label: string }[]; 
  value: string; 
  onChange: (v: string) => void 
}) {
  return (
    <div className="flex bg-muted p-1 rounded-lg">
      {options.map((opt) => (
        <button 
          key={opt.id} 
          onClick={() => onChange(opt.id)} 
          className={cn("px-3 py-1 text-xs rounded", value === opt.id && "bg-background shadow-sm")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}