"use client";

/**
 * Why this score, in the order the score itself was built.
 *
 * The number arrived with four sentences of prose and no arithmetic, so a
 * strong profile and a merely well-evidenced one looked identical. Everything
 * here is published by the scoring service — the weights especially. Restating
 * them in the app would leave a confident, wrong explanation behind the first
 * time the model is re-weighted.
 */

import { MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import type { ScoreBreakdown } from "@/lib/services/nws-nearby-service";
import { cn } from "@/lib/utils";

function pct(value: number | null): string {
  return typeof value === "number" ? `${Math.round(value * 100)}` : "—";
}

export function NearbyScoreExplainer({ breakdown }: { breakdown: ScoreBreakdown }) {
  const components = breakdown.components.filter((c) => typeof c.value === "number");
  if (components.length === 0) return null;

  const strongest = Math.max(...components.map((c) => c.contribution ?? 0), 0.0001);
  const penalty = breakdown.integrityPenalty ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {components.map((component) => (
          <div key={component.key} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate type-footnote">{component.label}</span>
            {/* Bar length is the contribution, not the raw value — a strong
                score on a 5%-weighted component should not look decisive. */}
            <span
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--app-card-surface-compact)]"
              aria-hidden
            >
              <span
                className="block h-full rounded-full bg-[color:var(--app-accent)]"
                style={{
                  width: `${Math.max(2, ((component.contribution ?? 0) / strongest) * 100)}%`,
                }}
              />
            </span>
            <span className={cn(MUTED_TEXT, "w-16 shrink-0 text-right tabular-nums")}>
              {pct(component.value)} · {pct(component.weight)}%
            </span>
          </div>
        ))}
      </div>

      <p className={MUTED_TEXT}>Score · weight of the total</p>

      <div className={cn(SUBCARD_SURFACE, "flex flex-col gap-1 p-3")}>
        {typeof breakdown.evidenceCount === "number" ? (
          <Line label="Evidence" value={`${breakdown.evidenceCount} sources`} />
        ) : null}
        {typeof breakdown.coverageMultiplier === "number" ? (
          <Line
            label="Coverage"
            value={`×${breakdown.coverageMultiplier.toFixed(2)}`}
            note={
              breakdown.coverageMultiplier < 0.99
                ? "held back on thin evidence"
                : "fully corroborated"
            }
          />
        ) : null}
        {penalty > 0 ? (
          <Line
            label="Integrity"
            value={`−${Math.round(penalty * 100)}%`}
            note="self-published or single-source evidence"
          />
        ) : null}
        {typeof breakdown.localRelevance === "number" ? (
          <Line
            label="This place"
            value={pct(breakdown.localRelevance)}
            note="10% of the nearby rank"
          />
        ) : null}
      </div>

      {breakdown.method ? <p className={MUTED_TEXT}>{breakdown.method}</p> : null}
    </div>
  );
}

function Line({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="type-footnote">{label}</span>
      <span className="flex items-baseline gap-2 text-right">
        {note ? <span className={MUTED_TEXT}>{note}</span> : null}
        <span className="type-footnote tabular-nums">{value}</span>
      </span>
    </div>
  );
}
