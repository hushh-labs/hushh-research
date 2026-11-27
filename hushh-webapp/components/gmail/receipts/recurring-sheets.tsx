"use client";

import { useEffect, useState, type ReactNode } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Input } from "@/components/ui/input";
import { type Cadence, isoDate } from "@/lib/mail/receipt-cadence";
import { currencyExponent, formatMinor } from "@/lib/mail/receipt-money";
import { priceRiseSentence } from "@/lib/mail/receipt-price-rise";
import type { DetectedBill } from "@/lib/mail/receipt-recurring-detect";
import { type TrackedBill, changeNextDate, stopTracking, trackBill } from "@/lib/mail/receipt-tracking";
import { FREQUENCY_LABEL, riseFacts, shortDate } from "@/lib/mail/receipt-tracking-present";
import { cn } from "@/lib/utils";
import mailStyles from "../mail-workspace.module.css";
import { useReceiptTracking } from "./receipt-tracking-context";
import { BILL_ICON_CHOICES, BillIcon } from "./receipts-chrome";
import styles from "./receipts.module.css";

const surface = `${mailStyles.typography} ${mailStyles.portal}`;
const fieldClass = "h-11 w-full rounded-xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-3 text-[16px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] sm:text-[14px]";

/** A bill as the list shows it, whether or not it is tracked yet. */
export interface BillCard {
  key: string;
  tracked: TrackedBill | null;
  detected: DetectedBill | null;
  name: string;
  icon: string;
  reason: string;
  kind: "fixed" | "variable";
  currency: string;
  frequency: Cadence;
  agreedMinor: number | null;
  lastPaid: { paidOn: string; amountMinor: number } | null;
  nextOn: string | null;
  nextBasis: "estimated" | "yours";
  evidence: TrackedBill["evidence"];
  priceRise: DetectedBill["priceRise"];
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] leading-[18px] font-semibold text-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-[12px] leading-[18px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function toMinorInput(value: string, currency: string): number | null {
  const exponent = currencyExponent(currency) ?? 2;
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(cleaned)) return null;
  const minor = Math.round(Number(cleaned) * 10 ** exponent);
  return minor > 0 ? minor : null;
}

