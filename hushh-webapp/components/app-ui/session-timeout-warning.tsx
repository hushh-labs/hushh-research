"use client";

import * as React from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface SessionTimeoutWarningProps extends React.HTMLAttributes<HTMLDivElement> {
  onLogout: () => void;
  onExtendSession: () => void;
  countdownSeconds?: number;
}

/**
 * Accessible Session Timeout Warning
 * Displays a critical, accessible countdown before automatically logging a user out.
 * Essential for SOC2/Financial compliance without frustrating active users.
 */
export function SessionTimeoutWarning({
  onLogout,
  onExtendSession,
  countdownSeconds = 60,
  className,
  ...props
}: SessionTimeoutWarningProps) {
  const [timeLeft, setTimeLeft] = React.useState(countdownSeconds);

  React.useEffect(() => {
    if (timeLeft <= 0) {
      onLogout();
      return;
    }

    const timer = setInterval(() => {
      setTimeLeft((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [timeLeft, onLogout]);

  // Format seconds into M:SS for visual polish
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-warning-title"
      aria-describedby="session-warning-desc"
      className={cn(
        "fixed bottom-6 right-6 z-[100] flex w-[340px] flex-col gap-4 rounded-xl border border-border/50 bg-background p-5 shadow-2xl",
        "animate-in slide-in-from-bottom-8 fade-in duration-300",
        className
      )}
      {...props}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1">
          <h3 id="session-warning-title" className="text-base font-semibold tracking-tight text-foreground">
            Session Expiring Soon
          </h3>
          <p id="session-warning-desc" className="text-sm text-muted-foreground leading-snug">
            For your security, you will be logged out automatically due to inactivity.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="tabular-nums">{formatTime(timeLeft)}</span>
        </div>
        
        {/* A11y: Screen readers need to know time is running out, but we don't want to spam them every second. 
            We announce at specific critical thresholds. */}
        <span className="sr-only" aria-live="polite">
          {timeLeft === countdownSeconds ? `Warning: Session expires in ${countdownSeconds} seconds.` : ""}
          {timeLeft === 30 ? "Session expires in 30 seconds." : ""}
          {timeLeft === 10 ? "Session expires in 10 seconds." : ""}
        </span>
      </div>

      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={onLogout}
          className="flex-1 rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Log out now
        </button>
        <button
          type="button"
          onClick={onExtendSession}
          className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Stay signed in
        </button>
      </div>
    </div>
  );
}