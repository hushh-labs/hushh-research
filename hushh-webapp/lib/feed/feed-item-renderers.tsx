import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Database,
  MapPin,
  Newspaper,
  ShieldCheck,
  Sparkles,
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
    /**
     * Personal agent lifecycle. Provisioning is fire-and-forget in the backend
     * and invisible everywhere else, so these rows are the only place a person
     * watches their own private agent being created. They ride the `consent`
     * source domain (the agent's authority is a standing consent grant, and
     * feed_events.source_domain is CHECK-constrained), so the domain label is
     * overridden here rather than reading "Consent".
     */
    case "personal_agent_reserved":
      return {
        icon: Sparkles,
        domainLabel: "Private agent",
        label: "Your private agent is on the way",
        description: "We reserved your own private agent. Nothing for you to do.",
        href: null,
      };
    case "personal_agent_provisioning":
      return {
        icon: Sparkles,
        domainLabel: "Private agent",
        label: "Setting up your private agent",
        description: "Your private agent is being set up in the background.",
        href: null,
      };
    // The longest wait in the whole journey, and until now the only one with no
    // renderer at all — so the backend wrote `personal_agent_connecting` and the
    // feed answered "Something happened in your account." The minutes a person
    // spends most anxious about whether this worked had the worst copy in the app.
    //
    // What is actually true at this point: the person's own compute exists and is
    // starting up, and it is handing over its key so nothing but their agent can
    // read their records. Said plainly, because that IS the product.
    case "personal_agent_connecting":
      return {
        icon: Sparkles,
        domainLabel: "Private agent",
        label: "Your private agent is starting up",
        description:
          "Your own private compute is running. It is handing over its key so only your agent can read your records.",
        href: null,
      };
    case "personal_agent_ready":
      return {
        icon: Sparkles,
        domainLabel: "Private agent",
        label: "Your private agent is ready",
        description: "It is set up and ready whenever you are.",
        href: ROUTES.AGENT,
      };
    case "personal_agent_failed": {
      // The backend only ever writes a closed vocabulary of user-safe reason
      // codes here — never an exception message — so an unknown code falls back
      // to the plain line rather than rendering anything raw.
      const reason = metadataString(item.metadata, "reason");
      return {
        icon: AlertTriangle,
        domainLabel: "Private agent",
        label: "Your private agent is not ready yet",
        description:
          reason === "invalid_details"
            ? "Some details did not check out, so setup could not finish."
            : "We could not finish setting it up yet. Nothing was lost.",
        href: null,
      };
    }
    case "personal_agent_provisioning_capped":
      // The fleet cap is our constraint, not a mistake the person made, so this
      // reads as a queue rather than a failure.
      //
      // It used to end "starts automatically", and that was not true. A capped row
      // is left at `pending` on purpose (the cap is checked before the first
      // registry write), and the reconcile sweep retries only `provisioning` and
      // `failed`. Adding `pending` to that sweep would be worse than the wrong
      // sentence: `pending` is ALSO the state of someone who verified a phone and
      // never connected an AI key, so the sweep would start building agents for
      // people with no model to run them — the exact behaviour the AI-connection
      // gate exists to remove.
      //
      // So the copy says what is actually true and gives the person the one action
      // that genuinely restarts it. A capped-row retry is worth building; promising
      // it before it exists is not.
      return {
        icon: Sparkles,
        domainLabel: "Private agent",
        label: "Your private agent is in the queue",
        description:
          "We are at capacity right now. Your place is saved — check your AI connection again shortly to start it.",
        href: ROUTES.PROFILE_PREFERENCES_GEMINI,
      };
    case "personal_agent_reaped":
      // Only the compute is torn down; the registry row and identity survive, and
      // the next thing the person does re-provisions it. Saying "deleted" would be
      // false, and saying nothing would make the next cold start look like a fault.
      return {
        icon: Sparkles,
        domainLabel: "Private agent",
        label: "Your private agent is resting",
        description: "It was idle for a while, so we powered it down. It wakes when you need it.",
        href: ROUTES.AGENT,
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
        description: "Location share expired",
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
        description: "You approved the location request",
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
            : "accepted your connection request",
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
            : "declined your connection request",
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
            : "removed your connection",
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
