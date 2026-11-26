import type { LeaderboardEntry } from "@/lib/services/referral-service";

/** Only the server's viewer-permitted profile projection can replace a missing alias. */
export function referralDisplayName(entry: Pick<LeaderboardEntry, "handle" | "display_name">): string {
  const alias = entry.handle.trim();
  if (alias && alias !== "Anonymous referrer") return alias;
  return entry.display_name?.trim() || "Name unavailable";
}
