import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";

export type ReleaseNotice = {
  id: string;
  title: string;
  description: string;
  changes: readonly string[];
};

export type ManagedAppRelease = ReleaseNotice & { publishedAt: string };

// Authored with this frontend, independently of pod image offers. UAT and
// production activation require their own reviewed publication date and copy.
const DEV_RELEASE: ManagedAppRelease = {
  id: "app:dev:2026-10-07:private-cloud",
  publishedAt: "2026-10-07T00:00:00Z",
  title: "What’s new in One",
  description: "More control over your private agent.",
  changes: [
    "Set up your private agent in your own cloud from Hosting.",
    "Choose when to install software updates on your pod.",
    "Your current hosting stays in place.",
  ],
};

export function currentManagedAppRelease(appUrl = process.env.NEXT_PUBLIC_APP_URL): ManagedAppRelease | null {
  try {
    return new URL(appUrl ?? "").origin === "https://dev.one.hushh.ai" ? DEV_RELEASE : null;
  } catch {
    return null;
  }
}

/** Unknown or synthetic account dates never establish a catch-up audience. */
export function managedReleaseAudience(state: PreVaultUserState, release: ManagedAppRelease): "existing" | "new" | "unknown" {
  const dates = [state.firstLoginAt, state.createdAt].filter((date): date is number => typeof date === "number" && Number.isFinite(date) && date > 0);
  const firstUse = dates.length ? Math.min(...dates) : null;
  const published = Date.parse(release.publishedAt);
  if (!firstUse || !Number.isFinite(firstUse) || !Number.isFinite(published)) return "unknown";
  return firstUse < published ? "existing" : "new";
}
