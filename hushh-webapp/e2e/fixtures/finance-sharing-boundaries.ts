// Synthetic session/source/transport only. The sharing surfaces and projection are real.
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { projectFinance, type FinanceGrant, type FinancePolicy } from "@/lib/finance-sharing/contract";

export const sharingModel = mapPortfolioToDashboardViewModel({
  total_value: 10000, account_summary: { ending_value: 10000 },
  holdings: [{ symbol: "TEST", name: "Sample company", market_value: 8000, quantity: 10, price: 800, cost_basis: 7000, sector: "Technology" }],
  historical_values: [{ date: "2026-10-01", value: 9000 }, { date: "2026-10-15", value: 9500 }, { date: "2026-10-27", value: 10000 }],
});
const context = { userId: "synthetic-owner", vaultKey: "fixture-only", vaultOwnerToken: "fixture-only", getIdToken: async () => "fixture-only", isCurrent: () => true };
const capture = () => context;
export function useFinanceShareContext() { return { capture, session: "synthetic-session", ready: true }; }
export async function readSavedFinance() { return { model: sharingModel, source: { kind: "statement" as const, snapshotId: null }, sourceFence: "a".repeat(64) }; }
export function pendingFinanceShare() { return null; }
const people = [{ userId: "synthetic-recipient", displayName: "Sample connection", publicPersonRef: "11111111-1111-4111-8111-111111111111", keyId: "synthetic-key", publicKeyJwk: { kty: "EC" } }];
people.push(...Array.from({ length: 24 }, (_, index) => ({ ...people[0]!, userId: `synthetic-${index}`, displayName: `Other connection ${index + 1}` })));
const basePolicy: FinancePolicy = { version: 1, mode: "snapshot", sections: ["allocation", "performance"], showAmounts: false, selectionHash: "a".repeat(64), model_processing: { version: 1, allowed: true }, durationSeconds: 86400 };
const stamp = new Date().toISOString();
function grant(direction: "outgoing" | "received", policy = basePolicy): FinanceGrant {
  return { id: "22222222-2222-4222-8222-222222222222", requestId: "33333333-3333-4333-8333-333333333333", ownerUserId: "synthetic-owner", recipientUserId: "synthetic-recipient", recipientPersonRef: people[0]!.publicPersonRef, recipientKeyId: "synthetic-key", senderName: "Sample sender", recipientName: "Sample connection", policy, revision: 1, contentHash: "b".repeat(64), createdAt: stamp, updatedAt: stamp, expiresAt: new Date(Date.now() + 3600000).toISOString(), serverNow: new Date().toISOString(), direction,
    status: document.body.dataset.financeEnded === "true" ? "stopped" : "active" };
}
const received = projectFinance(sharingModel, { sections: basePolicy.sections, holdingSymbols: [], showAmounts: false, note: "" }, { kind: "statement", snapshotId: null });
let sent: FinanceGrant[] = [];
export const FinanceSharingService = {
  recipients: async () => ({ items: people, hasMore: false, page: 1 }),
  history: async (_context: unknown, direction: "outgoing" | "received") => ({ items: direction === "received" ? [grant("received")] : sent, nextCursor: null }),
  prepare: async (_context: unknown, _config: unknown, _projection: unknown, policy: FinancePolicy) => ({ requestId: grant("outgoing").requestId, policy }),
  publish: async (_context: unknown, prepared: { policy: FinancePolicy }) => {
    document.body.dataset.financePublishes = String(Number(document.body.dataset.financePublishes || 0) + 1);
    sent = [grant("outgoing", prepared.policy)]; return { items: sent };
  },
  view: async () => grant("received"),
  decrypt: async () => received,
  stop: async () => { document.body.dataset.financeEnded = "true"; return { stopped: true }; },
  review: async () => { document.body.dataset.financeReviews = "1"; return "Synthetic review: the shared allocation is concentrated in equities."; },
};
