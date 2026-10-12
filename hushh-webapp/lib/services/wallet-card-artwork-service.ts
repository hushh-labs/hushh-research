/** Public, immutable card art only. Owner fields and QR links never enter this cache. */
export type WalletCardArtworkKind = "profile" | "referral" | "nws";

const artworkLoads = new Map<WalletCardArtworkKind, Promise<string>>();

export function loadWalletCardArtwork(kind: WalletCardArtworkKind): Promise<string> {
  const existing = artworkLoads.get(kind);
  if (existing) return existing;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const request = fetch(`/wallet/artwork/${kind}-v1.svg`, {
    credentials: "omit",
    cache: "force-cache",
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error("Card artwork could not be loaded.");
    const source = await response.text();
    if (!source.startsWith("<svg ") || !source.trimEnd().endsWith("</svg>")) {
      throw new Error("Card artwork could not be read.");
    }
    return source;
  }).catch((error: unknown) => {
    artworkLoads.delete(kind);
    throw error;
  }).finally(() => clearTimeout(timeout));
  artworkLoads.set(kind, request);
  return request;
}
