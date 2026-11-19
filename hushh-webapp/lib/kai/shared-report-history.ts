import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
import { SharedAnalysisReportStore, type ReportAccess } from "./shared-report-store";
import type { SharedReport } from "./shared-report-contract";

let cached: { owner: string; vault: number; auth: number | null; key: string;
  until: number; value: Promise<SharedReport[]> } | null = null;
export function invalidateSharedReports(): void { cached = null; }
let observing = false;

/** Coalesce private reads while typing; every result is independently rechecked on open. */
export function sharedReportHistory(access: ReportAccess): Promise<SharedReport[]> {
  if (!observing && typeof window !== "undefined") {
    observing = true;
    subscribeAuthSessionGeneration(invalidateSharedReports);
    subscribeVaultSessionEpoch(invalidateSharedReports);
    subscribeDurableOwnerReset(owner => { if (cached?.owner === owner) invalidateSharedReports(); });
  }
  const vault = snapshotVaultSessionEpoch(), auth = getAuthSessionGeneration();
  if (cached?.owner === access.userId && cached.vault === vault && cached.auth === auth &&
    cached.key === access.vaultKey && cached.until > Date.now()) return cached.value;
  const value = (async () => {
    const store = await SharedAnalysisReportStore.open(access);
    const values: SharedReport[] = [];
    const seen = new Set<string>();
    let cursor = "";
    do {
      if (!access.isCurrent()) throw new DOMException("Report access changed", "AbortError");
      const page = await store.page(cursor);
      values.push(...page.values);
      cursor = page.cursor;
      if (cursor && seen.has(cursor)) throw new Error("Report history could not be checked.");
      seen.add(cursor);
    } while (cursor);
    if (!access.isCurrent()) throw new DOMException("Report access changed", "AbortError");
    return values;
  })();
  const owned = { owner: access.userId, vault, auth, key: access.vaultKey, until: Date.now() + 10_000, value };
  cached = owned;
  void value.catch(() => { if (cached === owned) cached = null; });
  return value;
}
