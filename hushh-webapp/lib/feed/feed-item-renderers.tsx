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

function metadataBool(metadata: Record<string, unknown>, key: string): boolean {
  return metadata[key] === true;
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
    // Location events use a person-first layout: the title is the counterparty's
    // name (falling back to "Location" only when no name is resolvable), and the
    // subtitle is the action. The name arrives via `counterpart_label` in the
    // backend feed metadata (one_location_agent_service.py).
    case "location_share_created": {
      const hasWho = who !== "Someone";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description: "Started sharing location",
        href: ROUTES.ONE_LOCATION,
      };
    }
    case "location_share_revoked": {
      const hasWho = who !== "Someone";
      const ownerRevoked = metadataString(item.metadata, "reason") === "owner_revoke";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description: ownerRevoked ? "You stopped sharing location" : "Stopped sharing location",
        href: ROUTES.ONE_LOCATION,
      };
    }
    case "location_share_expired": {
      const hasWho = who !== "Someone";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description: "Stopped sharing - time ran out",
        href: ROUTES.ONE_LOCATION,
      };
    }
    case "location_access_request": {
      const hasWho = who !== "Someone";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description: "Requested your location",
        href: ROUTES.ONE_LOCATION,
      };
    }
    case "location_access_approved": {
      const hasWho = who !== "Someone";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description: "You approved. Now sharing.",
        href: ROUTES.ONE_LOCATION,
      };
    }
    case "location_access_denied": {
      const hasWho = who !== "Someone";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description: "You declined the location request",
        href: ROUTES.ONE_LOCATION,
      };
    }
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
        description: status
          ? `Your KYC check is now ${status}.`
          : "Your KYC check moved on.",
        href: ROUTES.ONE_KYC,
      };
    }
    case "connected_systems_approved":
    case "connected_systems_connected":
      return {
        icon,
        domainLabel,
        label: "App connected",
        description: "Your data finished coming in.",
        href: ROUTES.CONNECTED_SYSTEMS,
      };
    case "connected_systems_rejected":
      return {
        icon,
        domainLabel,
        label: "Connection turned down",
        description: "That app wasn't connected.",
        href: ROUTES.CONNECTED_SYSTEMS,
      };
    case "connected_systems_failed":
      return {
        icon,
        domainLabel,
        label: "Couldn't get your data",
        description: "Something went wrong bringing it in.",
        href: ROUTES.CONNECTED_SYSTEMS,
      };
    // Connection events use the same person-first layout: title is the other
    // person's name, subtitle is the action. Name comes from `counterpart_label`
    // in the backend feed metadata (connections_service.py).
    case "connection_accepted": {
      const hasWho = who !== "Someone";
      const actorIsSelf = metadataBool(item.metadata, "actor_is_self");
      return {
        icon: UserRound,
        domainLabel,
        label: hasWho ? who : "Connection",
        description: !hasWho
          ? "A connection was accepted."
          : actorIsSelf
            ? "You accepted the connection request"
            : "Accepted your connection request",
        href: ROUTES.CONNECT,
      };
    }
    case "connection_rejected": {
      const hasWho = who !== "Someone";
      const actorIsSelf = metadataBool(item.metadata, "actor_is_self");
      return {
        icon: UserRound,
        domainLabel,
        label: hasWho ? who : "Connection",
        description: !hasWho
          ? "A connection request was rejected."
          : actorIsSelf
            ? "You declined the connection request"
            : "Declined your connection request",
        href: ROUTES.CONNECT,
      };
    }
    case "connection_revoked": {
      const hasWho = who !== "Someone";
      const actorIsSelf = metadataBool(item.metadata, "actor_is_self");
      return {
        icon: UserRound,
        domainLabel,
        label: hasWho ? who : "Connection",
        description: !hasWho
          ? "A connection was removed."
          : actorIsSelf
            ? "You removed the connection"
            : "Removed your connection",
        href: ROUTES.CONNECT,
      };
    }
    default:
      return {
        icon,
        domainLabel,
        label: "Activity",
        // No pretend explanation for an event this build has no line for.
        // "Something happened in your account." told the reader nothing and
        // read like a bug.
        description: "",
        href: null,
      };
  }
}
