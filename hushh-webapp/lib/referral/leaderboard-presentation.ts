import type { LeaderboardEntry } from "@/lib/services/referral-service";

/** The server's permitted Firebase name is authoritative; public aliases are a fallback. */
export function referralDisplayName(entry: Pick<LeaderboardEntry, "handle" | "display_name">): string {
  const name = entry.display_name?.trim();
  if (name) return name;
  const alias = entry.handle.trim();
  if (alias && alias !== "Anonymous referrer") return alias;
  return "Name unavailable";
}
