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
import { formatLocationDurationLabel } from "@/lib/one-location/duration-copy";
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
  kai: "Finance",
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
 * "3 hours" / "as long as they need" for a `<prefix>_hours` + `<prefix>_mode`
 * metadata pair, or "" when no real amount was recorded.
 *
 * Shares `formatLocationDurationLabel` with the notification and approvals copy
 * on purpose: the feed entry for an ask has to name the same number, worded the
 * same way, as the popup that announced it.
 */
function metadataDurationLabel(
  metadata: Record<string, unknown>,
  prefix: string,
): string {
  if (metadata[`${prefix}_mode`] === "until_stopped") {
    return "as long as they need";
  }
  return formatLocationDurationLabel(
    metadata[`${prefix}_hours`] as number | string | null | undefined,
  );
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
  // Whose side of the event this row is. A location share writes one row to
  // the person sharing and one to the person shared with (migration 152); only
  // the second carries this marker, and only the second reads as "someone did
  // this to me" rather than "I did this". Rows written before that migration
  // have no marker and stay on the owner's wording, which is what they were.
  const sharedWithMe =
    metadataString(item.metadata, "feed_audience") === "recipient";
  // The same marker on a request-lifecycle row (migration 153), naming the
  // person who did the asking. One key, two named facts -- not a second
  // convention per fan-out.
  const iAskedForThis =
    metadataString(item.metadata, "feed_audience") === "requester";

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
    // The share lifecycle reaches the recipient through its own fan-out
    // (migration 152), so these three also render from both sides.
    case "location_share_created": {
      const hasWho = who !== "Someone";
      const shareAmount = metadataDurationLabel(item.metadata, "duration");
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        // For an approval-born share this is the requester's ONLY row (152
        // writes it; 153 deliberately does not add a second for the approval),
        // so it names the granted amount that the event metadata carries.
        description: sharedWithMe
          ? shareAmount
            ? `Shared their location with you for ${shareAmount}`
            : "Shared their location with you"
          : "You started sharing location",
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
        // `reason` describes what the OWNER did, so on the recipient's row
        // "owner_revoke" is still true and "You stopped sharing location"
        // would be shown to the one person who did not stop anything.
        // Audience decides the sentence; reason only refines the owner's.
        description: sharedWithMe
          ? "Stopped sharing their location"
          : ownerRevoked
            ? "You stopped sharing location"
            : "Stopped sharing location",
        href: ROUTES.ONE_LOCATION,
      };
    }
    case "location_share_expired": {
      const hasWho = who !== "Someone";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        // No audience split: this line names no subject, and the row's title is
        // already the other person, so it reads correctly from both sides.
        description: "Stopped sharing - time ran out",
        href: ROUTES.ONE_LOCATION,
      };
    }
    // The three request lines carry the AMOUNT of time asked for and whether it
    // was extra time on a share already running. A feed that says only
    // "Requested your location" for a person asking to extend by three hours is
    // reporting that something happened, not what.
    //
    // These rows now reach BOTH parties, so each one reads its own side:
    // `viewer_role` says whether this copy belongs to the person whose location
    // it is or to the person who asked for it. Rows written before that fan-out
    // landed carry no role and keep the owner wording they were written for.
    case "location_access_request": {
      const hasWho = who !== "Someone";
      const isExtension = metadataBool(item.metadata, "is_extension");
      const amount = metadataDurationLabel(item.metadata, "requested_duration");
      const asRequester = iAskedForThis;
      const description = asRequester
        ? isExtension
          ? amount
            ? `You asked for ${amount} more`
            : "You asked for more location time"
          : amount
            ? `You asked to see their location for ${amount}`
            : "You asked to see their location"
        : isExtension
          ? amount
            ? `Asked for ${amount} more`
            : "Asked for more location time"
          : amount
            ? `Requested your location for ${amount}`
            : "Requested your location";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description,
        href: buildOneLocationWorkflowHref({
          requestId: metadataString(item.metadata, "request_id") || undefined,
          section: asRequester ? "my_requests" : "approvals",
        }),
      };
    }
    case "location_access_approved": {
      const hasWho = who !== "Someone";
      const isExtension = metadataBool(item.metadata, "is_extension");
      const amount = metadataDurationLabel(item.metadata, "duration");
      const asRequester = iAskedForThis;
      const description = asRequester
        ? isExtension
          ? amount
            ? `Gave you ${amount} more`
            : "Gave you more location time"
          : amount
            ? `Shared their location with you for ${amount}`
            : "Approved your location request"
        : isExtension
          ? amount
            ? `You gave them ${amount} more`
            : "You gave them more location time"
          : amount
            // Migration 151 stopped forwarding the approval-born
            // location_share_created row, so this line is now the only report
            // of that whole tap. It has to say the share STARTED, not just
            // that a request was answered -- main's wording, carrying the
            // amount this branch adds.
            ? `You approved ${amount}. Now sharing.`
            : "You approved. Now sharing.";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description,
        href: ROUTES.ONE_LOCATION,
      };
    }
    case "location_access_denied": {
      const hasWho = who !== "Someone";
      const isExtension = metadataBool(item.metadata, "is_extension");
      const asRequester = iAskedForThis;
      const description = asRequester
        ? isExtension
          ? "Declined the extra time — your current access is unchanged"
          : "Declined your location request"
        : isExtension
          ? "You declined the extra time"
          : "You declined the location request";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description,
        href: ROUTES.ONE_LOCATION,
      };
    }
    case "location_share_shortened": {
      const hasWho = who !== "Someone";
      const ownerShortened =
        metadataString(item.metadata, "reason") === "owner_shorten";
      return {
        icon,
        domainLabel,
        label: hasWho ? who : "Location",
        description: ownerShortened
          ? "You shortened their location access"
          : "Gave back their remaining time early",
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
    case "circle_member_added": {
      const circleName = metadataString(item.metadata, "circle_name");
      const circleId = metadataString(item.metadata, "circle_id");
      const addedBy =
        metadataString(item.metadata, "added_by_label") || item.actor_label;
      return {
        icon,
        domainLabel,
        label: "Added to a Circle",
        description: addedBy
          ? circleName
            ? `${addedBy} added you to ${circleName}.`
            : `${addedBy} added you to their Circle.`
          : circleName
            ? `You were added to ${circleName}.`
            : "You were added to a Circle.",
        href: circleId
          ? buildOneLocationWorkflowHref({ circleId, section: "people" })
          : ROUTES.ONE_LOCATION,
      };
    }
    case "kai_analysis_completed": {
      const ticker = metadataString(item.metadata, "ticker");
      return {
        icon,
        domainLabel,
        label: "Analysis ready",
        description: ticker ? `One finished analyzing ${ticker}.` : "One finished an analysis.",
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
