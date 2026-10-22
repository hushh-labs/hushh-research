"use client";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { HelperText, RowLabel, SectionTitle, TrailingValue } from "@/components/app-ui/typography";
import { summarizeRecentReceiptRows, type RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";

/** Counts, never mixed-currency spend or inferred financial performance. */
export function ReceiptCollectionOverview({ rows }: { rows: readonly RecentReceiptRow[] }) {
  const active = rows.filter(row => !row.archived);
  const summary = summarizeRecentReceiptRows(active);
  const categories = new Map<string, number>();
  active.forEach(row => {
    const category = !row.category || row.category === "Other" ? "Uncategorized" : row.category;
    categories.set(category, (categories.get(category) ?? 0) + 1);
  });
  const ranked = [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return (
    <div className="grid gap-4 md:grid-cols-2" data-no-auto-fade="true" data-testid="receipt-collection-overview">
      <SurfaceCard className="h-64">
        <SurfaceCardContent className="h-full space-y-5 overflow-y-auto p-5">
          <SectionTitle as="h3">Overview</SectionTitle>
          <div>
            <HelperText className="text-muted-foreground">Saved receipts</HelperText>
            <p className="ui-text-large-page-title tabular-nums" data-testid="receipt-saved-count">{active.length}</p>
          </div>
          <dl className="grid grid-cols-3 gap-3">
            {[["Paid", summary.paid], ["Needs attention", summary.attention], ["Coming up", summary.upcoming]].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <HelperText as="dt" className="text-muted-foreground">{label}</HelperText>
                <TrailingValue as="dd" className="mt-1 block tabular-nums">{value}</TrailingValue>
              </div>
            ))}
          </dl>
          <HelperText as="p" className="text-muted-foreground">From your saved Mail sample.</HelperText>
          {rows.length !== active.length ? <HelperText as="p" className="text-muted-foreground">Previously saved receipts remain below; unresolved archive entries are excluded from these counts.</HelperText> : null}
        </SurfaceCardContent>
      </SurfaceCard>
      <SurfaceCard className="h-64">
        <SurfaceCardContent className="h-full space-y-4 overflow-y-auto p-5">
          <SectionTitle as="h3">Categories</SectionTitle>
          <ul className="space-y-3" aria-label="Categories by saved receipt count">
            {ranked.map(([category, count], index) => (
              <li key={category} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <RowLabel>{category}</RowLabel>
                  <HelperText className="whitespace-nowrap tabular-nums text-muted-foreground">{count} · {Math.round(count / active.length * 100)}%</HelperText>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--app-neutral-fill)]" aria-hidden="true">
                  <div className="h-full origin-left rounded-full" style={{ backgroundColor: `var(--chart-${index % 5 + 1})`, transform: `scaleX(${count / active.length})` }} />
                </div>
              </li>
            ))}
          </ul>
          {!active.length ? <HelperText as="p" className="text-muted-foreground">Categories appear as receipts arrive.</HelperText> : null}
        </SurfaceCardContent>
      </SurfaceCard>
    </div>
  );
}
