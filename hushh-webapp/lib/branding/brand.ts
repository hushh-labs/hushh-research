/**
 * The brand name, for user-facing copy.
 *
 * `hushh` stays correct and load-bearing as an *identifier* — bundle ids
 * (`com.hushh.app`), domains (`one.hushh.ai`), service-worker message types
 * (`hushh:fcm_push_received`), storage keys, env vars, package and repo names.
 * None of those are prose and none of them move. This constant is only for text
 * a person reads.
 *
 * It exists because the connection-request sentence was authored three times —
 * twice in Python and once as a JSX literal — and the notification surface kept
 * the pre-rebrand spelling long after the rest of the product moved on. Nothing
 * connected the copies, and the docs brand gate only looks for capitalised
 * `Hushh`, so the lowercase form was invisible to CI. See issue #5422.
 */
export const BRAND_NAME = "Hussh";
export const PRODUCT_NAME = "Hussh One";

/**
 * What a notification says when the requester genuinely cannot be named.
 * Shared with the backend's `GENERIC_REQUESTER_LABEL` so the two surfaces
 * degrade to the same word.
 */
export const GENERIC_REQUESTER_LABEL = "Someone";

/**
 * The connection-request sentence.
 *
 * Mirrors `hushh_mcp.branding.connection_request_body` on the backend, which
 * composes the OS banner. The two must agree: on web with the tab visible the
 * user can see both surfaces at once, and they used to disagree — the system
 * banner named the requester while the in-app toast said "Someone".
 *
 * A blank or whitespace-only label degrades to the generic line rather than
 * rendering " wants to connect…" with a hole where the name should be.
 */
export function connectionRequestBody(requesterLabel?: string | null): string {
  const label = String(requesterLabel || "").trim() || GENERIC_REQUESTER_LABEL;
  return `${label} wants to connect with you on ${BRAND_NAME}.`;
}
