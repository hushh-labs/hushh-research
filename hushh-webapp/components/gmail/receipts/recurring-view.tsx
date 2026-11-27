"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { CheckCircle2, MoreHorizontal, Plus } from "@/components/icons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { nextCycle } from "@/lib/mail/receipt-cadence";
import { type DetectedBill, detectRecurringBills } from "@/lib/mail/receipt-recurring-detect";
import { type NewBill, type TrackedBill, hidePattern, nextDateFor, resumeTracking, skipOccurrence, trackBill, trackBills } from "@/lib/mail/receipt-tracking";
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

/** The bill One saves when the owner tracks a detected pattern. The receipts show it; no payment authority comes with it. */
function newBillFrom(d: DetectedBill): NewBill {
  return {
    patternKey: d.patternKey, source: "detected", name: d.name, icon: d.icon, kind: d.kind, currency: d.currency, frequency: d.frequency,
    agreedMinor: d.agreedMinor, anchorDay: d.anchorDay, nextOn: d.nextOn, reason: d.reason,
    evidence: d.evidence.map((e) => ({ ref: e.ref, label: e.label, amountMinor: e.amountMinor, on: e.on })),
    history: d.history,
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
    const ok = await tracking.apply((current, ctx) => trackBill(current, newBillFrom(d), ctx));
    setNotice(ok ? `Tracking ${d.name}. One shows its next date and any price rise.` : tracking.saveError);
    if (ok) setSheet(null);
  }, [tracking]);

  // The owner picks bills, then one saved change tracks every one of them.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const trackSelected = useCallback(async () => {
    if (!tracking) return;
    const chosen = cards.filter((item) => !item.tracked && item.detected && selected.has(item.key));
    if (!chosen.length) return;
    const ok = await tracking.apply((current, ctx) => trackBills(current, chosen.map((item) => newBillFrom(item.detected!)), ctx));
    if (ok) {
      setSelected(new Set());
      setNotice(`Tracking ${chosen.length === 1 ? chosen[0]!.name : `${chosen.length} bills`}. One shows each next date and flags a rise of more than 20%.`);
    } else setNotice(tracking.saveError);
  }, [cards, selected, tracking]);
  // A bill that is tracked, hidden or gone is no longer a choice.
  useEffect(() => {
    setSelected((previous) => {
      const open = new Set(cards.filter((item) => !item.tracked).map((item) => item.key));
      const kept = [...previous].filter((key) => open.has(key));
      return kept.length === previous.size ? previous : new Set(kept);
    });
  }, [cards]);

  const skip = useCallback(async (item: BillCard) => {
    if (!tracking || !item.tracked || !item.nextOn) return;
    const next = nextCycle(item.nextOn, item.frequency, item.tracked.anchorDay);
    const ok = await tracking.apply((current, ctx) => skipOccurrence(current, item.tracked!.id, item.nextOn!, ctx));
    setNotice(ok ? `Skipped ${item.name} on ${shortDate(item.nextOn)}. Next is ${shortDate(next)}.` : tracking.saveError);
  }, [tracking]);

  const ready = status === "ready";
  const chosenCount = cards.filter((item) => !item.tracked && selected.has(item.key)).length;

  return (
    <div className="space-y-4" data-testid="recurring-view" role="tabpanel" id="receipts-panel-recurring" aria-labelledby="receipts-view-recurring">
      <div className="space-y-2">
        <h3 className={cn(styles.chooserTitle, "text-foreground")}>Choose your bills</h3>
        <p className="text-[15px] leading-[22px] text-muted-foreground">
          One tracks the bills you pick and shows each next date. If a bill rises by more than 20%, One flags it for your review. It doesn’t pay bills.
        </p>
      </div>

      {status === "error" ? (
        <p className="flex items-center justify-between gap-3 rounded-2xl bg-[color:var(--app-warning-tint)] px-4 py-3 text-[13px] leading-[19px] text-foreground" role="alert" data-testid="tracking-error">
          {tracking?.error}
          <button type="button" onClick={tracking?.retry} className={cn(styles.secondaryPill, "!w-auto shrink-0")}>Try again</button>
        </p>
      ) : null}
      {tracking?.saveError ? <p className="rounded-2xl bg-[color:var(--app-warning-tint)] px-4 py-3 text-[13px] leading-[19px] text-foreground" role="alert">{tracking.saveError}</p> : null}
      {notice && !tracking?.saveError ? <p className="rounded-2xl bg-muted/60 px-4 py-3 text-[13px] leading-[19px] text-foreground" role="status" data-testid="recurring-notice">{notice}</p> : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[17px] leading-[24px] font-semibold text-foreground" data-testid="bill-count">
          {status === "loading" && !cards.length ? "Looking for recurring bills…" : `${cards.length} recurring ${cards.length === 1 ? "payment" : "payments"}`}
        </p>
        <button type="button" onClick={() => setSheet({ kind: "add" })} disabled={!ready} className={cn(styles.secondaryPill, "!w-auto shrink-0")}>
          <Plus aria-hidden="true" className="size-4" /> Add bill
        </button>
      </div>

      <section className={cn(card, "overflow-hidden")} aria-label="Recurring bills">
        {cards.length ? (
          <ul className="divide-y divide-border/60" data-testid="bill-list">
            {cards.map((item) => {
              const amount = billAmount({ kind: item.kind, agreedMinor: item.agreedMinor, currency: item.currency }, item.lastPaid);
              const checked = selected.has(item.key);
              return (
                <li key={item.key} className={styles.billRow} data-testid="bill-row" data-bill-status={item.tracked ? "tracking" : "suggested"} data-selected={checked ? "true" : undefined}>
                  {item.tracked ? (
                    <span className={styles.billCheck} title="Tracking" data-testid="bill-tracking-mark">
                      <CheckCircle2 aria-hidden="true" className="size-6 text-[color:var(--app-accent)]" />
                      <span className="sr-only">Tracking {item.name}</span>
                    </span>
                  ) : (
                    <label className={styles.billCheck}>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={checked}
                        disabled={!ready}
                        onChange={(event) => setSelected((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(item.key); else next.delete(item.key);
                          return next;
                        })}
                      />
                      <span className="sr-only">Select {item.name}</span>
                    </label>
                  )}
                  <button type="button" onClick={() => setSheet({ kind: "detail", bill: item })} className={styles.billName} data-testid="bill-open">
                    <span className="block truncate text-[16px] leading-[22px] font-semibold text-foreground">{item.name}</span>
                    {item.priceRise ? <span className="block text-[12px] leading-[18px] font-medium text-[color:var(--app-warning-deep)]" data-testid="row-price-rise">Up {item.priceRise.percent}% from usual</span>
                      : item.tracked ? <span className="block text-[12px] leading-[18px] text-muted-foreground">Tracking</span> : null}
                  </button>
                  <p className={styles.billWhen}>
                    {FREQUENCY_LABEL[item.frequency]} · {item.nextOn ? shortDate(item.nextOn) : "Date unknown"}
                    {item.nextOn && item.nextBasis !== "yours" ? <span className="text-[12px]"> · est.</span> : null}
                  </p>
                  <p className={styles.billAmount}>
                    {amount.prefix ? <span className="mr-1 text-[12px] font-normal text-muted-foreground">{amount.prefix}</span> : null}{amount.text ?? <span className="text-[12px] font-normal text-muted-foreground">Amount on the bill</span>}
                  </p>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`More for ${item.name}`} className={styles.billMenu} data-testid="bill-menu"><MoreHorizontal aria-hidden="true" className="size-5" /></button>
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

      {chosenCount ? (
        <div className={styles.selectionBar} role="region" aria-label="Selected bills" data-testid="bill-selection-bar">
          <p className="text-[16px] leading-[22px] font-medium text-foreground" role="status">
            {chosenCount} {chosenCount === 1 ? "bill" : "bills"} selected
          </p>
          <button type="button" className={cn(styles.primaryPill, "!w-auto shrink-0")} disabled={!ready} onClick={() => void trackSelected()} data-testid="track-selected">
            Track selected bills
          </button>
        </div>
      ) : null}

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
