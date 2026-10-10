import { documentShareRequestId, isDocumentShareEntry } from "@/lib/consent/document-share-consent";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

/** Server-owned prerequisites. Absent fields preserve legacy request behavior. */
export type DocumentRequestSetup = {
  ownerPayoutAccountReady?: boolean;
  ownerPriceRequired?: boolean;
  paymentsReady?: boolean;
};
export type DocumentRequestSetupState = "payouts" | "price" | "unavailable";

export function documentRequestSetupState(value: DocumentRequestSetup): DocumentRequestSetupState | null {
  if (value.ownerPayoutAccountReady === false) return "payouts";
  if (value.ownerPriceRequired === true) return "price";
  if (value.paymentsReady === false) return "unavailable";
  return null;
}

/** A historical payment or stopped request must never regain setup actions. */
export function documentRequestEntrySetup(entry: ConsentCenterEntry): DocumentRequestSetupState | null {
  if (!isDocumentShareEntry(entry) || !documentShareRequestId(entry.id) ||
      entry.status !== "pending" || !["incoming_request", "outgoing_request"].includes(entry.kind)) return null;
  const metadata = entry.metadata ?? {};
  if (metadata.accessStopped === true || ["paid", "refunded", "expired"].includes(String(metadata.paymentStatus))) return null;
  return documentRequestSetupState({
    ownerPayoutAccountReady: typeof metadata.ownerPayoutAccountReady === "boolean" ? metadata.ownerPayoutAccountReady : undefined,
    ownerPriceRequired: typeof metadata.ownerPriceRequired === "boolean" ? metadata.ownerPriceRequired : undefined,
    paymentsReady: typeof metadata.paymentsReady === "boolean" ? metadata.paymentsReady : undefined,
  });
}

export function documentRequestSetupHref(state: "payouts" | "price", from = "/one/feed"): string {
  return buildProfileRoute({
    panel: state === "payouts" ? "payouts" : "request-pricing",
    searchParams: new URLSearchParams({ from }),
  });
}

export function documentRequestSetupLabel(state: DocumentRequestSetupState, owner: boolean): string {
  if (state === "unavailable") return "Payments unavailable";
  if (owner) return state === "payouts" ? "Link payouts" : "Set price";
  return state === "payouts" ? "Waiting for owner setup" : "Waiting for price";
}
