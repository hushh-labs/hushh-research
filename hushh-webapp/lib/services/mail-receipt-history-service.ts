"use client";
import { captureReceiptHistory, receiptHistoryItems, validateReceiptHistory, RECEIPT_HISTORY_KEY, type ReceiptHistory } from "@/lib/mail/receipt-history";
import { receiptStoreGuard, type ReceiptStoreSession } from "@/lib/mail/receipt-store";
import { withReceiptBudget } from "@/lib/mail/receipt-operation";
import { SecureDurableResourceService as Durable, subscribeDurableOwnerReset } from "./secure-durable-resource-service";
import { GmailReceiptsService, type ReceiptListItem } from "./gmail-receipts-service";

type HistoryResource = { items: readonly ReceiptListItem[]; hydrated: boolean; refreshing: boolean; error: string | null; partial: boolean; readComplete: boolean };
const empty: HistoryResource = { items: [], hydrated: false, refreshing: false, error: null, partial: false, readComplete: false };
const resources = new Map<string, HistoryResource>();
const flights = new Map<string, { promise: Promise<void>; controller: AbortController; current: () => boolean; network: boolean }>();
const listeners = new Set<() => void>();
let unsubscribeReset: (() => void) | null = null;
function publish(owner: string, change: Partial<HistoryResource>) {
  unsubscribeReset ??= subscribeDurableOwnerReset(id => MailReceiptHistoryService.clear(id));
  resources.set(owner, { ...(resources.get(owner) ?? empty), ...change });
  listeners.forEach(listener => listener());
}

/** An explicitly owner-scoped archive. It never joins a current-account scan,
 * contributes to its totals or grants access to a provider detail. */
export class MailReceiptHistoryService {
  static peek(owner: string): HistoryResource { return resources.get(owner) ?? empty; }
  static subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  static clear(owner: string) {
    flights.get(owner)?.controller.abort(); flights.delete(owner); resources.delete(owner);
    if (!flights.size && !resources.size) { unsubscribeReset?.(); unsubscribeReset = null; }
    listeners.forEach(listener => listener());
  }
  static open(session: ReceiptStoreSession, getIdToken: () => Promise<string>, allowRead: boolean, retry = false): Promise<void> {
    const owner = session.userId;
    const existing = flights.get(owner);
    if (existing && (!existing.current() || existing.network && !allowRead)) { existing.controller.abort(); flights.delete(owner); publish(owner, { refreshing: false, error: null }); }
    else if (existing) return existing.promise;
    const cached = this.peek(owner);
    if (cached.hydrated && (!allowRead || cached.readComplete) && !retry) return Promise.resolve();
    const controller = new AbortController();
    const authority = receiptStoreGuard(session);
    const current = () => !controller.signal.aborted && flights.get(owner) === flight && authority();
    const flight = { promise: null as unknown as Promise<void>, controller, current, network: allowRead };
    publish(owner, { refreshing: true, error: null });
    flight.promise = withReceiptBudget(async signal => {
      const { expected, stored } = await withReceiptBudget(async () => {
        const expected = await Durable.version(owner, RECEIPT_HISTORY_KEY);
        const stored = await Durable.read<ReceiptHistory>(owner, RECEIPT_HISTORY_KEY, session.vaultKey, current);
        return { expected, stored };
      }, controller, 15_000);
      if (!current()) throw new DOMException("Mail session changed.", "AbortError");
      let history = stored ? validateReceiptHistory(stored.value) : null;
      let version = stored ?? expected;
      publish(owner, { items: history ? receiptHistoryItems(history) : [], hydrated: true, partial: history?.partial ?? false, readComplete: Boolean(history && !history.partial) });
      if (!allowRead || history && !history.partial && !retry) return;
      const idToken = await getIdToken();
      for (let page = history?.next_page ?? 1; page <= 100; page++) {
        if (!current()) throw new DOMException("Mail session changed.", "AbortError");
        const response = await GmailReceiptsService.getSavedHistory({ userId: owner, vaultOwnerToken: session.vaultOwnerToken, idToken, page, perPage: 100, signal });
        if (!current()) throw new DOMException("Mail session changed.", "AbortError");
        if (response.has_more && !response.items.length) throw new Error("Saved receipt history could not finish.");
        history = await captureReceiptHistory(response.items, history, response.has_more, response.has_more ? page + 1 : null);
        if (!current()) throw new DOMException("Mail session changed.", "AbortError");
        version = await Durable.write({ ...session, resourceKey: RECEIPT_HISTORY_KEY, value: history, expected: version,
          signal, isCurrent: current, validateReadback: validateReceiptHistory });
        if (!current()) throw new DOMException("Mail session changed.", "AbortError");
        publish(owner, { items: receiptHistoryItems(history), hydrated: true, partial: history.partial, readComplete: !history.partial });
        if (!response.has_more) return;
      }
      throw new Error("Saved receipt history paused. Earlier receipts were kept.");
    }, controller, allowRead ? 120_000 : 15_000).catch(error => {
      if (flights.get(owner) === flight) publish(owner, { error: "Earlier receipts couldn’t finish opening. Try again." });
      throw error;
    }).finally(() => {
      if (flights.get(owner) === flight) { flights.delete(owner); publish(owner, { refreshing: false }); }
    });
    flights.set(owner, flight); return flight.promise;
  }
}
