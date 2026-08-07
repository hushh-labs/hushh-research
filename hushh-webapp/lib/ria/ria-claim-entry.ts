/**
 * Recognising an adviser from the number they already typed.
 *
 * The number a user enters at sign-up IS the trigger for claiming: if the SEC
 * lists a firm or advisers at it, we surface the claim instead of making the
 * person discover a "claim" feature on their own. These helpers keep that
 * decision in one testable place, shared by the phone-mandate screen and the
 * claim screen.
 */

import { ROUTES } from "@/lib/navigation/routes";
import type { RiaClaimLookupResult } from "@/lib/services/ria-service";

/** Outcomes that mean "the SEC has something at this number worth claiming". */
const CLAIMABLE_OUTCOMES = new Set([
  "single_person",
  "few_candidates",
  "large_firm",
  "ambiguous_firm",
]);

export function isClaimableLookupOutcome(
  result: Pick<RiaClaimLookupResult, "outcome" | "firm" | "firms"> | null,
): boolean {
  if (!result) return false;
  const outcome = String(result.outcome ?? "");
  if (!CLAIMABLE_OUTCOMES.has(outcome)) return false;
  // An outcome without any firm attached is not something we can render.
  return Boolean(result.firm?.crd) || (result.firms?.length ?? 0) > 0;
}

/**
 * The account's verified number, in the order the sources are trustworthy.
 *
 * `identity.phone_number` is authoritative: it is what the backend recorded.
 * The auth context's `phoneNumber` is the hydrated copy of it. The Firebase
 * user object comes LAST because it is null in two common cases — a Google
 * sign-in (no phone credential is ever linked) and the backend test-code
 * confirmation path (which returns the unchanged user and only records the
 * phone server-side). Reading it first skips recognition exactly when an
 * adviser has just told us their number.
 */
export function resolveVerifiedPhone(sources: {
  identityPhone?: string | null;
  contextPhone?: string | null;
  firebasePhone?: string | null;
}): string {
  return toNanpDigits(
    sources.identityPhone || sources.contextPhone || sources.firebasePhone,
  );
}

/** Reduce any phone formatting to the 10-digit NANP number, or "". */
export function toNanpDigits(raw: string | null | undefined): string {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10 || digits[0] === "0" || digits[0] === "1") return "";
  return digits;
}

export function buildRiaClaimRoute(
  phone: string,
  options?: { returnTo?: string | null },
): string {
  const digits = toNanpDigits(phone);
  const params = new URLSearchParams();
  if (digits) params.set("phone", digits);
  const returnTo = String(options?.returnTo ?? "").trim();
  if (returnTo) params.set("return_to", returnTo);
  const query = params.toString();
  return query ? `${ROUTES.RIA_CLAIM}?${query}` : ROUTES.RIA_CLAIM;
}
