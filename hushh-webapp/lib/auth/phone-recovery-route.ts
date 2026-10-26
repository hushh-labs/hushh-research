import { ROUTES } from "@/lib/navigation/routes";

/** A navigation hint only; the server independently checks the signed-in owner. */
export function phoneRecoveryId(value: string | null | undefined): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : null;
}

export function phoneRecoveryReviewRoute(id: string): string {
  const valid = phoneRecoveryId(id);
  if (!valid) throw new Error("Account recovery is unavailable. Try again.");
  return `${ROUTES.PHONE_MANDATE}?recovery=${valid}`;
}

export function phoneRecoveryRouteFromHref(href: string): string | null {
  try {
    const url = new URL(href, "https://one.local");
    if (url.pathname !== ROUTES.PHONE_MANDATE) return null;
    const id = phoneRecoveryId(url.searchParams.get("recovery"));
    return id ? phoneRecoveryReviewRoute(id) : null;
  } catch { return null; }
}
