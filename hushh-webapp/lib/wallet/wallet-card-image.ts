import { encodeQrCode } from "@/components/wallet-card/qr-code";
import { loadWalletCardArtwork, type WalletCardArtworkKind } from "@/lib/services/wallet-card-artwork-service";
import { walletProfileUsername } from "@/lib/wallet/wallet-profile-username";

export type WalletCardImageKind = WalletCardArtworkKind;
export type WalletCardImageIdentity = {
  ownerId?: string;
  displayName: string | null;
  cardPayload?: { username?: string | null } | null;
  shareUrl: string | null;
  referralUrl?: string | null;
  memberSince?: string | null;
  walletId?: string | null;
};
export type WalletCardImageRequest = {
  kind: WalletCardImageKind;
  profile: WalletCardImageIdentity | null | undefined;
  signal?: AbortSignal;
};

export const WALLET_CARD_IMAGE_WIDTH = 1080;
export const WALLET_CARD_IMAGE_HEIGHT = 681;
export const NWS_SAMPLE_DESCRIPTION = "Sample NWS score: 900 out of 1000. This is not an evaluated net worth score.";

/** This projection is shared by the rendered face, its accessible text and PNG export. */
export function walletCardImageFields(profile: WalletCardImageIdentity | null | undefined) {
  const username = profile?.cardPayload?.username || walletProfileUsername(profile?.displayName ?? "");
  const date = profile?.memberSince ? new Date(profile.memberSince) : null;
  return {
    username,
    memberSince: date && !Number.isNaN(date.getTime()) ? String(date.getFullYear()) : "—",
    walletId: profile?.walletId ? profile.walletId.slice(-8).toUpperCase() : "—",
  };
}

/** Ephemeral render identity, never persisted or used as a cache of personal information. */
export function walletCardImageKey(kind: WalletCardImageKind, profile: WalletCardImageIdentity | null | undefined): string {
  return JSON.stringify([kind, profile?.ownerId, walletCardImageFields(profile), kind === "referral" ? profile?.referralUrl : kind === "profile" ? profile?.shareUrl : null]);
}

function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Card image generation cancelled.", "AbortError");
}

function qrSvg(value: string | null | undefined): string {
  if (!value) return '<text x="210" y="350" text-anchor="middle" fill="#8b8b8b" font-size="24">QR unavailable</text>';
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("The card link is unavailable.");
  }
  const matrix = encodeQrCode(value);
  const extent = matrix.size + 8;
  const runs: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    let start = -1;
    for (let x = 0; x <= matrix.size; x += 1) {
      const dark = x < matrix.size && matrix.modules[y * matrix.size + x] === 1;
      if (dark && start < 0) start = x;
      else if (!dark && start >= 0) {
        runs.push(`M${start + 4} ${y + 4}h${x - start}v1H${start + 4}z`);
        start = -1;
      }
    }
  }
  // Keep the QR physically square while the supplied 1080×650 artwork fills
  // the physical card's 1080×681 frame. The quiet zone is four modules.
  return `<svg x="100" y="235" width="220" height="${220 * 650 / WALLET_CARD_IMAGE_HEIGHT}" viewBox="0 0 ${extent} ${extent}" preserveAspectRatio="none" shape-rendering="crispEdges" data-wallet-qr="true"><rect width="${extent}" height="${extent}" fill="#fff"/><path fill="#000" d="${runs.join("")}"/></svg>`;
}

function identitySvg(kind: WalletCardImageKind, profile: WalletCardImageIdentity | null | undefined): string {
  const { username, memberSince, walletId } = walletCardImageFields(profile);
  const nws = kind === "nws";
  const label = kind === "referral" ? "#6B5326" : nws ? "#9DBFA9" : "#7E7260";
  const value = kind === "referral" ? "#2E2008" : nws ? "#F2EFE3" : "#C9A96A";
  const usernameFit = username.length > (nws ? 10 : 17) ? ` textLength="${nws ? 220 : 416}" lengthAdjust="spacingAndGlyphs"` : "";
  return `<g data-wallet-identity="true" font-family="WalletLexend,system-ui,sans-serif">
    <g fill="${label}" font-size="14" font-weight="500" letter-spacing="4.48">
      <text x="${nws ? 100 : 402}" y="${nws ? 449 : 281}">USERNAME</text>
      <text x="${nws ? 390 : 402}" y="${nws ? 449 : 414}">MEMBER SINCE</text>
      <text x="${nws ? 640 : 650}" y="${nws ? 449 : 414}">WALLET ID</text>
    </g>
    ${nws ? '<g fill="none" stroke="#3F7A5E" stroke-opacity=".7" stroke-width="1.5"><line x1="344" y1="428" x2="344" y2="507"/><line x1="594" y1="428" x2="594" y2="507"/></g>' : ""}
    <g fill="${value}" font-weight="600">
      <text x="${nws ? 100 : 400}" y="${nws ? 495 : 337}" font-size="28" letter-spacing="4.48"${usernameFit}>${escaped(username)}</text>
      <text x="${nws ? 390 : 402}" y="${nws ? 495 : 461}" font-size="32" letter-spacing="1.28">${escaped(memberSince)}</text>
      <text x="${nws ? 640 : 650}" y="${nws ? 495 : 461}" font-size="32" letter-spacing="1.28">${escaped(walletId)}</text>
    </g>
  </g>`;
}

/** The only composition path: all artwork, fonts, live text and QR are one image. */
export async function buildWalletCardSvg({ kind, profile, signal }: WalletCardImageRequest): Promise<string> {
  checkAbort(signal);
  // Capture the caller's current values before crossing an async boundary.
  const fields = identitySvg(kind, profile);
  const qr = kind === "nws" ? "" : qrSvg(kind === "referral" ? profile?.referralUrl : profile?.shareUrl);
  const artwork = await loadWalletCardArtwork(kind);
  checkAbort(signal);
  return artwork.replace(/<\/svg>\s*$/, `${fields}${qr}</svg>`);
}

/** A local PNG File of exactly the card face, with no network upload or retained personal cache. */
export async function createWalletCardImageFile(request: WalletCardImageRequest): Promise<File> {
  if (request.kind !== "nws" && !(request.kind === "referral" ? request.profile?.referralUrl : request.profile?.shareUrl)) {
    throw new Error("Your card link is not ready yet.");
  }
  const svg = await buildWalletCardSvg(request);
  checkAbort(request.signal);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { image.src = ""; cleanup(); reject(new DOMException("Card image generation cancelled.", "AbortError")); };
      const timeout = setTimeout(() => { cleanup(); image.src = ""; reject(new Error("The card image took too long to prepare.")); }, 12000);
      const cleanup = () => { clearTimeout(timeout); image.onload = null; image.onerror = null; request.signal?.removeEventListener("abort", aborted); };
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(new Error("The card image could not be prepared.")); };
      request.signal?.addEventListener("abort", aborted, { once: true });
      image.src = url;
    });
    checkAbort(request.signal);
    const canvas = document.createElement("canvas");
    canvas.width = WALLET_CARD_IMAGE_WIDTH;
    canvas.height = WALLET_CARD_IMAGE_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image sharing is unavailable on this device.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("The card image could not be saved.")), "image/png");
    });
    checkAbort(request.signal);
    return new File([blob], `agent-one-${request.kind}.png`, { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
