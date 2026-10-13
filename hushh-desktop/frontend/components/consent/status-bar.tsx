// components/consent/status-bar.tsx

/**
 * Consent Status Bar Component
 *
 * Displays active session and delegated scopes in the dashboard.
 * Shows real-time consent status with proper mobile responsiveness.
 */

"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Shield, Clock, ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/lib/morphy-ux/morphy";
import { Icon } from "@/lib/morphy-ux/ui";

interface ConsentStatusBarProps {
  className?: string;
}

interface SessionInfo {
  isActive: boolean;
  expiresAt: number | null;
  token: string | null;
}

export function ConsentStatusBar({ className = "" }: ConsentStatusBarProps) {
  const [session, setSession] = useState<SessionInfo>({
    isActive: false,
    expiresAt: null,
    token: null,
  });
  const [isOpen, setIsOpen] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<string>("");

  // Session token/expiry are no longer stored in sessionStorage (orphaned reads removed).
  // This component now only renders when session data is provided externally.
  // Since no writer exists, session will always be the initial empty state,
  // and the component will return null below.

  useEffect(() => {
    // Update time remaining every minute
    if (!session.expiresAt) return;

    const updateTimeRemaining = () => {
      const now = Date.now();
      const remaining = session.expiresAt! - now;

      if (remaining <= 0) {
        setTimeRemaining("Expired");
        setSession((prev) => ({ ...prev, isActive: false }));
        return;
      }

      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

      if (hours > 0) {
        setTimeRemaining(`${hours}h ${minutes}m`);
      } else {
        setTimeRemaining(`${minutes}m`);
      }
    };

    updateTimeRemaining();
    const interval = setInterval(updateTimeRemaining, 60000);
    return () => clearInterval(interval);
  }, [session.expiresAt]);

  if (!session.token) {
    return null; // Don't show if no session
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 bg-muted/30 rounded-lg border border-border/50 ${className}`}
    >
      {/* Session Status Badge */}
      <Badge
        variant={session.isActive ? "default" : "outline"}
        className={`flex items-center gap-1.5 text-xs ${session.isActive ? "" : "app-critical-badge"}`}
      >
        <Icon icon={Shield} size={12} />
        <span className="hidden sm:inline">
          {session.isActive ? "Session Active" : "Session Expired"}
        </span>
        <span className="sm:hidden">
          {session.isActive ? "Active" : "Expired"}
        </span>
      </Badge>

      {/* Time Remaining */}
      {session.isActive && timeRemaining && (
        <Badge variant="outline" className="flex items-center gap-1 text-xs">
          <Icon icon={Clock} size={12} />
          <span className="hidden sm:inline">{timeRemaining}</span>
          <span className="sm:hidden">{timeRemaining}</span>
        </Badge>
      )}

      {/* Expandable Details (Desktop) */}
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className="hidden md:block"
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="none"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
          >
            Details
            <Icon
              icon={ChevronDown}
              size={12}
              className={`ml-1 transition-transform ${isOpen ? "rotate-180" : ""}`}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="absolute mt-2 p-3 bg-popover border rounded-lg shadow-lg z-50 min-w-[200px]">
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Scope:</span>
              <span className="font-mono">vault.owner</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Expires:</span>
              <span>
                {session.expiresAt
                  ? new Date(session.expiresAt).toLocaleTimeString()
                  : "N/A"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Token:</span>
              <span className="font-mono truncate max-w-[100px]">
                {session.token?.slice(0, 12)}...
              </span>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
