/**
 * Build a clickable Circle join link that carries the invite code, e.g.
 * `https://uat.one.hushh.ai/circle/join?code=96RE-HUNF-KMVX`.
 *
 * The `/circle/join` route reads the `code` query param and forwards into the
 * in-app "Join with code" flow with the field pre-filled, so a recipient can tap
 * the link instead of copy-pasting the raw code.
 */
export const CIRCLE_JOIN_CODE_PARAM = "code";

/**
 * Group a code the way it is shown everywhere else (`96RE-HUNF-KMVX`).
 *
 * A link can carry the code in any casing or spacing, so the landing page
 * normalises before grouping -- a code pasted from a message should look
 * identical to the one the sender is reading off their own screen.
 */
export function formatCircleCodeForDisplay(raw: string): string {
  const normalized = String(raw || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  return normalized.replace(/(.{4})(?=.)/g, "$1-");
}

export function buildCircleJoinUrl(origin: string, code: string): string {
  const base = String(origin || "").replace(/\/+$/, "");
  const trimmedCode = String(code || "").trim();
  const query = trimmedCode
    ? `?${CIRCLE_JOIN_CODE_PARAM}=${encodeURIComponent(trimmedCode)}`
    : "";
  return `${base}/circle/join${query}`;
}
