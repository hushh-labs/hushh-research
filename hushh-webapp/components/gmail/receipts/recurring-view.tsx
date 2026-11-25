"use client";

import { useCallback, useMemo, useState } from "react";

import { MoreHorizontal, Plus } from "@/components/icons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { nextCycle } from "@/lib/mail/receipt-cadence";
import { formatMinor } from "@/lib/mail/receipt-money";
import { type DetectedBill, detectRecurringBills } from "@/lib/mail/receipt-recurring-detect";
import { type TrackedBill, hidePattern, nextDateFor, resumeTracking, skipOccurrence, trackBill } from "@/lib/mail/receipt-tracking";
import { FREQUENCY_LABEL, billAmount, shortDate } from "@/lib/mail/receipt-tracking-present";
import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { cn } from "@/lib/utils";
import { useReceiptTracking } from "./receipt-tracking-context";
import { BillIcon } from "./receipts-chrome";
import { AddBillSheet, type BillCard, BillDetailSheet, DateSheet, StopSheet } from "./recurring-sheets";
import styles from "./receipts.module.css";

const card = "rounded-[20px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--shadow-xs)]";

type Sheet = { kind: "detail" | "date" | "stop"; bill: BillCard } | { kind: "add" } | null;

function cardFor(tracked: TrackedBill | null, detected: DetectedBill | null, today: Date): BillCard {
  if (tracked) {
    const next = nextDateFor(tracked, detected?.nextOn ?? null, today);
    const last = detected?.lastPaid ?? (tracked.history.at(-1) ? { paidOn: tracked.history.at(-1)!.paidOn, amountMinor: tracked.history.at(-1)!.amountMinor } : null);
    return {
      key: tracked.id, tracked, detected, name: tracked.name, icon: tracked.icon, reason: detected?.reason ?? tracked.reason, kind: tracked.kind,
      currency: tracked.currency, frequency: tracked.frequency, agreedMinor: tracked.agreedMinor, lastPaid: last, nextOn: next.on, nextBasis: next.basis,
      evidence: detected?.evidence.map((e) => ({ ref: e.ref, label: e.label, amountMinor: e.amountMinor, on: e.on })) ?? tracked.evidence, priceRise: detected?.priceRise ?? null,
    };
  }
  const d = detected!;
  return {
    key: d.patternKey, tracked: null, detected: d, name: d.name, icon: d.icon, reason: d.reason, kind: d.kind, currency: d.currency, frequency: d.frequency,
    agreedMinor: d.agreedMinor, lastPaid: d.lastPaid, nextOn: d.nextOn, nextBasis: "estimated",
    evidence: d.evidence.map((e) => ({ ref: e.ref, label: e.label, amountMinor: e.amountMinor, on: e.on })), priceRise: d.priceRise,
  };
}

