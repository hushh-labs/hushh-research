"use client";

import { requireFinanceSession, type FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { selectLinkedNetWorthScore } from "./nws";
import type { LinkedNetWorthScore } from "./types";
import { loadFinancialForVault } from "./vault-sync";

/** Reads the saved Plaid score inside the current unlocked owner session. */
export async function readLinkedNetWorthScore(context: FinanceShareContext): Promise<LinkedNetWorthScore | null> {
  requireFinanceSession(context);
  const financial = await loadFinancialForVault(context);
  requireFinanceSession(context);
  return selectLinkedNetWorthScore(financial);
}
