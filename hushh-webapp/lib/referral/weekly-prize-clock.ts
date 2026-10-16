import type { WeeklyChallenge } from "@/lib/services/referral-service";

/** Prize timing must come from the server and a monotonic receipt anchor. */
export function weeklyPrizeRemainingMs(challenge: WeeklyChallenge | null, monotonicNow: number): number | null {
  if (!challenge?.active || challenge.campaign_active !== true || challenge.weekly_prizes_enabled !== true) return null;
  const cutoff = Date.parse(challenge.cutoff_at ?? "");
  const server = Date.parse(challenge.server_now ?? "");
  const received = challenge.received_at_monotonic;
  const transit = challenge.estimated_transit_ms ?? 0;
  if (!Number.isFinite(cutoff) || !Number.isFinite(server) || received === undefined ||
      !Number.isFinite(received) || !Number.isFinite(monotonicNow) || monotonicNow < received ||
      !Number.isFinite(transit) || transit < 0) return null;
  return Math.max(0, cutoff - server - transit - (monotonicNow - received));
}

export function formatWeeklyPrizeCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "—";
  const seconds = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(seconds / 86_400);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${days ? `${days}d ` : ""}${pad(Math.floor(seconds / 3600) % 24)}h ${pad(Math.floor(seconds / 60) % 60)}m ${pad(seconds % 60)}s`;
}
