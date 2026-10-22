"use client";

import type { ReactNode } from "react";
import { Search } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { KaiHomePickSource } from "@/lib/services/api-service";
import styles from "@/components/kai/shared/finance-workspace.module.css";

function OptionField({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void;
}) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="h-11 min-w-0 w-full text-xs"><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
}

export function StockListToolbar({ query, setQuery, tier, setTier, sector, setSector, sectors, pageSize, setPageSize, pageSizes, sources, activeSource, onSourceChange, actions }: {
  query: string; setQuery: (query: string) => void; tier: string; setTier: (tier: string) => void;
  sector: string; setSector: (sector: string) => void; sectors: string[];
  pageSize: number; setPageSize: (size: number) => void; pageSizes: readonly number[];
  sources: KaiHomePickSource[]; activeSource: string; onSourceChange?: (source: string) => void; actions?: ReactNode;
}) {
  return <div className="space-y-3 pb-1" data-no-route-swipe>
    <div className={styles.toolbar}>
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input type="search" aria-label="Search stocks" value={query} onChange={event => setQuery(event.target.value)} placeholder="Symbol or company" className="pl-10" autoComplete="off" autoCorrect="off" spellCheck={false} />
      </div>
      {actions}
    </div>
    {sources.length > 1 ? <OptionField label="List source" value={activeSource} onChange={value => onSourceChange?.(value)} options={sources.map(source => ({ value: source.id, label: `${source.label}${source.state === "ready" ? "" : ` · ${source.state}`}` }))} /> : null}
    <div className="grid grid-cols-3 gap-2">
      <OptionField label="Tier" value={tier} onChange={setTier} options={[{ value: "all", label: "All tiers" }, ...["ACE", "KING", "QUEEN", "JACK"].map(value => ({ value, label: value }))]} />
      <OptionField label="Sector" value={sector} onChange={setSector} options={[{ value: "all", label: "All sectors" }, ...sectors.map(value => ({ value, label: value }))]} />
      <OptionField label="Rows per page" value={String(pageSize)} onChange={value => setPageSize(Number(value))} options={pageSizes.map(value => ({ value: String(value), label: `${value} rows` }))} />
    </div>
  </div>;
}
