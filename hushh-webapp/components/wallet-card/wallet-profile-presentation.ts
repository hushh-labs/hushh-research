import type { WalletCardPayload } from "@/lib/services/wallet-card-service";
import { isWalletShareTokenShape } from "@/lib/services/wallet-card-service";
import { normalizePublicWalletCard } from "@/components/wallet-card/public-card-view";

/** Presentation only. Callers supply the existing owner-approved projection. */
export interface WalletProfilePresentation {
  name: string;
  avatarUrl: string | null;
  professionalTitle: string | null;
  organization: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  verification: "verified" | "unverified" | "unknown";
  authorizedProfileUrl: string | null;
}

export function authorizedWalletProfileUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const match = /^\/c\/([^/]+)$/.exec(url.pathname);
    return match && isWalletShareTokenShape(match[1]) ? url.href : null;
  } catch { return null; }
}

/** Never supplement private contact fields from the authenticated account. */
export function walletProfilePresentation(source?: {
  displayName?: string | null;
  avatarUrl?: string | null;
  cardPayload?: WalletCardPayload | null;
  shareUrl?: string | null;
} | null): WalletProfilePresentation {
  const shared = normalizePublicWalletCard({
    ...source?.cardPayload,
    full_name: source?.cardPayload?.full_name || source?.displayName,
    avatar_url: source?.avatarUrl,
  });
  return {
    name: shared?.fullName || "Your profile",
    avatarUrl: shared?.avatarUrl ?? null,
    professionalTitle: shared?.headline ?? null,
    organization: shared?.organisation ?? null,
    email: shared?.email ?? null,
    phone: shared?.phone ?? null,
    location: shared?.locationLabel ?? null,
    // The existing Wallet contract has no authoritative identity-verification field.
    verification: "unknown",
    authorizedProfileUrl: authorizedWalletProfileUrl(source?.shareUrl),
  };
}
