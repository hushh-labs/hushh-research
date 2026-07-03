"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldAlert, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { OneLocationRecipient } from "@/lib/one-location/types";

export type SosPanelProps = {
  recipients: OneLocationRecipient[];
  active: boolean;
  busy: boolean;
  startedAtLabel: string | null;
  onTrigger: () => void;
  onStop: () => void;
  recipientLabel: (r: OneLocationRecipient) => string;
  isRecipientShareReady: (r: OneLocationRecipient) => boolean;
  countdownSeconds?: number;
};

function initialOf(label: string): string {
  const trimmed = label.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "?";
}

/**
 * SOS panic panel for the Location Now tab. Idle: a red "TAP TO PANIC" button
 * that arms a short countdown (cancellable) before firing. Active: a
 * "LIVE LOCATION ACTIVE" banner with an "I'm safe" stop. Always shows the
 * read-only "WHO GETS ALERTED?" list. Reuses the destructive palette.
 */
export function SosPanel({
  recipients,
  active,
  busy,
  startedAtLabel,
  onTrigger,
  onStop,
  recipientLabel,
  isRecipientShareReady,
  countdownSeconds = 5,
}: SosPanelProps) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => stopTimer, []);

  const startCountdown = () => {
    if (busy || active) return;
    setRemaining(countdownSeconds);
    stopTimer();
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          stopTimer();
          setRemaining(null);
          onTrigger();
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const cancelCountdown = () => {
    stopTimer();
    setRemaining(null);
  };

  const readyCount = recipients.filter(isRecipientShareReady).length;

  return (
    <section className="app-critical-card space-y-4 rounded-2xl p-4">
      <header className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-foreground">SOS</h2>
          <p className="text-xs text-muted-foreground">
            Alert trusted contacts + share live location
          </p>
        </div>
      </header>

      {active ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
            </span>
            LIVE LOCATION ACTIVE
            {startedAtLabel ? (
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                since {startedAtLabel}
              </span>
            ) : null}
          </div>
          <Button
            variant="destructive"
            onClick={onStop}
            isLoading={busy}
            className="h-12 w-full rounded-2xl text-base font-semibold"
          >
            I&apos;m safe — Stop sharing
          </Button>
        </div>
      ) : remaining !== null ? (
        <div className="space-y-3 text-center">
          <p className="text-sm font-medium text-destructive">
            Alerting all trusted contacts in
          </p>
          <p className="text-5xl font-bold text-destructive" aria-live="assertive">
            {remaining}
          </p>
          <Button
            variant="outline"
            onClick={cancelCountdown}
            className="h-12 w-full rounded-2xl text-base font-semibold"
          >
            <X className="mr-1.5 h-4 w-4" aria-hidden />
            Cancel
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-destructive">
            Emergency alert
          </p>
          <Button
            variant="destructive"
            onClick={startCountdown}
            disabled={busy || readyCount === 0}
            className="h-28 w-full rounded-2xl text-2xl font-bold"
          >
            TAP TO PANIC
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            One tap alerts all trusted contacts + shares your live location
          </p>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Who gets alerted?
        </p>
        {recipients.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trusted contacts yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {recipients.map((r) => {
              const ready = isRecipientShareReady(r);
              return (
                <li
                  key={r.userId}
                  className="flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-2"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10 text-sm font-semibold text-destructive">
                    {initialOf(recipientLabel(r))}
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {recipientLabel(r)}
                  </span>
                  {ready ? (
                    <span
                      className="ml-auto h-2 w-2 rounded-full bg-emerald-500"
                      aria-label="Ready"
                    />
                  ) : (
                    <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <TriangleAlert className="h-3 w-3" aria-hidden />
                      Not ready
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
