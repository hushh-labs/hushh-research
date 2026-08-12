import type { LucideIcon } from "lucide-react";
import {
  Database,
  MapPin,
  Newspaper,
  ShieldCheck,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";

import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { buildOneLocationWorkflowHref } from "@/lib/one-location/notifications";
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
 * Resolve the most identifying name available for a feed counterparty.
 *
 * Order: a pre-resolved label the backend already chose, then display name,
 * then first name, then a phone number, and only "Someone" as an absolute last
 * resort when nothing identifying exists. `counterpart_label` is preferred
 * because the backend has already applied its own privacy rules to it — this
 * helper never widens what the row exposes, it only stops falling back to
 * "Someone" when a real identifier is present in the row.
 */
function resolveCounterpartName(metadata: Record<string, unknown>): string {
  return (
    metadataString(metadata, "counterpart_label") ||
    metadataString(metadata, "display_name") ||
    metadataString(metadata, "first_name") ||
    metadataString(metadata, "phone_number") ||
    "Someone"
  );
}


/**
 * One line per event_type. Wording lives here, not in the backend row, so
 * copy iterates via a frontend deploy rather than a migration.
 */
export function presentFeedItem(item: FeedItem): FeedItemPresentation {
  const icon = DOMAIN_ICON[item.source_domain] || Newspaper;
  const domainLabel = DOMAIN_LABEL[item.source_domain] || "Activity";
  const scope = metadataString(item.metadata, "scope_description") || metadataString(item.metadata, "scope");
  // Best-available name for the other party (label → display → first → phone →
  // "Someone" last). Used to turn vague, subjectless lines like "A live
  // location share was revoked" into explicit subject-action-object sentences.
  const who = resolveCounterpartName(item.metadata);

  switch (item.event_type) {
    case "consent_requested":
      return {
        icon,
        domainLabel,
        label: "Consent requested",
        description: scope
          ? `${who} requested ${scope}.`
          : `${who} sent a consent request for your review.`,
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
        description: `${who} shared their live location with you.`,
        href: ROUTES.ONE_LOCATION,
      };
    case "location_share_revoked":
      return {
        icon,
        domainLabel,
        label: "Location share ended",
        description: `${who}'s live location share ended.`,
        href: ROUTES.ONE_LOCATION,
      };
    case "location_share_expired":
      return {
        icon,
        domainLabel,
        label: "Location share expired",
        description: `${who}'s live location share expired.`,
        href: ROUTES.ONE_LOCATION,
      };
    case "location_access_request":
      return {
        icon,
        domainLabel,
        label: "Location access requested",
        description: `${who} requested to see your location.`,
        href: ROUTES.ONE_LOCATION,
      };
    case "location_access_approved":
      return {
        icon,
        domainLabel,
        label: "Location access approved",
        description: `${who} approved your location request.`,
        href: ROUTES.ONE_LOCATION,
      };
    case "location_access_denied":
      return {
        icon,
        domainLabel,
        label: "Location access denied",
        description: `${who} denied your location request.`,
        href: ROUTES.ONE_LOCATION,
      };
    case "circle_member_invited": {
      const circleName = metadataString(item.metadata, "circle_name");
      const inviteId = metadataString(item.metadata, "invite_id");
      return {
        icon,
        domainLabel,
        label: "Circle invitation",
        description: circleName
          ? `You were invited to join ${circleName}.`
          : "You were invited to join a Circle.",
        href: inviteId
          ? buildOneLocationWorkflowHref({
              circleInviteId: inviteId,
              section: "people",
            })
          : ROUTES.ONE_LOCATION,
      };
    }
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
    case "connection_accepted": {
      // Prefer any resolvable name (label → display → first → phone) so a row
      // with partial metadata still names the person instead of the generic
      // fallback. `hasWho` guards the "Someone" sentinel from resolveCounterpartName.
      const hasWho = who !== "Someone";
      return {
        icon: UserRound,
        domainLabel,
        label: "Connection accepted",
        description: hasWho
          ? `You and ${who} are connected.`
          : "A connection was accepted.",
        href: ROUTES.CONNECT,
      };
    }
    case "connection_rejected": {
      const hasWho = who !== "Someone";
      return {
        icon: UserRound,
        domainLabel,
        label: "Connection rejected",
        description: hasWho
          ? `${who} declined your connection request.`
          : "A connection request was rejected.",
        href: ROUTES.CONNECT,
      };
    }
    case "connection_revoked": {
      const hasWho = who !== "Someone";
      return {
        icon: UserRound,
        domainLabel,
        label: "Connection removed",
        description: hasWho
          ? `Your connection with ${who} was removed.`
          : "A connection was removed.",
        href: ROUTES.CONNECT,
      };
    }
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