export function AddBillSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tracking = useReceiptTracking();
  const today = isoDate(new Date());
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"fixed" | "variable">("fixed");
  const [icon, setIcon] = useState("bill");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [frequency, setFrequency] = useState<Cadence>("monthly");
  const [nextOn, setNextOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setAmount(""); setError(null); setNextOn(isoDate(new Date())); } }, [open]);
  const amountMinor = toMinorInput(amount, currency);
  const valid = name.trim().length > 0 && (kind === "variable" || amountMinor !== null) && Boolean(nextOn);
  const canSave = tracking?.status === "ready";

  const save = async () => {
    if (!tracking || !valid) return;
    setBusy(true);
    setError(null);
    const ok = await tracking.apply((doc, ctx) => trackBill(doc, {
      patternKey: `manual:${ctx.id()}`, source: "manual", name: name.trim(), icon, kind, currency, frequency,
      agreedMinor: kind === "fixed" ? amountMinor : null, anchorDay: Number(nextOn.slice(8, 10)), nextOn,
      reason: "Added by you.", evidence: [], history: [],
    }, ctx));
    setBusy(false);
    if (ok) onClose();
    else setError(tracking.saveError);
  };

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      eyebrow="Recurring payments"
      title="Add a bill"
      description="One tracks the bill and its next date. It doesn’t pay anything."
      surfaceClassName={surface}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
      footer={<div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={onClose} className={styles.secondaryPill}>Cancel</button><button type="button" onClick={() => void save()} disabled={busy || !valid || !canSave} className={styles.primaryPill}>Add bill</button></div>}
    >
      <div className="space-y-4" data-testid="add-bill-sheet">
        {!canSave ? <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-[13px] leading-[19px] text-muted-foreground" role="status">{tracking?.error ?? "Open your private vault to track bills."}</p> : null}
        <Field label="Bill name"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Electricity bill" className="h-11 text-[16px] sm:text-[14px]" /></Field>
        <Field label="Kind of bill">
          <select className={fieldClass} value={icon} onChange={(event) => setIcon(event.target.value)}>{BILL_ICON_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
        </Field>
        <Field label="Amount" hint={kind === "variable" ? "Different each time, like electricity." : "The same every time, like rent."}>
          <div className="flex gap-2" role="radiogroup" aria-label="Amount type">
            {(["fixed", "variable"] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={kind === option} onClick={() => setKind(option)} className={cn("min-h-11 flex-1 rounded-xl border px-3 text-[14px] font-semibold", kind === option ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]" : "border-[color:var(--app-card-border-standard)] text-muted-foreground")}>{option === "fixed" ? "Same each time" : "Varies"}</button>
            ))}
          </div>
        </Field>
        {kind === "fixed" ? (
          <div className="grid grid-cols-[1fr_96px] gap-2">
            <Field label="Amount"><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={amount !== "" && !amountMinor} className="h-11 text-[16px] sm:text-[14px]" /></Field>
            <Field label="Currency"><select className={fieldClass} value={currency} onChange={(event) => setCurrency(event.target.value)}>{["INR", "USD", "EUR", "GBP"].map((code) => <option key={code}>{code}</option>)}</select></Field>
          </div>
        ) : null}
        <Field label="How often">
          <select className={fieldClass} value={frequency} onChange={(event) => setFrequency(event.target.value as Cadence)}>{(Object.keys(FREQUENCY_LABEL) as Cadence[]).map((value) => <option key={value} value={value}>{FREQUENCY_LABEL[value]}</option>)}</select>
        </Field>
        <Field label="Next date"><Input type="date" value={nextOn} onChange={(event) => setNextOn(event.target.value)} className="h-11 text-[16px] sm:text-[14px]" /></Field>
        {error ? <p className="text-[13px] text-destructive" role="alert">{error}</p> : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

export function DateSheet({ bill, onClose }: { bill: BillCard | null; onClose: () => void }) {
  const tracking = useReceiptTracking();
  const [date, setDate] = useState(isoDate(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (bill) { setDate(bill.nextOn ?? isoDate(new Date())); setError(null); } }, [bill?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!bill?.tracked || !tracking) return;
    setBusy(true);
    const ok = await tracking.apply((doc, ctx) => changeNextDate(doc, bill.tracked!.id, bill.nextOn, date, ctx));
    setBusy(false);
    if (ok) onClose();
    else setError(tracking.saveError);
  };
  return (
    <AdaptiveDetailSurface
      open={Boolean(bill)} onOpenChange={(open) => { if (!open) onClose(); }}
      eyebrow={bill?.name} title="Change next date" description="This is the date One shows for the next bill. It is a reminder, not a payment."
      surfaceClassName={surface} mobilePresentation="sheet" desktopMaxWidthClassName="sm:!max-w-[420px]"
      footer={<div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={onClose} className={styles.secondaryPill}>Cancel</button><button type="button" onClick={() => void save()} disabled={busy || !date} className={styles.primaryPill}>Save date</button></div>}
    >
      <div className="space-y-3">
        <Field label="Next bill date"><Input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="h-11 text-[16px] sm:text-[14px]" /></Field>
        {error ? <p className="text-[13px] text-destructive" role="alert">{error}</p> : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

export function StopSheet({ bill, onClose }: { bill: BillCard | null; onClose: () => void }) {
  const tracking = useReceiptTracking();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    if (!bill?.tracked || !tracking) return;
    setBusy(true);
    const ok = await tracking.apply((doc, ctx) => stopTracking(doc, bill.tracked!.id, ctx));
    setBusy(false);
    if (ok) onClose();
    else setError(tracking.saveError);
  };
  return (
    <AdaptiveDetailSurface
      open={Boolean(bill)} onOpenChange={(open) => { if (!open) onClose(); }}
      eyebrow={bill?.name} title="Stop tracking this bill?"
      description="One stops showing its next date. Your receipts stay, and you can track it again later."
      surfaceClassName={surface} mobilePresentation="sheet" desktopMaxWidthClassName="sm:!max-w-[420px]"
      footer={<div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={onClose} className={styles.secondaryPill}>Keep tracking</button><button type="button" onClick={() => void stop()} disabled={busy} className={cn(styles.primaryPill, "!bg-destructive")}>Stop tracking</button></div>}
    >
      {error ? <p className="text-[13px] text-destructive" role="alert">{error}</p> : <span />}
    </AdaptiveDetailSurface>
  );
}

/** Why One suggests this bill, the receipts behind it and, when it applies, the price check. */
export function BillDetailSheet({
  bill, onClose, onOpenReceipt, onTrack,
}: {
  bill: BillCard | null;
  onClose: () => void;
  onOpenReceipt: (receiptKey: string) => void;
  onTrack: (bill: BillCard) => void;
}) {
  const rise = bill?.priceRise ?? null;
  return (
    <AdaptiveDetailSurface
      open={Boolean(bill)} onOpenChange={(open) => { if (!open) onClose(); }}
      leading={bill ? <BillIcon icon={bill.icon} /> : undefined}
      eyebrow={bill ? `${FREQUENCY_LABEL[bill.frequency]} · ${bill.kind === "fixed" ? "Same each time" : "Varies"}` : undefined}
      title={bill?.name ?? ""} description={bill?.reason || undefined}
      surfaceClassName={surface} mobilePresentation="sheet" desktopMaxWidthClassName="sm:!max-w-[520px]"
      footer={bill && !bill.tracked ? <button type="button" onClick={() => onTrack(bill)} className={styles.primaryPill}>Track bill</button> : undefined}
    >
      {bill ? (
        <div className="space-y-4" data-testid="bill-detail">
          <dl className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 text-[14px]">
            <div className="flex justify-between gap-3 py-2.5"><dt className="text-muted-foreground">Status</dt><dd className="font-medium">{bill.tracked ? "Tracking" : "Not tracking yet"}</dd></div>
            {bill.nextOn ? <div className="flex justify-between gap-3 py-2.5"><dt className="text-muted-foreground">{bill.nextBasis === "yours" ? "Next bill (your date)" : "Next bill (estimated)"}</dt><dd className="font-medium">{shortDate(bill.nextOn, true)}</dd></div> : null}
            {bill.kind === "fixed" && bill.agreedMinor ? <div className="flex justify-between gap-3 py-2.5"><dt className="text-muted-foreground">Amount</dt><dd className="font-medium">{formatMinor(bill.agreedMinor, bill.currency)}</dd></div> : null}
            {bill.lastPaid ? <div className="flex justify-between gap-3 py-2.5"><dt className="text-muted-foreground">Last paid</dt><dd className="font-medium">{formatMinor(bill.lastPaid.amountMinor, bill.currency)} · {shortDate(bill.lastPaid.paidOn)}</dd></div> : null}
          </dl>
          {rise ? (
            <div className="space-y-2" data-testid="price-rise">
              <p className="text-[14px] leading-[21px] text-foreground">{priceRiseSentence(bill.name, rise)}</p>
              <dl className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 text-[13px]">
                {riseFacts(rise).map((fact) => <div key={fact.label} className="flex justify-between gap-3 py-2"><dt className="text-muted-foreground">{fact.label}</dt><dd className="font-medium tabular-nums">{fact.value}</dd></div>)}
              </dl>
            </div>
          ) : null}
          {bill.evidence.length ? (
            <div className="space-y-2">
              <p className="text-[13px] font-semibold text-foreground">Receipts behind this</p>
              <ul className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]">
                {bill.evidence.map((item) => (
                  <li key={item.ref}>
                    <button type="button" onClick={() => onOpenReceipt(item.ref)} className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"><span>{item.label} · {shortDate(item.on)}</span><span className="tabular-nums text-muted-foreground">{item.amountMinor ? formatMinor(item.amountMinor, bill.currency) : "—"}</span></button>
                  </li>
                ))}
              </ul>
            </div>
          ) : <p className="text-[13px] text-muted-foreground">Added by you. There are no receipts behind it yet.</p>}
        </div>
      ) : null}
    </AdaptiveDetailSurface>
  );
}
