import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { SavedPortfolioReview } from "./portfolio-review-cache";

type ReviewApproval = { scope: string; sourceFence: string };
type ReviewSession = { approval: ReviewApproval; cached?: SavedPortfolioReview };
let session: ReviewSession | null = null;
const listeners = new Set<() => void>();

export const getReviewSession = () => session;
export function setReviewSession(value: ReviewSession | null) {
  session = value;
  for (const listener of listeners) listener();
}
export function subscribeReviewSession(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
if (typeof window !== "undefined") {
  subscribeVaultSessionEpoch(() => setReviewSession(null));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setReviewSession(null);
  });
}
