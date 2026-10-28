/** Closed Profile ancestry; no operations, URLs or credentials. */
export type NativePayoutPageId = "payouts" | "commerce-funding" | "commerce-payouts" | "commerce-refunds" | "commerce-history" | "commerce-receipt" | "commerce-review" | "payout-activity" | "payout-stripe" | `payout-receipt-${1 | 2 | 3 | 4 | 5 | 6}`;
export type NativeAgentSettingsPageId = "hosting" | "software-updates" | "update-notes" | "update-verification" | "browser-review" | "browser-policy";

/** Closed financial presentation ancestry; never admits arbitrary destinations. */
export function validNativePayoutPath(pages: readonly { id: string }[]): boolean {
  if (pages[0]?.id !== "payouts" || pages.length > 8) return false;
  if (typeof pages[1]?.id === "string" && pages[1].id.startsWith("commerce-")) return [["payouts", "commerce-funding"], ["payouts", "commerce-payouts"], ["payouts", "commerce-refunds"], ["payouts", "commerce-history"], ["payouts", "commerce-history", "commerce-receipt"],
    ["payouts", "commerce-review"], ["payouts", "commerce-payouts", "commerce-review"], ["payouts", "commerce-refunds", "commerce-review"]].some(path => path.length === pages.length && path.every((id, index) => pages[index]?.id === id));
  const start = ["payout-activity", "payout-stripe"].includes(pages[1]?.id ?? "") ? 2 : 1;
  return pages.slice(start).every((page, index) => page?.id === `payout-receipt-${index + 1}`) && pages.length - start <= 6;
}

export function validNativeAgentSettingsPath(pages: readonly { id: string }[]): boolean {
  return [["hosting"], ["software-updates"], ["software-updates", "update-notes"], ["software-updates", "update-verification"],
    ["software-updates", "browser-review"], ["software-updates", "browser-review", "browser-policy"]].some(path => path.length === pages.length && path.every((id, index) => pages[index]?.id === id));
}

