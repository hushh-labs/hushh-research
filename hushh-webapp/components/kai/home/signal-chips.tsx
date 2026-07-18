"use client";

import { Card, CardContent } from "@/lib/morphy-ux/card";
import type { KaiHomeSignal } from "@/lib/services/api-service";

interface SignalChipsProps {
  signals: KaiHomeSignal[];
  selectedSignalId?: string | null;
  onSignalSelect?: (signal: KaiHomeSignal) => void;
}

export function SignalChips({
  signals,
  selectedSignalId,
  onSignalSelect,
}: SignalChipsProps) {
  if (!signals.length) {
    return (
      <Card variant="muted" effect="fill" preset="compact">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Signals are unavailable right now.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {signals.map((signal) => {
        const selected = selectedSignalId === signal.id;
        const selectable = selectedSignalId !== undefined || Boolean(onSignalSelect);
        const content = (
          <>
            <span className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold tracking-tight">{signal.title}</span>
              <span className="rounded-full bg-background/70 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {(signal.confidence * 100).toFixed(0)}%
              </span>
            </span>
            <span className="block text-xs leading-relaxed text-muted-foreground">
              {signal.summary}
            </span>
          </>
        );

        return (
          <Card key={signal.id} variant="none" effect="glass" preset="compact">
            <CardContent className={selectable ? "p-0" : "space-y-2 p-3"}>
              {selectable ? (
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSignalSelect?.(signal)}
                  className="w-full space-y-2 rounded-[inherit] p-3 text-left"
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
