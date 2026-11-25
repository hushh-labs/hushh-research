"use client";

import { ChevronRightIcon } from "@/components/icons";
import type { NwsReport } from "@/lib/kai/plaid-vault/nws-score";

export type NwsCardAction = { label: string; run: () => void };

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export function netWorthScoreDisplay(report: NwsReport | null) {
  const asOf = report?.asOfTimestamp;
  return {
    amount: report?.netWorth == null ? "—" : dollars.format(report.netWorth),
    updated: asOf && Number.isFinite(Date.parse(asOf)) ? date.format(new Date(asOf)) : null,
  };
}

export function NetWorthScoreCard({
  report, status, primary, secondary, onOpen, detail = false,
}: {
  report: NwsReport | null;
  status: string | null;
  primary?: NwsCardAction;
  secondary?: NwsCardAction;
  onOpen?: () => void;
  detail?: boolean;
}) {
  const display = netWorthScoreDisplay(report);
  return (
    <section aria-label="Net Worth Score" className="min-w-0 rounded-2xl border [font-family:var(--font-app-body)] border-emerald-700 bg-[#102c23] p-5 text-[#f2efe3]">
      {!detail && <h2 className="text-base font-semibold">
        {onOpen ? <button type="button" onClick={onOpen}
          className="flex min-h-11 w-full items-center justify-between gap-2 text-start">
          Net Worth Score <ChevronRightIcon className="size-4 shrink-0 rtl:rotate-180" aria-hidden />
        </button> : "Net Worth Score"}
      </h2>}
      <p className="mt-1 font-bold leading-tight tabular-nums text-3xl text-[#f0c95c] [overflow-wrap:anywhere] sm:text-4xl">
        {display.amount}
      </p>
      {detail && display.updated &&
        <p className="mt-1 text-xs text-[#b6cfc0]">Last updated <time dateTime={report?.asOfTimestamp}>{display.updated}</time></p>}
      {status && <p className="mt-2 text-sm text-[#f4d695]" aria-live="polite">{status}</p>}
      {primary && <button type="button" onClick={primary.run}
        className="mt-3 min-h-11 rounded-lg bg-[#f0c95c] px-4 text-sm font-semibold text-[#102c23]">{primary.label}</button>}
      {secondary && <button type="button" onClick={secondary.run}
        className="ms-2 mt-3 min-h-11 px-2 text-sm font-semibold underline">{secondary.label}</button>}
    </section>
  );
}
