import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Database,
  MapPin,
  ShieldCheck,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";

import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";
import { ROUTES } from "@/lib/navigation/routes";
import type { FeedItem, FeedSourceDomain } from "@/lib/services/feed-service";

export type FeedItemPresentation = {
  icon: LucideIcon;
  domainLabel: string;
  label: string;
  description: string;
  href: string | null;
};

const DOMAIN_ICON: Record<FeedSourceDomain, LucideIcon> = {
  consent: ShieldCheck,
  location: MapPin,
  kai: TrendingUp,
  kyc: ShieldCheck,
  connected_systems: Database,
  connections: Users,
};

const DOMAIN_LABEL: Record<FeedSourceDomain, string> = {
  consent: "Consent",
  location: "Location",
  kai: "Kai",
  kyc: "KYC",
  connected_systems: "Connected systems",
  connections: "Connections",
};

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * One line per event_type. Wording lives here, not in the backend row, so
 * copy iterates via a frontend deploy rather than a migration.
 */
export function presentFeedItem(item: FeedItem): FeedItemPresentation {
  const icon = DOMAIN_ICON[item.source_domain] || Bell;
  const domainLabel = DOMAIN_LABEL[item.source_domain] || "Activity";
  const scope = metadataString(item.metadata, "scope_description") || metadataString(item.metadata, "scope");
  const counterparty = metadataString(item.metadata, "counterpart_label");

  switch (item.event_type) {
    case "consent_requested":
      return {
        icon,
        domainLabel,
        label: "Consent requested",
        description: scope ? `Someone requested ${scope}.` : "A new consent request needs your review.",
        href: buildConsentCenterHref("pending"),
      };
    case "consent_granted":
      return {
        icon,
        domainLabel,
        label: "Consent granted",
        description: scope ? `You granted ${scope}.` : "You granted a consent request.",
        href: buildConsentCenterHref("active"),
      };
    case "consent_revoked":
      return {
        icon,
        domainLabel,
        label: "Consent revoked",
        description: scope ? `${scope} was revoked.` : "A consent was revoked.",
        href: buildConsentCenterHref("previous"),
      };
    case "location_share_created":
      return {
        icon,
        domainLabel,
        label: "Location shared",
        description: "A live location share was started.",
        href: ROUTES.ONE_LOCATION,
      };
    case "location_share_revoked":
      return {
        icon,
        domainLabel,
        label: "Location share ended",
        description: "A live location share was revoked.",
        href: ROUTES.ONE_LOCATION,
      };
    case "location_share_expired":
      return {
        icon,
        domainLabel,
        label: "Location share expired",
        description: "A live location share expired.",
        href: ROUTES.ONE_LOCATION,
      };
    case "location_access_request":
      return {
        icon,
        domainLabel,
        label: "Location access requested",
        description: "Someone asked to see your location.",
        href: ROUTES.ONE_LOCATION,
      };
    case "location_access_approved":
      return {
        icon,
        domainLabel,
        label: "Location access approved",
        description: "A location access request was approved.",
        href: ROUTES.ONE_LOCATION,
      };
    case "location_access_denied":
      return {
        icon,
        domainLabel,
        label: "Location access denied",
        description: "A location access request was denied.",
        href: ROUTES.ONE_LOCATION,
      };
    case "kai_analysis_completed": {
      const ticker = metadataString(item.metadata, "ticker");
      return {
        icon,
        domainLabel,
        label: "Analysis ready",
        description: ticker ? `Kai finished analyzing ${ticker}.` : "Kai finished an analysis.",
        href: ticker
          ? buildKaiMarketRoute("analysis", { ticker })
          : buildKaiMarketRoute("analysis"),
      };
    }
    case "kyc_status_changed": {
      const status = metadataString(item.metadata, "new_status").replace(/_/g, " ");
      return {
        icon,
        domainLabel,
        label: "KYC status updated",
        description: status ? `Your KYC workflow is now ${status}.` : "Your KYC workflow status changed.",
        href: ROUTES.ONE_KYC,
      };
    }
    case "connected_systems_approved":
    case "connected_systems_connected":
      return {
        icon,
        domainLabel,
        label: "System connected",
        description: "A connected system finished syncing.",
        href: ROUTES.CONNECTED_SYSTEMS,
      };
    case "connected_systems_rejected":
      return {
        icon,
        domainLabel,
        label: "System connection rejected",
        description: "A connected-system request was rejected.",
        href: ROUTES.CONNECTED_SYSTEMS,
      };
    case "connected_systems_failed":
      return {
        icon,
        domainLabel,
        label: "System sync failed",
        description: "A connected-system action failed.",
        href: ROUTES.CONNECTED_SYSTEMS,
      };
    case "connection_accepted":
      return {
        icon: UserRound,
        domainLabel,
        label: "Connection accepted",
        description: counterparty ? `You and ${counterparty} are connected.` : "A connection was accepted.",
        href: ROUTES.CONNECT,
      };
    case "connection_rejected":
      return {
        icon: UserRound,
        domainLabel,
        label: "Connection rejected",
        description: "A connection request was rejected.",
        href: ROUTES.CONNECT,
      };
    case "connection_revoked":
      return {
        icon: UserRound,
        domainLabel,
        label: "Connection removed",
        description: "A connection was removed.",
        href: ROUTES.CONNECT,
      };
    default:
      return {
        icon,
        domainLabel,
        label: "Activity",
        description: "Something happened in your account.",
        href: null,
      };
  }
}
