import { applyConnectionLink, applySnapshot } from "@/lib/kai/plaid-vault/projection";
import type { FinancialDomain } from "@/lib/kai/plaid-vault/types";
import { FIRST_PLATYPUS, NOW, firstPlatypusSnapshot } from "./fixtures";

export const EARLIER = "2026-09-23T11:00:00.000Z";

export function link(
  financial: FinancialDomain | null,
  itemId: string,
  institution: { id: string; name: string },
  now = EARLIER
): FinancialDomain {
  return applyConnectionLink(
    financial,
    {
      item_id: itemId,
      access_token: `access-sandbox-${itemId}-secret`,
      institution,
      products: ["transactions", "investments"],
    },
    now
  );
}

export function linkedFirstPlatypus(itemId = "item_fp_a", prefix = "fpa", base: FinancialDomain | null = null) {
  const snapshot = firstPlatypusSnapshot(itemId, prefix);
  const linked = link(base, itemId, FIRST_PLATYPUS);
  return { snapshot, financial: applySnapshot(linked, itemId, snapshot, NOW) };
}
