"use client";

import { Card, CardContent } from "@/lib/morphy-ux/card";
import type { KaiHomeSignal } from "@/lib/services/api-service";

interface SignalChipsProps {
  signals: KaiHomeSignal[];
}

export function SignalChips({ signals }: SignalChipsProps) {
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
      {signals.map((signal) => (
        <Card key={signal.id} variant="none" effect="glass" preset="compact">
          <CardContent className="space-y-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold tracking-tight">{signal.title}</p>
              <span className="rounded-full bg-background/70 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {(signal.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{signal.summary}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