export function RecurringView({ rows, onOpenReceipt }: { rows: readonly RecentReceiptRow[]; onOpenReceipt: (receiptKey: string) => void }) {
  const tracking = useReceiptTracking();
  const doc = tracking?.doc ?? null;
  const status = tracking?.status ?? "idle";
  const [sheet, setSheet] = useState<Sheet>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showStopped, setShowStopped] = useState(false);
  const today = useMemo(() => new Date(), []);

  const { cards, stopped } = useMemo(() => {
    const detected = detectRecurringBills(rows, today);
    const byKey = new Map(detected.map((item) => [item.patternKey, item]));
    const trackedCards = (doc?.bills ?? []).filter((bill) => bill.status === "tracking").map((bill) => cardFor(bill, byKey.get(bill.patternKey) ?? null, today));
    const known = new Set((doc?.bills ?? []).map((bill) => bill.patternKey));
    const hidden = new Set(doc?.hiddenPatterns ?? []);
    const suggested = detected.filter((item) => !known.has(item.patternKey) && !hidden.has(item.patternKey)).map((item) => cardFor(null, item, today));
    const order = (item: BillCard) => `${item.tracked ? "0" : "1"}${item.nextOn ?? "9999-12-31"}`;
    return {
      cards: [...trackedCards, ...suggested].sort((a, b) => order(a).localeCompare(order(b))),
      stopped: (doc?.bills ?? []).filter((bill) => bill.status === "stopped").map((bill) => cardFor(bill, byKey.get(bill.patternKey) ?? null, today)),
    };
  }, [rows, doc, today]);

  const track = useCallback(async (item: BillCard) => {
    if (!tracking || !item.detected) return;
    const d = item.detected;
    const ok = await tracking.apply((current, ctx) => trackBill(current, {
      patternKey: d.patternKey, source: "detected", name: d.name, icon: d.icon, kind: d.kind, currency: d.currency, frequency: d.frequency,
      agreedMinor: d.agreedMinor, anchorDay: d.anchorDay, nextOn: d.nextOn, reason: d.reason,
      evidence: d.evidence.map((e) => ({ ref: e.ref, label: e.label, amountMinor: e.amountMinor, on: e.on })),
      history: d.history,
    }, ctx));
    setNotice(ok ? `Tracking ${d.name}. One shows its next date and any price rise.` : tracking.saveError);
    if (ok) setSheet(null);
  }, [tracking]);

  const skip = useCallback(async (item: BillCard) => {
    if (!tracking || !item.tracked || !item.nextOn) return;
    const next = nextCycle(item.nextOn, item.frequency, item.tracked.anchorDay);
    const ok = await tracking.apply((current, ctx) => skipOccurrence(current, item.tracked!.id, item.nextOn!, ctx));
    setNotice(ok ? `Skipped ${item.name} on ${shortDate(item.nextOn)}. Next is ${shortDate(next)}.` : tracking.saveError);
  }, [tracking]);

  const byDate = (list: BillCard[]) => list.filter((item) => item.nextOn).sort((a, b) => a.nextOn!.localeCompare(b.nextOn!))[0] ?? null;
  // A tracked bill leads; until something is tracked, the soonest bill One found is shown as an estimate.
  const upcoming = byDate(cards.filter((item) => item.tracked)) ?? byDate(cards);
  const ready = status === "ready";

  return (
    <div className="space-y-4" data-testid="recurring-view" role="tabpanel" id="receipts-panel-recurring" aria-labelledby="receipts-view-recurring">
      <div className="flex items-center justify-between gap-3">
        <h3 className={cn(styles.cardTitle, "text-foreground")}>Recurring payments</h3>
        <button type="button" onClick={() => setSheet({ kind: "add" })} disabled={!ready} className={cn(styles.secondaryPill, "!w-auto shrink-0")}>
          <Plus aria-hidden="true" className="size-4" /> Add bill
        </button>
      </div>
      <p className="text-[13px] leading-[19px] text-muted-foreground">One tracks these bills from your receipts. It doesn’t pay them.</p>

      {status === "error" ? (
        <p className="flex items-center justify-between gap-3 rounded-2xl bg-[color:var(--app-warning-tint)] px-4 py-3 text-[13px] leading-[19px] text-foreground" role="alert" data-testid="tracking-error">
          {tracking?.error}
          <button type="button" onClick={tracking?.retry} className={cn(styles.secondaryPill, "!w-auto shrink-0")}>Try again</button>
        </p>
      ) : null}
      {tracking?.saveError ? <p className="rounded-2xl bg-[color:var(--app-warning-tint)] px-4 py-3 text-[13px] leading-[19px] text-foreground" role="alert">{tracking.saveError}</p> : null}
      {notice && !tracking?.saveError ? <p className="rounded-2xl bg-muted/60 px-4 py-3 text-[13px] leading-[19px] text-foreground" role="status" data-testid="recurring-notice">{notice}</p> : null}

      <section className={cn(card, "p-4 sm:p-5")} aria-label="Next payment" data-testid="next-payment">
        <h3 className={cn(styles.cardTitle, "text-foreground")}>Next payment</h3>
        <p className="mt-1 text-[14px] leading-[21px] text-muted-foreground">
          {status === "loading" ? "Opening your tracked bills…" : upcoming
            ? `${upcoming.name} · ${shortDate(upcoming.nextOn, true)} · ${upcoming.kind === "fixed" && upcoming.agreedMinor ? formatMinor(upcoming.agreedMinor, upcoming.currency) : "Amount when the bill arrives"}`
            : "No recurring bills yet. Add one, or wait for three receipts on a regular rhythm."}
        </p>
        {upcoming ? <p className="text-[12px] leading-[18px] text-muted-foreground">{upcoming.nextBasis === "yours" ? "Date set by you." : "Estimated from your receipts."}{upcoming.tracked ? "" : " Not tracked yet."}</p> : null}
      </section>

      <section className={cn(card, "overflow-hidden")} aria-label="Recurring bills">
        {cards.length ? (
          <ul className="divide-y divide-border/60" data-testid="bill-list">
            {cards.map((item) => {
              const amount = billAmount({ kind: item.kind, agreedMinor: item.agreedMinor, currency: item.currency }, item.lastPaid);
              return (
                <li key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 py-3" data-testid="bill-row" data-bill-status={item.tracked ? "tracking" : "suggested"}>
                  <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_132px_112px]">
                    <BillIcon icon={item.icon} />
                    <button type="button" onClick={() => setSheet({ kind: "detail", bill: item })} className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">
                      <span className="block truncate text-[14px] leading-[21px] font-semibold text-foreground">{item.name}</span>
                      {item.reason ? <span className="line-clamp-2 text-[12px] leading-[18px] text-muted-foreground sm:line-clamp-1">{item.reason}</span> : null}
                      {item.priceRise ? <span className="block text-[12px] leading-[18px] font-medium text-[color:var(--app-warning-deep)]" data-testid="row-price-rise">Up {item.priceRise.percent}% from usual</span> : null}
                    </button>
                    <div className="col-span-2 flex items-center justify-between gap-3 pl-12 sm:contents">
                      <p className="min-w-0 text-[12px] leading-[18px] text-muted-foreground sm:text-[13px]">
                        <span className="block text-foreground/80">{item.nextOn ? `Next ${shortDate(item.nextOn)}` : "Date unknown"}</span>
                        <span className="block">{FREQUENCY_LABEL[item.frequency]} · {item.nextBasis === "yours" ? "your date" : "est."}</span>
                      </p>
                      <div className="text-right">
                        {!item.tracked ? <button type="button" onClick={() => void track(item)} disabled={!ready} className="mb-0.5 min-h-11 px-1 text-[13px] font-semibold text-[color:var(--app-accent)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">Track bill</button> : null}
                        <p className="text-[14px] leading-[21px] font-bold tabular-nums text-foreground">
                          {amount.prefix ? <span className="mr-1 text-[12px] font-normal text-muted-foreground">{amount.prefix}</span> : null}{amount.text ?? <span className="text-[12px] font-normal text-muted-foreground">Amount on the bill</span>}
                        </p>
                      </div>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`More for ${item.name}`} className="inline-flex size-11 items-center justify-center rounded-full text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]" data-testid="bill-menu"><MoreHorizontal aria-hidden="true" className="size-5" /></button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[210px]">
                      {!item.tracked ? <DropdownMenuItem disabled={!ready} onSelect={() => void track(item)}>Track bill</DropdownMenuItem> : null}
                      <DropdownMenuItem onSelect={() => setSheet({ kind: "detail", bill: item })}>See why and receipts</DropdownMenuItem>
                      {item.tracked ? (
                        <>
                          <DropdownMenuItem onSelect={() => setSheet({ kind: "date", bill: item })}>Change date</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void skip(item)}>Skip this one</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setSheet({ kind: "stop", bill: item })}>Stop tracking</DropdownMenuItem>
                        </>
                      ) : item.detected && doc ? (
                        <DropdownMenuItem disabled={!ready} onSelect={() => void tracking?.apply((current, ctx) => hidePattern(current, item.detected!.patternKey, item.name, ctx))}>Not a recurring bill</DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 py-8 text-center text-[14px] leading-[21px] text-muted-foreground" role="status">
            {status === "loading" ? "Looking for recurring bills…" : "No recurring bills found yet. One suggests a bill after it sees three receipts on a regular rhythm, or you can add one."}
          </p>
        )}
      </section>

      {stopped.length ? (
        <section className={cn(card, "overflow-hidden")} aria-label="Stopped bills">
          <button type="button" aria-expanded={showStopped} onClick={() => setShowStopped((value) => !value)} className="flex min-h-11 w-full items-center justify-between px-4 text-[14px] font-semibold text-foreground">
            Stopped ({stopped.length})<span className="text-[13px] font-medium text-[color:var(--app-accent)]">{showStopped ? "Hide" : "Show"}</span>
          </button>
          {showStopped ? (
            <ul className="divide-y divide-border/60 border-t border-border/60">
              {stopped.map((item) => (
                <li key={item.key} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="flex min-w-0 items-center gap-3"><BillIcon icon={item.icon} /><span className="truncate text-[14px] font-semibold text-foreground">{item.name}</span></span>
                  <button type="button" disabled={!ready} onClick={() => void tracking?.apply((current, ctx) => resumeTracking(current, item.tracked!.id, ctx))} className={cn(styles.secondaryPill, "!w-auto")}>Track again</button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <AddBillSheet open={sheet?.kind === "add"} onClose={() => setSheet(null)} />
      <DateSheet bill={sheet?.kind === "date" ? sheet.bill : null} onClose={() => setSheet(null)} />
      <StopSheet bill={sheet?.kind === "stop" ? sheet.bill : null} onClose={() => setSheet(null)} />
      <BillDetailSheet
        bill={sheet?.kind === "detail" ? sheet.bill : null}
        onClose={() => setSheet(null)}
        onOpenReceipt={(key) => { setSheet(null); onOpenReceipt(key); }}
        onTrack={(item) => void track(item)}
      />
    </div>
  );
}
