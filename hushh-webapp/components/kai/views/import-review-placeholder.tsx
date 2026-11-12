"use client";

import { formatCurrency } from "@/lib/kai/market-value-format";
import type { LiveHoldingPreview } from "@/lib/kai/import/live-holdings-preview";
import { cn } from "@/lib/utils";

const MAX_LIVE_ROWS = 8;

function Bar({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block rounded bg-muted motion-safe:animate-pulse", className)} />;
}

const card = "rounded-[var(--app-card-radius-standard)] bg-[var(--app-card-surface-default)] p-4 sm:p-5";

/**
 * The review screen's own layout, drawn while a statement is still being read: real labels,
 * placeholder values. Holdings the server has confirmed take the place of placeholder rows as
 * they arrive; everything else stays a placeholder until the review opens.
 */
export function ImportReviewPlaceholder({ rows = [], total = null }: { rows?: readonly LiveHoldingPreview[]; total?: number | null }) {
  const shown = rows.slice(0, MAX_LIVE_ROWS);
  const known = typeof total === "number" && total > 0 ? total : null;
  const placeholderRows = shown.length === 0 ? 4 : known === null ? 2 : Math.max(0, Math.min(2, known - shown.length));
  return (
    <div aria-busy="true" className="space-y-3">
      <section className={cn(card, "space-y-3")}>
        <h2 className="ui-text-section-label">Review holdings</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          {[
            ["Portfolio value", null],
            ["Positions", known],
            ["Cash", null],
            ["Portfolio risk", null],
          ].map(([label, value]) => (
            <div key={String(label)} className="min-w-0">
              <dt className="ui-text-row-description text-muted-foreground">{label}</dt>
              <dd className="mt-1 min-h-5 ui-text-row-label-emphasized tabular-nums">
                {typeof value === "number" ? value : <Bar className="mt-1 h-3.5 w-16" />}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={cn(card, "space-y-3")}>
        <h2 className="ui-text-section-label">Account information</h2>
        <Bar className="h-3 w-4/5" />
        <Bar className="h-3 w-1/2" />
      </section>
      <section className={card}>
        <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-3 border-b border-border/60 pb-2 ui-text-row-description text-muted-foreground">
          <span>Holding</span>
          <span>Shares</span>
          <span className="text-right">Market value</span>
        </div>
        <ul aria-label={shown.length ? "Holdings found so far" : undefined}>
          {shown.map((row, index) => (
            <li key={`${row.symbol ?? "row"}-${index}`} className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-3 border-t border-border/50 py-2 first:border-t-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
              <span className="min-w-0">
                <span className="block truncate ui-text-row-label-emphasized">{row.symbol || row.name || "Holding"}</span>
                {row.symbol && row.name ? <span className="block truncate ui-text-row-description text-muted-foreground">{row.name}</span> : null}
              </span>
              <span className="ui-text-row-description tabular-nums text-muted-foreground">
                {typeof row.quantity === "number" ? row.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}
              </span>
              <span className="text-right ui-text-row-label tabular-nums">
                {typeof row.market_value === "number" ? formatCurrency(row.market_value, "USD") : "—"}
              </span>
            </li>
          ))}
          {Array.from({ length: placeholderRows }, (_, slot) => (
            <li key={`placeholder-${slot}`} aria-hidden="true" className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-3 border-t border-border/50 py-2.5 first:border-t-0">
              <span className="space-y-1.5"><Bar className="h-3 w-12" /><Bar className="h-2.5 w-24" /></span>
              <Bar className="h-3 w-14" />
              <Bar className="h-3 w-16 justify-self-end" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
