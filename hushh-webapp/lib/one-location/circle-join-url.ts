/**
 * Build a clickable Circle join link that carries the invite code, e.g.
 * `https://uat.one.hushh.ai/circle/join?code=96RE-HUNF-KMVX`.
 *
 * The `/circle/join` route reads the `code` query param and forwards into the
 * in-app "Join with code" flow with the field pre-filled, so a recipient can tap
 * the link instead of copy-pasting the raw code.
 */
export const CIRCLE_JOIN_CODE_PARAM = "code";

export function buildCircleJoinUrl(origin: string, code: string): string {
  const base = String(origin || "").replace(/\/+$/, "");
  const trimmedCode = String(code || "").trim();
  const query = trimmedCode
    ? `?${CIRCLE_JOIN_CODE_PARAM}=${encodeURIComponent(trimmedCode)}`
    : "";
  return `${base}/circle/join${query}`;
}
