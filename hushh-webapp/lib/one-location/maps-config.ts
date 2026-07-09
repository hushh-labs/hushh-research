/**
 * Browser-side Google Maps key. This is a SEPARATE, referrer-restricted key
 * (Maps JavaScript API only) — never the server-side GOOGLE_MAPS_API_KEY used
 * by the backend Places/Routes proxy. When absent, callers fall back to the
 * iframe embed.
 */
export function getBrowserMapsApiKey(): string {
  return (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "").trim();
}

export function isBrowserMapsConfigured(): boolean {
  return getBrowserMapsApiKey().length > 0;
}
