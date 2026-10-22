/** Stripe owns onboarding and bank edits; validate again at the navigation boundary. */
export function documentPayoutLinkUrl(value: unknown, purpose: "onboarding" | "management"): string {
  if (typeof value !== "string") throw new Error("Invalid payout link");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid payout link"); }
  const allowed = purpose === "management"
    ? ["stripe.com", "connect.stripe.com"].includes(url.hostname) && /^\/express\/.+/.test(url.pathname)
    : url.hostname === "connect.stripe.com";
  if (url.protocol !== "https:" || !allowed || url.username || url.password || url.port) {
    throw new Error("Invalid payout link");
  }
  return url.href;
}
