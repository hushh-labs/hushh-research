/**
 * Build-time availability of the Payment Cards surface. Mirrors the backend
 * ONE_PAYMENT_CARDS_ENABLED runtime setting; both default off. Follow the
 * client-env-parity rule: this NEXT_PUBLIC var must be set per build lane.
 */
export function isPaymentCardsBuildEnabled(): boolean {
  return (
    String(process.env.NEXT_PUBLIC_ONE_PAYMENT_CARDS_ENABLED ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}
