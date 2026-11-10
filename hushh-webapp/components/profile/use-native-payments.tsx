"use client";

import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAnswerPayoutAccountModel } from "@/components/consent/answer-payout-account";
import { parseCommerceReturn } from "@/lib/services/scope-commerce-return";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import type { NativeDrawerRow, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { useNativePayouts } from "./use-native-payouts";

class PaymentsVisit {
  private live = false;
  readonly handles = new Map<string, string>();
  constructor(readonly enabled: boolean, readonly owner: string, readonly epoch: ReturnType<typeof snapshotVaultSessionEpoch>,
    readonly auth: ReturnType<typeof snapshotValidatedAuthSessionOwner>) {}
  isLive() { return this.live; }
  activate() { this.live = true; }
  retire() { this.live = false; this.handles.clear(); }
}
/** Keep the existing payout owner and authenticated answer-return recovery. */
export function useNativePayments(enabled: boolean, native: boolean, owner: string) {
  const pathname = usePathname(), query = useSearchParams();
  const answerReturn = parseCommerceReturn(`${pathname}?${query}`)?.source === "answers";
  const answer = useAnswerPayoutAccountModel(enabled && answerReturn);
  const document = useNativePayouts(native);
  const auth = snapshotValidatedAuthSessionOwner(), epoch = snapshotVaultSessionEpoch();
  const authUserId = auth?.userId, authGeneration = auth?.generation;
  const visit = useMemo(() => new PaymentsVisit(enabled, owner, epoch,
    authUserId && authGeneration !== undefined ? { userId: authUserId, generation: authGeneration } : null),
  [enabled, owner, authUserId, authGeneration, epoch]);
  const [admittedVisit, setAdmittedVisit] = useState<typeof visit>();
  const current = useCallback(() => visit.enabled && visit.isLive() && !!visit.auth && isValidatedAuthSessionOwnerCurrent(visit.auth) && isVaultSessionEpochCurrent(visit.epoch), [visit]);
  useLayoutEffect(() => { visit.activate(); setAdmittedVisit(visit); return () => visit.retire(); }, [visit]);
  const rows = new Map<string, () => Promise<void>>();
  const handle = (key: string) => { let id = visit.handles.get(key); if (!id) { id = crypto.randomUUID(); visit.handles.set(key, id); } return id; };
  const read = (key: string, label: string, detail?: string): NativeDrawerRow => ({ id: handle(key), label, ...(detail ? { detail } : {}), enabled: true, readOnly: true });
  const action = (key: string, label: string, run: () => void | Promise<unknown>, disabled = false): NativeDrawerRow => {
    const id = handle(key); rows.set(id, async () => { if (current() && !disabled) await run(); }); return { id, label, enabled: admittedVisit === visit && !disabled, chevron: true };
  };
  const answerRows: NativeDrawerRow[] = [];
  if (answerReturn) {
    if (answer.status.data?.payouts === false) answerRows.push(read("answer-disabled", "Answer payout setup opens once paid answers are switched on here. Approving still records the price; nothing is charged or paid out until then."));
    else answerRows.push(action("answer-manage", answer.action.busy || answer.hosted.hostedPending ? "Checking payout setup…" : "Manage answer payouts", answer.manage, !answer.status.user || answer.action.busy || answer.hosted.hostedPending),
      read("answer-fees", "Answer earnings deduct Hushh’s 3% fee and Stripe’s actual processing fee. Stripe verifies your identity and bank; you do not need a separate company."));
    if (answer.status.data?.stripeMode) answerRows.push(read("answer-mode", answer.status.data.stripeMode === "test" ? "Test payout setup. No real money moves." : "Live answer payout setup."));
    if (answer.action.message || answer.status.error) answerRows.push(read("answer-message", answer.action.message || answer.status.error!));
  }
  const root: NativeProfilePage = { id: "payouts", title: "Payouts", sections: [
    ...(answerReturn ? [{ id: "answer-section", title: "Answer payout setup", rows: answerRows }] : []),
    ...(document.pages[0]?.sections ?? []),
  ] };
  for (const [id, command] of document.rows) rows.set(id, async () => { await command(); });
  const busy = answer.action.busy || document.busy;
  const pages = [root, ...document.pages.slice(1)];
  const presentedPages = busy ? pages.map(page => ({ ...page, sections: page.sections.map(section => ({ ...section,
    rows: section.rows.map(row => row.readOnly ? row : { ...row, enabled: false }) })) })) : pages;
  const reset = () => { if (busy) return false; document.reset(); return true; };
  return { answer, pages: presentedPages, rows, busy, nested: pages.length > 1,
    back: () => busy || document.back(), reset, onPresented: document.onPresented,
    ancestor: (choice: { rowId?: string }) => { if (busy) return false; if (choice.rowId === "payouts") return reset(); return document.ancestor(choice); },
    formScene: null,
    editor: (_destinationId: string, _onFallback: () => void) => null,
  };
}
