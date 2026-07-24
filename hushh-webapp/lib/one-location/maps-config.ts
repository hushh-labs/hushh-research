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

/**
 * Google Maps "night" styling for the native immersive map so "Your Map" opens
 * dark, matching the mobile dark theme. Cloud-styled map IDs are the long-term
 * path; this inline array keeps the dark surface self-contained without a Google
 * Cloud console dependency. Applied only when the app is in dark mode.
 */
export const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#212121" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#212121" }] },
  {
    featureType: "administrative",
    elementType: "geometry",
    stylers: [{ color: "#757575" }],
  },
  {
    featureType: "administrative.country",
    elementType: "labels.text.fill",
    stylers: [{ color: "#9e9e9e" }],
  },
  {
    featureType: "administrative.land_parcel",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#bdbdbd" }],
  },
  {
    featureType: "poi",
    elementType: "labels.text.fill",
    stylers: [{ color: "#757575" }],
  },
  {
    featureType: "poi.park",
    elementType: "geometry",
    stylers: [{ color: "#181818" }],
  },
  {
    featureType: "poi.park",
    elementType: "labels.text.fill",
    stylers: [{ color: "#616161" }],
  },
  {
    featureType: "road",
    elementType: "geometry.fill",
    stylers: [{ color: "#2c2c2c" }],
  },
  {
    featureType: "road",
    elementType: "labels.text.fill",
    stylers: [{ color: "#8a8a8a" }],
  },
  {
    featureType: "road.arterial",
    elementType: "geometry",
    stylers: [{ color: "#373737" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#3c3c3c" }],
  },
  {
    featureType: "road.highway.controlled_access",
    elementType: "geometry",
    stylers: [{ color: "#4e4e4e" }],
  },
  {
    featureType: "road.local",
    elementType: "labels.text.fill",
    stylers: [{ color: "#616161" }],
  },
  {
    featureType: "transit",
    elementType: "labels.text.fill",
    stylers: [{ color: "#757575" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#000000" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#3d3d3d" }],
  },
];
