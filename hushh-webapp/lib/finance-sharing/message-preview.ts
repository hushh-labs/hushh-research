import { advisorReviewReference } from "@/lib/advisor-review/contract";
import { financeReference } from "./contract";
import { walletMessagePreview } from "@/lib/wallet/wallet-card-share";

export function connectionMessagePreview(content: string): string {
  return advisorReviewReference(content) ? "Advisor introduction" : financeReference(content) ? "Shared Finance" : walletMessagePreview(content);
}
