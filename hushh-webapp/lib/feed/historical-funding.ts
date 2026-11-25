import { z } from "zod";
import { ApiService } from "@/lib/services/api-service";
import { requireFinanceSession, type FinanceShareContext } from "@/lib/services/finance-sharing-service";

const status = z.enum(["completed", "failed", "returned"]);
const schema = z.object({
  items: z.array(z.object({
    itemId: z.string().regex(/^\d{1,19}$/),
    status,
    direction: z.enum(["deposit", "withdrawal", "transfer"]),
    recordedAt: z.string(),
    milestones: z.array(z.object({ status, recordedAt: z.string() })).max(3),
  })).max(50),
});
export type HistoricalFunding = z.infer<typeof schema>["items"][number];

export function historicalFundingTerms(query: string): string {
  // The server only needs transfer vocabulary and dates. Search terms about
  // encrypted holdings, statement names, or people stay on the device.
  const terms = query.toLowerCase().trim().split(/\s+/u);
  const allowed = /^(?:funding|transfer|historical|deposit|withdrawal|completed|failed|returned|\d{1,4}(?:-\d{1,2}){0,2}|january|february|march|april|may|june|july|august|september|october|november|december)$/u;
  return terms.every(term => allowed.test(term)) ? terms.join(" ") : "";
}

export async function loadHistoricalFunding(
  context: FinanceShareContext,
  selector: { item_id: string } | { query: string },
): Promise<HistoricalFunding[]> {
  requireFinanceSession(context);
  const firebaseToken = await context.getIdToken();
  requireFinanceSession(context);
  const response = await ApiService.apiFetch("/api/one/feed/funding-history", {
    method: "POST",
    cache: "no-store",
    headers: { Authorization: `Bearer ${firebaseToken}`, "X-Hushh-Consent": context.vaultOwnerToken },
    body: JSON.stringify(selector),
    isEffectCurrent: context.isCurrent,
  });
  requireFinanceSession(context);
  if (!response.ok) throw new Error("Transfer history could not be loaded.");
  const result = schema.parse(await response.json());
  requireFinanceSession(context);
  return result.items;
}

export function fundingStatusCopy(value: HistoricalFunding["status"]) {
  return value === "returned" ? "was returned" : value;
}
