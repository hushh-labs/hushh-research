import { financeReference } from "./contract";
import { walletMessagePreview } from "@/lib/wallet/wallet-card-share";

export function connectionMessagePreview(content: string): string {
  return financeReference(content) ? "Shared Finance" : walletMessagePreview(content);
}
