import { documentShareRequestId, isDocumentShareEntry } from "@/lib/consent/document-share-consent";
import { buildProfilePaneHref, profileConnectorsLocation } from "@/lib/navigation/profile-pane";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

/** Server-owned prerequisites. Absent fields preserve legacy request behavior. */
export type DocumentRequestSetup = {
  ownerDriveReady?: boolean;
  ownerPayoutAccountReady?: boolean;
  ownerPriceRequired?: boolean;
  paymentsReady?: boolean;
};
export type DocumentRequestSetupState = "drive" | "payouts" | "price" | "unavailable";
/** A setup step the owner can finish in One. */
export type DocumentRequestSetupStep = Exclude<DocumentRequestSetupState, "unavailable">;

export const GOOGLE_DRIVE_CONNECTOR_ID = "google_drive";

/**
 * One next step, checked in the order a request needs them: the owner's
 * Drive first (nothing can be found without it), then payouts, price and
 * payments. Each step names exactly one screen that clears it.
 */
export function documentRequestSetupState(value: DocumentRequestSetup): DocumentRequestSetupState | null {
  if (value.ownerDriveReady === false) return "drive";
  if (value.ownerPayoutAccountReady === false) return "payouts";
  if (value.ownerPriceRequired === true) return "price";
  if (value.paymentsReady === false) return "unavailable";
  return null;
}

export function isDocumentRequestSetupStep(value: unknown): value is DocumentRequestSetupStep {
  return value === "drive" || value === "payouts" || value === "price";
}

/** A historical payment or stopped request must never regain setup actions. */
export function documentRequestEntrySetup(entry: ConsentCenterEntry): DocumentRequestSetupState | null {
  if (!isDocumentShareEntry(entry) || !documentShareRequestId(entry.id) ||
      entry.status !== "pending" || !["incoming_request", "outgoing_request"].includes(entry.kind)) return null;
  const metadata = entry.metadata ?? {};
  if (metadata.accessStopped === true || ["paid", "refunded", "expired"].includes(String(metadata.paymentStatus))) return null;
  return documentRequestSetupState({
    ownerDriveReady: typeof metadata.ownerDriveReady === "boolean" ? metadata.ownerDriveReady : undefined,
    ownerPayoutAccountReady: typeof metadata.ownerPayoutAccountReady === "boolean" ? metadata.ownerPayoutAccountReady : undefined,
    ownerPriceRequired: typeof metadata.ownerPriceRequired === "boolean" ? metadata.ownerPriceRequired : undefined,
    paymentsReady: typeof metadata.paymentsReady === "boolean" ? metadata.paymentsReady : undefined,
  });
}

/**
 * The one screen that clears a setup step. Drive opens Google Drive in the
 * Profile pane over `from`, so closing it returns there; payouts and price
 * open their Profile page with `from` kept for the way back.
 */
export function documentRequestSetupHref(state: DocumentRequestSetupStep, from = "/one/feed"): string {
  if (state === "drive") {
    const origin = new URL(from, "https://hushh.local");
    return buildProfilePaneHref(origin.pathname, origin.search, profileConnectorsLocation(GOOGLE_DRIVE_CONNECTOR_ID));
  }
  return buildProfileRoute({
    panel: state === "payouts" ? "payouts" : "request-pricing",
    searchParams: new URLSearchParams({ from }),
  });
}

export function documentRequestSetupLabel(state: DocumentRequestSetupState, owner: boolean): string {
  if (state === "unavailable") return "Payments unavailable";
  if (owner) return state === "drive" ? "Connect Google Drive" : state === "payouts" ? "Link payouts" : "Set price";
  // The owner's Drive state is never projected to the requester.
  return state === "price" ? "Waiting for price" : "Waiting for owner setup";
}
