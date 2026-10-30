/**
 * Whether an advisor's recorded status counts as verified. Shared by the
 * route-level verification gate and by navigation that must not advertise
 * RIA-only surfaces (Picks) to people who are not verified advisors.
 */
const VERIFIED_STATUSES = new Set(["active", "verified", "finra_verified"]);

export function isRiaVerified(status?: string | null): boolean {
  return VERIFIED_STATUSES.has(String(status || "").toLowerCase());
}

/** The status field the gate reads: advisory first, then the generic one. */
export function riaVerificationStatusOf(
  status:
    | { advisory_status?: string | null; verification_status?: string | null }
    | null
    | undefined,
): string | null | undefined {
  return status?.advisory_status || status?.verification_status;
}
