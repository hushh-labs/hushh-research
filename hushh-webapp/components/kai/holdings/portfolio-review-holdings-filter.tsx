"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";

export type ReviewHoldingsFilter = "all" | "analyze" | "non-analyze" | "cash";

const options: { value: ReviewHoldingsFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "analyze", label: "Equity" },
  { value: "non-analyze", label: "Other" },
  { value: "cash", label: "Cash" },
];

export function PortfolioReviewHoldingsFilter({ value, onChange }: {
  value: ReviewHoldingsFilter;
  onChange: (value: ReviewHoldingsFilter) => void;
}) {
  const select = (next: string) => {
    const option = options.find(({ value }) => value === next);
    if (option) onChange(option.value);
  };

  return (
    <>
      <Select value={value} onValueChange={select}>
        <SelectTrigger aria-label="Filter holdings" className="min-h-11 w-full ui-text-row-label md:hidden">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="app-type-compact rounded-[var(--app-card-radius-compact)]">
          {options.map(({ value, label }) => <SelectItem key={value} value={value} className="ui-text-row-label">{label}</SelectItem>)}
        </SelectContent>
      </Select>
      <SegmentedTabs
        value={value}
        onValueChange={select}
        options={options}
        ariaLabel="Filter holdings"
        className="hidden md:grid"
      />
    </>
  );
}
