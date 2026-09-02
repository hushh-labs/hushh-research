/**
 * Build-time availability of the Wallet surface. Mirrors the backend
 * ONE_WALLET_ENABLED runtime setting; both default off. Follow the
 * client-env-parity rule: this NEXT_PUBLIC var must be set per build lane.
 */
export function isWalletBuildEnabled(): boolean {
  return (
    String(process.env.NEXT_PUBLIC_ONE_WALLET_ENABLED ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}
