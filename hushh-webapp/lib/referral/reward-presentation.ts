import type { MilestoneProgress } from "../services/referral-service";

/** Product visibility never deletes an entitlement or invents a replacement. */
export function isAirPodsReward(title: string) { return title.startsWith("Apple AirPods"); }
export function rewardDisplayTitle(title: string) { return title === "$25 Amazon voucher" ? "Amazon voucher" : title; }
export function referralClaimStatus(milestone: MilestoneProgress["earned"][number]) {
  const states: Record<string, string> = { pending_review: "Awaiting review", approved: "Approved for fulfillment", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" };
  return `Claimed · ${states[milestone.fulfillment_status ?? ""] ?? "Awaiting fulfillment review"}`;
}

/** Both renderers use the published catalogue and recorded entitlements.
 * A threshold is progress, never permission to claim or fulfill a reward. */
export function referralRewardBoard(milestones: MilestoneProgress) {
  const catalogue = milestones.available_milestones;
  if (!catalogue?.length || !Number.isSafeInteger(milestones.joined_referral_count) || milestones.joined_referral_count < 0 ||
    new Set(catalogue.map(entry => entry.milestone_key)).size !== catalogue.length || catalogue.some(entry => !Number.isSafeInteger(entry.threshold) || entry.threshold <= 0)) return null;
  const earnedByKey = new Map(milestones.earned.map(entry => [entry.milestone_key, entry]));
  const ladder = [...catalogue].filter(entry => !isAirPodsReward(earnedByKey.get(entry.milestone_key)?.reward ?? entry.reward)).sort((a,b) => a.threshold - b.threshold);
  const next = milestones.next_milestone;
  return { earnedByKey, ladder, finalReward: ladder[ladder.length - 1], count: milestones.joined_referral_count, next,
    awaitingAward: next !== null && milestones.joined_referral_count >= next.threshold,
    earnedKeys: new Set(milestones.earned.map(entry => entry.milestone_key)),
    previousRewards: milestones.earned.filter(entry => !isAirPodsReward(entry.reward) && !ladder.some(item => item.milestone_key === entry.milestone_key)),
    nextLabel: next?.reward.split(/,?\s+worth\s+/i) ?? [] };
}
