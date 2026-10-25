"use client";

import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";
import { SectionLabel } from "@/components/app-ui/typography";

/** Compatibility entrypoint for the Market stock summary. */
export function RenaissanceVerdictCard({ row }: { row: KaiHomeRenaissanceItem }) {
  const businessSummary = row.company_facts?.summary?.trim();
  const listSummary = row.investment_thesis?.trim();
  // Excerpts retain the provider's order and wording; this is not an assessment.
  const excerpts = businessSummary ? Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(businessSummary))
    .slice(0, 2).map(({ segment }) => segment.trim()).map(text => text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text) : [];
  return (
    <section className="space-y-2 border-t border-[color:var(--app-card-border-standard)] pt-4">
      <SectionLabel role="heading" aria-level={3}>Company summary</SectionLabel>
      {businessSummary ? <>
        <ul className="list-disc space-y-2 pl-4 text-sm leading-6 text-foreground/80">
          {excerpts.map((text, index) => <li key={index}>{text}</li>)}
        </ul>
        <details className="text-sm leading-6 text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-3 font-medium text-foreground">Full company profile</summary>
          <p className="pt-1">{businessSummary}</p>
        </details>
        <p className="text-xs text-muted-foreground">Excerpts from the provider’s company profile.</p>
      </> : <p className="text-sm leading-6 text-foreground/80">{listSummary || "A company summary is unavailable right now."}</p>}
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
