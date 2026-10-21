"use client";

import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";

/** Compatibility entrypoint for the Market stock summary. */
export function RenaissanceVerdictCard({ row }: { row: KaiHomeRenaissanceItem }) {
  const businessSummary = row.company_facts?.summary?.trim();
  const listSummary = row.investment_thesis?.trim();
  return (
    <section className="space-y-2 border-t border-[color:var(--app-card-border-standard)] pt-4">
      <h3 className="text-sm font-semibold text-foreground">Summary</h3>
      <p className="text-sm leading-6 text-foreground/80">
        {businessSummary || listSummary || "A company summary is unavailable right now."}
      </p>
      {businessSummary && listSummary ? (
        <div className="pt-3 text-sm leading-6 text-muted-foreground">
          <p className="font-medium text-foreground">List thesis</p>
          <p className="pt-1">{listSummary}</p>
        </div>
      ) : null}
      {!businessSummary && listSummary ? (
        <p className="text-xs text-muted-foreground">Summary from the selected list.</p>
      ) : null}
    </section>
  );
}
