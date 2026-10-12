/**
 * The one rule for an uploaded Wallet Profile photo.
 *
 * `POST /account/avatar` stores a custom photo as a PNG/JPEG/WebP data URL of at
 * most 300 KB decoded. A visitor may be shown it because `<img>` never executes
 * a data URL; SVG, HTML and anything oversized are refused. https links keep
 * using the feature's existing link rule.
 */
const DATA_URL = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL_MAX_LENGTH = 420_000;

/** Read one past the cap so an oversized photo is rejected, never truncated. */
export const WALLET_AVATAR_READ_LIMIT = DATA_URL_MAX_LENGTH + 1;

export function isWalletAvatarDataUrl(value: string): boolean {
  return value.length <= DATA_URL_MAX_LENGTH && DATA_URL.test(value);
}

/** `value` when it is an acceptable photo; `httpsRule` decides every non-data value. */
export function pickWalletAvatarUrl(
  value: string | null,
  httpsRule: (value: string | null) => string | null,
): string | null {
  if (!value) return null;
  if (value.startsWith("data:")) return isWalletAvatarDataUrl(value) ? value : null;
  return httpsRule(value);
}
