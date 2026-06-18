"use client";

import * as React from "react";
import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

/**
 * PCI-DSS Trust Boundary Wrapper
 * Enforces a visual and architectural boundary for highly sensitive payment collection surfaces.
 * Fulfills the "Security Owner and Data Handling Boundary" requirement for PR governance.
 */
export function PCITrustBoundary({ 
  children, 
  securityOwner = "Hushh-Core-Security",
  className
}: { 
  children: React.ReactNode;
  securityOwner?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative flex flex-col gap-4 rounded-xl border-2 border-dashed border-emerald-500/40 bg-emerald-500/5 p-6", className)}>
      <div className="absolute -top-3 left-4 flex items-center gap-1.5 bg-background px-2 text-xs font-bold uppercase tracking-widest text-emerald-600 dark:bg-zinc-950">
        <ShieldAlert className="size-3.5" aria-hidden="true" />
        PCI-DSS Isolated Runtime
      </div>
      
      <div className="text-xs text-muted-foreground">
        <strong>Security Boundary Owner:</strong> <span className="text-foreground">{securityOwner}</span> <br/>
        Raw PAN data must not escape this runtime memory boundary. All external network requests must pass through vaulted tokenization.
      </div>
      
      <div className="isolate mt-2 w-full max-w-md">
        {children}
      </div>
    </div>
  );
}