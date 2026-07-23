/**
 * Browser-side Google Maps key. This is a SEPARATE, referrer-restricted key
 * (Maps JavaScript API only) — never the server-side GOOGLE_MAPS_API_KEY used
 * by the backend Places/Routes proxy. When absent, callers fall back to the
 * iframe embed.
 */
export function getBrowserMapsApiKey(): string {
  const browserKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY ?? "").trim();
  return browserKey || (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "").trim();
}

export function isBrowserMapsConfigured(): boolean {
  return getBrowserMapsApiKey().length > 0;
}

/**
 * Native Maps SDK credentials are intentionally distinct from referrer-bound
 * browser credentials. These values are bundled only into their respective
 * signed apps and must be restricted by bundle/package identity in Google
 * Cloud; the backend Places key is never used here.
 */
export function getNativeMapsApiKey(platform: "ios" | "android"): string {
  const configured =
    platform === "ios"
      ? process.env.NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY
      : process.env.NEXT_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY;
  return (configured ?? "").trim();
}
