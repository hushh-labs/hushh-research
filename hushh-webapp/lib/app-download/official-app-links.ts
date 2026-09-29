/**
 * The published store listings for the Hussh One app (bundle `com.hushh.app`).
 *
 * The single source for every "Get the app" surface. An entry stays `null`
 * until its listing is public, and a `null` entry renders as unavailable: a
 * download link is never guessed, derived from the bundle id, or pointed at a
 * TestFlight or internal track.
 */
export type OfficialAppLinks = {
  ios: string | null;
  android: string | null;
};

export const OFFICIAL_APP_LINKS: OfficialAppLinks = {
  ios: null,
  android: null,
};

export type AppDownloadPlatform = "ios" | "android" | "other";

/** Coarse platform from a user agent, only to pick which listing to lead with. */
export function appDownloadPlatform(userAgent: string): AppDownloadPlatform {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  // iPadOS reports a desktop Mac user agent; touch support separates it.
  return "other";
}

export type AppDownloadTarget = { store: "ios" | "android"; label: string; href: string };

/** The listings to offer, the matching platform's first; empty when none is published. */
export function appDownloadTargets(
  links: OfficialAppLinks,
  platform: AppDownloadPlatform,
): AppDownloadTarget[] {
  const ios = links.ios ? { store: "ios" as const, label: "App Store", href: links.ios } : null;
  const android = links.android
    ? { store: "android" as const, label: "Google Play", href: links.android }
    : null;
  if (platform === "ios") return ios ? [ios] : [];
  if (platform === "android") return android ? [android] : [];
  return [ios, android].filter((target): target is AppDownloadTarget => target !== null);
}
