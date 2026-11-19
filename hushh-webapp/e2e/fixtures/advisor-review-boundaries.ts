// Synthetic transport/source only. The request, workspace and recovery UI are production components.
import type { AdvisorReview, AdvisorSnapshot } from "@/lib/advisor-review/contract";

export const reviewId = "55555555-5555-4555-8555-555555555555";
export const sampleAdvisorSnapshot: AdvisorSnapshot = { schema: "advisor-finance-snapshot-v1", capturedAt: "2026-11-02T12:00:00Z", source: "statement", period: "October statement", total: 10000, cash: 1000,
  holdings: [{ symbol: "TEST", name: "Synthetic Company", value: 9000, quantity: 10, costBasis: 8000, sector: "Technology", assetType: "Equity" }], allocation: [{ name: "Equity", value: 9000 }, { name: "Cash", value: 1000 }], history: [], profile: { horizon: "long_term", risk: "balanced", drawdown: null, volatility: null }, nonce: "a".repeat(64) };
export const captureAdvisorSnapshot = async () => sampleAdvisorSnapshot;
export const snapshotInformation = (snapshot: AdvisorSnapshot) => snapshot;
export function reviewFixtureContext(advisor = false) { return { userId: advisor ? "synthetic-advisor" : "synthetic-owner", vaultKey: "synthetic", vaultOwnerToken: "synthetic", getIdToken: async () => "synthetic", isCurrent: () => document.body.dataset.advisorRetired !== "true" }; }
export function sampleReview(viewer: string): AdvisorReview {
  const accepted = document.body.dataset.advisorStage === "accepted";
  const meeting = document.body.dataset.advisorMeeting === "agreed" ? { id: reviewId, status: "agreed" as const, startAt: new Date(Date.now() + 86400000).toISOString(), endAt: new Date(Date.now() + 88200000).toISOString(), timeZone: "UTC" } : null;
  return { id: reviewId, ownerUserId: "synthetic-owner", ownerPersonRef: "22222222-2222-4222-8222-222222222222", advisorUserId: "synthetic-advisor", advisorPersonRef: "11111111-1111-4111-8111-111111111111", ownerName: "Sample investor", advisorName: "Sample advisor", direction: viewer === "synthetic-owner" ? "outgoing" : "received", status: accepted ? "accepted" : "pending", introduction: "Please review my portfolio allocation.", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), serverNow: new Date().toISOString(), contentHash: "a".repeat(64), snapshotAvailable: accepted, meeting, plan: null, planRevision: 0 };
}
export class AdvisorReviewError extends Error { constructor(readonly code: string, readonly status = 0) { super(code === "ADVISOR_CONNECT_CALENDAR" ? "Connect Google Calendar and allow scheduling before booking. Your request is saved." : "This request could not be confirmed. Check its status before retrying."); } }
export async function advisorRequest(
  _context: unknown, path: string, _method: string,
  body: { scope?: string; query?: string } = {},
) {
  if (path === "/portfolio-analysis") {
    document.body.dataset.portfolioReviewCalls = String(Number(document.body.dataset.portfolioReviewCalls || 0) + 1);
    if (document.body.dataset.portfolioReviewFailed === "true") throw new Error("Provider unavailable");
    return { score: 72, takeaway: "One holding dominates this snapshot.", reason: "The position makes up most of the saved allocation.", next_step: "Compare that weight with your plan.", advisor_reason: null };
  }
  document.body.dataset.advisorCandidateScope = body.scope;
  const name = body.scope === "global" ? "Distant advisor"
    : body.scope === "nearby" ? "Local advisor" : "Sample advisor";
  return { items: [{ userId: "synthetic-advisor", personRef: "11111111-1111-4111-8111-111111111111", name, bio: "Verified synthetic advisor", crd: "123456", verified: true, keyId: "synthetic-key", publicKeyJwk: { kty: "EC" }, ready: true }], directory: null, hasMore: false };
}
export const AdvisorReviewService = {
  view: async (context: { userId: string }) => sampleReview(context.userId),
  decrypt: async () => { document.body.dataset.advisorDecrypts = String(Number(document.body.dataset.advisorDecrypts || 0) + 1); if (document.body.dataset.advisorStage !== "accepted") throw new Error("Snapshot locked"); return sampleAdvisorSnapshot; },
  decide: async (context: { userId: string }, _id: string, action: string) => { if (action === "accept") document.body.dataset.advisorStage = "accepted"; return sampleReview(context.userId); },
  meeting: async () => { throw new AdvisorReviewError("ADVISOR_CONNECT_CALENDAR", 409); },
  prepare: async () => { document.body.dataset.advisorPrepares = String(Number(document.body.dataset.advisorPrepares || 0) + 1); return { requestId: reviewId }; },
  send: async (context: { userId: string }, body: { requestId: string }) => { const calls = Number(document.body.dataset.advisorSends || 0) + 1; document.body.dataset.advisorSends = String(calls); document.body.dataset.advisorSentId = body.requestId; if (calls === 1 && document.body.dataset.advisorAck === "uncertain") throw new AdvisorReviewError("ADVISOR_UNCERTAIN", 503); return sampleReview(context.userId); },
};
