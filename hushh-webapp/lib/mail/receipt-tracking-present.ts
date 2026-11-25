import type { Cadence } from "./receipt-cadence";
import { formatMinor } from "./receipt-money";
import type { TrackedBill, TrackingEvent } from "./receipt-tracking";

export const FREQUENCY_LABEL: Record<Cadence, string> = { weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };

export function shortDate(iso: string | null | undefined, withYear = false): string {
  if (!iso) return "";
  const at = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", withYear ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" }).format(at);
}

/** The figure beside a bill: the agreed amount, or "Last ₹1,780" for a variable bill. */
export function billAmount(bill: Pick<TrackedBill, "kind" | "agreedMinor" | "currency">, lastPaid: { amountMinor: number } | null): { prefix: string | null; text: string | null } {
  if (bill.kind === "fixed" && bill.agreedMinor) return { prefix: null, text: formatMinor(bill.agreedMinor, bill.currency) };
  if (lastPaid) return { prefix: "Last", text: formatMinor(lastPaid.amountMinor, bill.currency) };
  return { prefix: null, text: null };
}

/** The sentence History and Activity show for one recorded choice. */
export function eventText(event: TrackingEvent): string {
  const d = event.detail;
  const name = String(d.name ?? "A bill");
  switch (event.kind) {
    case "bill_added": return d.source === "manual" ? `You added ${name} to track` : `You started tracking ${name}`;
    case "date_changed": return d.from ? `You moved ${name} from ${shortDate(String(d.from))} to ${shortDate(String(d.to))}` : `You set ${name} for ${shortDate(String(d.to))}`;
    case "occurrence_skipped": return `You skipped ${name} on ${shortDate(String(d.on))}`;
    case "tracking_stopped": return `You stopped tracking ${name}`;
    case "tracking_resumed": return `You started tracking ${name} again`;
    case "pattern_hidden": return `You said ${name} is not a recurring bill`;
    case "review_saved": return `You reviewed your plans: cancel ${Number(d.cancel ?? 0)}, keep ${Number(d.keep ?? 0)}`;
    case "cancellation_confirmed": return `${name} confirmed the cancellation`;
    case "insight_reviewed": return d.choice === "keep" ? `You kept the plan: “${String(d.title ?? "an item")}”` : `You marked “${String(d.title ?? "an item")}” as not an issue`;
  }
}

export const RECURRING_EVENT_KINDS = new Set<TrackingEvent["kind"]>(["bill_added", "date_changed", "occurrence_skipped", "tracking_stopped", "tracking_resumed", "pattern_hidden"]);

/** The numbers behind a price-rise finding, as label and value rows. */
export function riseFacts(rise: { latestMinor: number; baselineMinor: number; percent: string; basis: "median_last_three"; currency: string }): Array<{ label: string; value: string }> {
  return [
    { label: "This bill", value: formatMinor(rise.latestMinor, rise.currency) },
    { label: "Usual (middle of the last 3 paid)", value: formatMinor(rise.baselineMinor, rise.currency) },
    { label: "Change", value: `+${rise.percent}%` },
  ];
}
