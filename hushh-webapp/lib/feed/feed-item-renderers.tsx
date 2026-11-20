import { ROUTES } from "@/lib/navigation/routes";
import { locationFeedPresentation } from "./location-feed-presentation";
import { AGENT_OUTCOME_COPY } from "./feed-outcome-copy";
import { directMessageFeedHref } from "./connection-feed-navigation";
import type { ComponentType } from "react";
import { advisorReviewPresentation } from "./advisor-review-presentation";
import { connectionMessagePreview as walletMessagePreview } from "@/lib/finance-sharing/message-preview";
import { isCardRequestId, walletCardRequestHref } from "@/lib/wallet/card-request";
import {
  AlertTriangle,
  Bot,
  Banknote,
  Database,
  FileText,
  Mail,
  MapPin,
  MessageCircle,
  Newspaper,
  ShieldCheck,
  TrendingUp,
  UserRound,
  ScanSearch,
  Users,
} from "@/components/icons";
import { CalendarAgentIcon } from "@/components/icons/agents";
import { calendarFollowupHref } from "@/lib/calendar/calendar-followup-notification";
import { meetingFeedLine } from "@/lib/calendar/meeting-file-copy";
import {
  consentInformationLabel,
  joinInformationLabels,
  reasonMidSentence,
} from "@/lib/consent/consent-owner-copy";
import { documentShareNotificationSelection, documentShareRequestId } from "@/lib/consent/document-share-consent";
import { documentRequestEmptyOutcomeLabel, partialDocumentDeliveryState } from "@/lib/consent/document-request-delivery-state";
import {
  formatPaymentMoney,
  REQUESTER_PAYMENT_TITLES,
} from "@/lib/consent/document-request-payment-view";
import { documentRequestSetupHref } from "@/lib/consent/document-request-setup";
import {
  documentPayoutNetEarnings,
  documentPayoutStatusLabel,
  isOwnerDocumentPayoutStatus,
} from "@/lib/consent/document-payout-status";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { formatLocationDurationLabel } from "@/lib/one-location/duration-copy";
import { buildOneLocationWorkflowHref } from "@/lib/one-location/notifications";
import { historicalFundingFeedHref, savedAnalysisFeedHref } from "@/lib/feed/source-routes";
import {
  buildProfileConnectorsPaneHref,
  buildProfilePaneHref,
  profileConnectorsLocation,
} from "@/lib/navigation/profile-pane";
import { circleChatHref } from "@/lib/circle-chat/routes";
import { CONNECT_CIRCLES_LIST_HREF } from "@/lib/navigation/connect-routes";
import type { FeedItem, FeedSourceDomain } from "@/lib/services/feed-service";
import { getAnalysisHistoryRunRouteId } from "@/lib/kai/analysis-route-intent";
export type FeedItemPresentation = {
  icon: ComponentType<{ className?: string; color?: string }>;
  /** Authoritative company ticker, never parsed from the displayed copy. */
  symbol?: string;
  domainLabel: string;
  label: string;
  description: string;
  href: string | null;
  /** Authored by a source-specific selector, never inferred from a URL. */
  recovery?: { href: string; label: string };
  exactDestination?: "request" | "report" | "transfer" | "followup" | "conversation" | "card" | "share" | "circle" | "check-in";
  person?: {
    personRef?: string | null;
    displayName: string;
    photoUrl: string | null;
  } | null;
};

const DOMAIN_ICON: Record<FeedSourceDomain, FeedItemPresentation["icon"]> = {
  consent: ShieldCheck,
  location: MapPin,
  kai: TrendingUp,
  kyc: ShieldCheck,
  connected_systems: Database,
  connections: Users,
  profile_discovery: ScanSearch,
  pwm: UserRound,
  calendar_email_followup: Mail,
};

const DOMAIN_LABEL: Record<FeedSourceDomain, string> = {
  consent: "Consent",
  location: "Location",
  kai: "Finance",
  kyc: "KYC",
  connected_systems: "Connected systems",
  connections: "Connect",
  profile_discovery: "Profile discovery",
  pwm: "Personal World Model",
  calendar_email_followup: "Follow-ups",
};

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string {
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
 * then first name, and only "Someone" as an absolute last resort when nothing
 * identifying exists. Raw phone fields never belong in the plaintext Feed.
 * `counterpart_label` is preferred
 * because the backend has already applied its own privacy rules to it — this
 * helper never widens what the row exposes, it only stops falling back to
 * "Someone" when a real identifier is present in the row.
 */
function resolveCounterpartName(metadata: Record<string, unknown>): string {
  return (
    metadataString(metadata, "counterpart_label") ||
    metadataString(metadata, "granter_name") ||
    metadataString(metadata, "display_name") ||
    metadataString(metadata, "first_name") ||
    "Someone"
  );
}

function resolveCounterpartPhotoUrl(
  metadata: Record<string, unknown>,
): string | null {
  return (
    metadataString(metadata, "counterpart_photo_url") ||
    metadataString(metadata, "counterpartPhotoUrl") ||
    metadataString(metadata, "photo_url") ||
    metadataString(metadata, "photoUrl") ||
    null
  );
}

function counterpartPerson(
  metadata: Record<string, unknown>,
  displayName: string,
): FeedItemPresentation["person"] {
  if (displayName === "Someone") return null;
  return {
    displayName,
    photoUrl: resolveCounterpartPhotoUrl(metadata),
    personRef: metadataString(metadata, "counterpart_person_ref") || null,
  };
}

/**
 * The action line for a Drive sharing or Drive question row (migration 246).
 *
 * The row never carries a file name or the question, only the closed type,
 * which side of the request this person is on, and the request's status word
 * at the moment of the event -- so the line says what happened, and the tap
 * opens the same review a push would.
 */
function driveFeedLine(
  eventType: string,
  sharedWithMe: boolean,
  status: string,
  metadata: Record<string, unknown>,
): string {
  // A meeting recording/notes request names the files asked for and, per type,
  // the ones the organizer said they don't have. Other Drive rows keep their lines.
  const meeting = meetingFeedLine(eventType, sharedWithMe ? "requester" : "organizer", status, metadata);
  if (meeting) return meeting;
  switch (eventType) {
    case "document_share_request_sent":
      return "Request sent";
    case "document_share_request":
      return "Document request received";
    case "document_share_review_ready":
      return "Files ready for your review";
    case "document_share_review_requested":
      return "Asked you to review unshared files";
    case "document_share_payment_ready":
      return paymentInstructionLine(metadata);
    case "document_share_payment_confirmed":
      return paymentConfirmedLine(metadata);
    case "document_share_payment_refunded":
      return documentRefundLine(metadata);
    case "document_share_decided":
      if (sharedWithMe) {
        return status === "declined"
          ? "Declined your file request"
          : status === "pending"
            ? "Files are available; more may arrive"
            : "Approved your document request";
      }
      return status === "cancelled"
        ? "Withdrew their file request"
        : status === "pending"
          ? "Some shared files are available"
          : "Document request approved";
    case "document_share_outcome":
      if (metadata.current_existing_access_nocharge === true)
        return sharedWithMe ? "Files ready · Already had access · No charge" : "Files delivered · No payment due";
      if (status === "no_files_shared" || status === "no_match")
        return documentRequestEmptyOutcomeLabel(metadata.current_outcome_reason);
      if (status === "partial") return partialDriveOutcomeLine(metadata);
      return "Drive sharing finished; check file results";
    case "document_share_revoked":
      return sharedWithMe
        ? "Removed your access to shared files"
        : "No longer has your shared files";
    case "document_share_revocation_outcome":
      return sharedWithMe
        ? "Changed your access to shared files"
        : "Some access couldn't be removed";
    case "document_share_question":
      return "Asked a question about your Drive";
    case "document_share_answered":
      return "Answered your Drive question";
    case "document_share_declined":
      return "Declined your Drive question";
    default:
      return "";
  }
}

function documentActivitySummary(item: FeedItem): string {
  const meta = item.metadata;
  const recipient = meta.feed_audience === "recipient";
  const count = Number(meta.current_delivery_confirmed_count);
  const total = Number(meta.current_delivery_total_count);
  const status = meta.current_request_status;
  if (meta.current_access_stopped === true || item.event_type === "document_share_revoked") {
    return recipient ? "Your file access ended" : "File access ended";
  }
  if (item.event_type === "document_share_payment_refunded" && recipient) {
    const refund = Number(meta.current_refund_amount_cents);
    return Number.isSafeInteger(refund) && refund > 0
      ? `Refunded ${formatPaymentMoney(refund)}` : "Refund confirmed";
  }
  if (status === "declined") return recipient ? "Declined your request" : "Request declined";
  if (status === "expired" || (meta.current_request_expired === true &&
      ["pending", "preparing", "review_ready"].includes(String(status)))) return "Request expired";
  if (status === "no_match" || status === "no_files_shared") return "No files shared";
  if (Number.isSafeInteger(count) && count > 0) {
    const files = `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`;
    const ready = status !== "completed" && recipient && Number.isSafeInteger(total) && total > count
      ? `${count.toLocaleString()} of ${total.toLocaleString()} files ready`
      : `${files} ready`;
    return meta.current_existing_access_nocharge === true
      ? `${ready} · ${recipient ? "No charge" : "No payment due"}` : ready;
  }
  if (meta.current_existing_access_nocharge === true) return recipient ? "Files ready · No charge" : "Files ready · No payment due";
  if (status === "completed") return "Delivery complete";
  if (recipient && meta.current_payment_status === "paid") {
    const paid = Number(meta.current_payment_amount_cents);
    return Number.isSafeInteger(paid) && paid > 0
      ? `Paid ${formatPaymentMoney(paid)}` : "Payment confirmed";
  }
  return recipient ? "File request sent" : "Requested files";
}

function partialDriveOutcomeLine(metadata: Record<string, unknown>): string {
  switch (partialDocumentDeliveryState({
    total: metadata.current_delivery_total_count,
    available: metadata.current_delivery_confirmed_count,
    pending: metadata.current_delivery_pending_count,
  })) {
    case "available": return "Files shared; request incomplete";
    case "checking": return "Sharing is still being checked";
    case "unavailable": return "Some selected files could not be shared";
    case "unknown": return "Check sharing and search results";
  }
}

function documentRefundLine(metadata: Record<string, unknown>): string {
  const refunded = metadata.current_refund_amount_cents;
  const paid = metadata.current_payment_amount_cents;
  if (
    !Number.isSafeInteger(refunded) ||
    (refunded as number) <= 0 ||
    !Number.isSafeInteger(paid) ||
    (paid as number) < (refunded as number)
  ) {
    return "Payment refunded for your document request";
  }
  const amount = documentPayoutNetEarnings(refunded as number);
  return refunded === paid
    ? "Payment refunded for your document request"
    : `Refunded ${amount} for undelivered files`;
}

/** The owner's payout line asks them to set up payouts; the row then opens Payouts. */
function ownerDocumentPayoutSetupNeeded(
  metadata: Record<string, unknown>,
): boolean {
  const status = metadata.owner_payout_status;
  const accountMissing = metadata.owner_payout_account_ready === false;
  if (!isOwnerDocumentPayoutStatus(status)) return accountMissing;
  return (
    status === "awaiting_account" ||
    (accountMissing && status === "awaiting_delivery")
  );
}

function ownerDocumentPayoutFeedLine(
  metadata: Record<string, unknown>,
): string | null {
  const status = metadata.owner_payout_status;
  const setupNeeded = ownerDocumentPayoutSetupNeeded(metadata);
  if (!isOwnerDocumentPayoutStatus(status))
    return setupNeeded ? "Set up US payouts" : null;
  const label =
    status === "transferred"
      ? "Sent to Stripe"
      : status === "hashcoins_credited" ||
          status === "hashcoins_held" ||
          status === "hashcoins_reversed"
        ? documentPayoutStatusLabel(status)
      : status === "manual_review" ||
          status === "reversal_due" ||
          status === "reversal_unknown"
        ? "Payout needs review"
        : status === "reversed"
          ? "Transfer reversed"
          : status === "void"
            ? "No payout due"
            : setupNeeded
              ? "Payout pending setup"
              : "Payout pending";
  const cents = metadata.owner_earning_cents;
  const net =
    Number.isSafeInteger(cents) &&
    (cents as number) >= 0 &&
    (cents as number) <= 50_000
      ? documentPayoutNetEarnings(cents as number)
      : null;
  return net === null ? label : `${label} · Net ${net}`;
}

/**
 * The history line for the server's shared payment view state. Payable and
 * owner-setup states return null: the live deadline checks below decide them.
 */
function paymentStateLine(metadata: Record<string, unknown>): string | null {
  switch (metadataString(metadata, "current_payment_state")) {
    case "paid":
    case "partially_refunded":
      return "Payment confirmed";
    case "refunded":
      return "Payment refunded";
    case "refund_pending":
      return "Refund pending";
    case "closed":
      return metadata.current_access_stopped === true
        ? "Document access stopped"
        : "Document request closed";
    case "request_expired":
      return REQUESTER_PAYMENT_TITLES.requestExpired;
    case "link_expired":
      return REQUESTER_PAYMENT_TITLES.linkExpired;
    case "preparing":
      return "Check document request";
    default:
      return null;
  }
}

/**
 * A payment that arrived after the request closed is refunded, never
 * "confirmed". Older Feed rows still carry the historical confirmation.
 */
function paymentConfirmedLine(metadata: Record<string, unknown>): string {
  const state = metadataString(metadata, "current_payment_state");
  if (state !== "refund_pending" && state !== "refunded")
    return "Payment confirmed for your document request";
  const when =
    metadataString(metadata, "current_request_status") === "cancelled"
      ? "after you withdrew"
      : "after the request closed";
  const cents = metadata.current_refund_amount_cents;
  const amount =
    Number.isSafeInteger(cents) &&
    (cents as number) > 0 &&
    (cents as number) <= 50_000
      ? formatPaymentMoney(cents as number)
      : null;
  const refund =
    state === "refunded"
      ? amount
        ? `Refunded ${amount}`
        : "Refunded"
      : amount
        ? `Refund of ${amount} pending`
        : "Refund pending";
  return `Payment received ${when} · ${refund}`;
}

function paymentInstructionLine(metadata: Record<string, unknown>): string {
  const fromState = paymentStateLine(metadata);
  if (fromState) return fromState;
  const requestStatus = metadataString(
    metadata,
    "current_request_status",
  ).toLowerCase();
  const paymentStatus = metadataString(
    metadata,
    "current_payment_status",
  ).toLowerCase();
  if (metadata.current_access_stopped === true)
    return "Document access stopped";
  if (paymentStatus === "paid") return "Payment confirmed";
  if (paymentStatus === "refunded") return "Payment refunded";
  const requestExpiry = Date.parse(
    metadataString(metadata, "current_request_expires_at"),
  );
  if (requestStatus === "cancelled" || requestStatus === "declined") {
    return "Document request closed";
  }
  if (
    requestStatus === "expired" ||
    metadata.current_request_expired === true ||
    (Number.isFinite(requestExpiry) && requestExpiry <= Date.now())
  ) {
    return REQUESTER_PAYMENT_TITLES.requestExpired;
  }
  const checkoutExpiry = Date.parse(
    metadataString(metadata, "current_checkout_expires_at"),
  );
  if (
    paymentStatus === "expired" ||
    metadata.current_checkout_expired === true ||
    (Number.isFinite(checkoutExpiry) && checkoutExpiry <= Date.now())
  ) {
    return REQUESTER_PAYMENT_TITLES.linkExpired;
  }
  // The actionable above history owns Checkout. An unavailable status cannot
  // resurrect a Pay instruction from an old immutable Feed event.
  if (paymentStatus === "unavailable") return "Check document request";
  if (metadata.current_owner_payout_account_ready === false)
    return "Waiting for owner payout setup";
  return "Payment due for your document request";
}

function metadataStringList(
  metadata: Record<string, unknown>,
  key: string,
): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];
}

/**
 * The name on a consent row, or "" when the row carries none. Never the
 * technical requester id: an unnamed row says "Someone asked" instead.
 */
/**
 * The requester's name, from the metadata when it has one, else the row's own
 * `actor_label`: the per-request consent row (migration 260) writes the name
 * there too. "Someone" is only for a row that truly carries no name.
 */
function consentRequesterName(
  item: Pick<FeedItem, "metadata" | "actor_label">,
): string {
  const metadata = item.metadata;
  return (
    metadataString(metadata, "requester_label") ||
    metadataString(metadata, "requester_display_name") ||
    metadataString(metadata, "counterpart_label") ||
    metadataString(metadata, "display_name") ||
    (typeof item.actor_label === "string" ? item.actor_label.trim() : "") ||
    ""
  );
}

/**
 * Human names for what a consent row is about, from the item keys when the row
 * has them (so the words match the sheet and the Active row exactly), else from
 * the stored names.
 */
function consentRowLabels(metadata: Record<string, unknown>): string[] {
  const scopes = [
    ...metadataStringList(metadata, "grouped_scopes"),
    ...metadataStringList(metadata, "scopes"),
  ];
  const single = metadataString(metadata, "scope");
  if (!scopes.length && single) scopes.push(single);
  if (scopes.length) {
    return scopes.map((scope) => consentInformationLabel({ scope }));
  }
  const labels = [
    ...metadataStringList(metadata, "grouped_labels"),
    ...metadataStringList(metadata, "labels"),
  ];
  const description = metadataString(metadata, "scope_description");
  if (!labels.length && description) labels.push(description);
  return labels.map((label) => consentInformationLabel({ label }));
}

/**
 * One line per event_type. Wording lives here, not in the backend row, so
 * copy iterates via a frontend deploy rather than a migration.
 */

export function presentFeedItem(item: FeedItem): FeedItemPresentation {
  const advisorReview = advisorReviewPresentation(item); if (advisorReview) return advisorReview;
  const icon = DOMAIN_ICON[item.source_domain] || Newspaper;
  const domainLabel = DOMAIN_LABEL[item.source_domain] || "Activity";
  // Best-available name for the other party (label → display → first →
  // "Someone" last). Used to turn vague, subjectless lines like "A live
  // location share was revoked" into explicit subject-action-object sentences.
  const who = resolveCounterpartName(item.metadata);
  const location = locationFeedPresentation(item, { who, amount: metadataDurationLabel(item.metadata, "duration"),
    requested: metadataDurationLabel(item.metadata, "requested_duration"), added: metadataDurationLabel(item.metadata, "added_duration") });
  if (location) return location;
  if (item.activity_group_id?.startsWith("document:")) {
    const selection = documentShareRequestId(
      `document_share_request:${metadataString(item.metadata, "request_id")}`,
    );
    return {
      icon: FileText,
      domainLabel: "Google Drive",
      label: who !== "Someone" ? who : "Files",
      person: counterpartPerson(item.metadata, who),
      description: documentActivitySummary(item),
      exactDestination: selection ? "request" : undefined,
      href: selection ? buildConsentCenterHref("pending", {
        requestId: `document_share_request:${selection}`,
        ...(item.metadata.feed_audience === "recipient" ? { requestView: "sent" as const } : {}),
        from: "/one/feed",
      }) : null,
    };
  }
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

  const outcome = Object.prototype.hasOwnProperty.call(
    AGENT_OUTCOME_COPY,
    item.event_type,
  )
    ? AGENT_OUTCOME_COPY[item.event_type]
    : undefined;
  if (outcome) {
    const family = item.event_type.startsWith("calendar_")
      ? { icon: CalendarAgentIcon, domainLabel: "Calendar" }
      : item.event_type.startsWith("mail_")
        ? { icon: Mail, domainLabel: "Mail" }
        : item.event_type.startsWith("drive_")
          ? { icon: FileText, domainLabel: "Google Drive" }
          : { icon, domainLabel };
    return {
      ...family,
      label: outcome[0],
      description: outcome[1],
      href: outcome[2],
    };
  }

  switch (item.event_type) {
    case "followup_reminder":
      return {
        icon: Mail,
        domainLabel: "Follow-ups",
        label: "Email follow-up reminder",
        description: "A request from your email needs attention.",
        exactDestination: calendarFollowupHref(item.metadata.account_id, item.metadata.request_id) ? "followup" : undefined,
        href: calendarFollowupHref(item.metadata.account_id, item.metadata.request_id) || ROUTES.CALENDAR,
      };
    case "profile_discovery_queued":
      return { icon, domainLabel: "Public profile", label: "Building your profile", description: "A one-time public information search has started in the background.", href: ROUTES.ONE_PROFILE_DISCOVERY };
    case "profile_discovery_scanning":
      return { icon, domainLabel: "Public profile", label: "Still building your profile", description: "Your public profile search is continuing in the background.", href: ROUTES.ONE_PROFILE_DISCOVERY };
    case "profile_discovery_needs_details":
      return { icon, domainLabel: "Public profile", label: "One detail can improve your profile match", description: "Add a profile detail", href: ROUTES.ONE_PROFILE_DISCOVERY };
    case "profile_discovery_ready":
      return { icon, domainLabel: "Public profile", label: "Your profile is ready to review", description: "Choose what to keep", href: ROUTES.ONE_PROFILE_DISCOVERY };
    case "profile_discovery_failed":
      return { icon, domainLabel: "Public profile", label: "Your profile search needs attention", description: "Review and retry", href: ROUTES.ONE_PROFILE_DISCOVERY };
    case "profile_discovery_claimed":
      return { icon, domainLabel: "Public profile", label: "Your profile review is complete", description: "", href: ROUTES.ONE_PROFILE_DISCOVERY };
    case "profile_discovery_cancelled":
      return { icon, domainLabel: "Public profile", label: "Your profile search was cancelled", description: "No further public profile discovery will run for this handoff.", href: null };
    case "pwm_research": {
      const draftId = metadataString(item.metadata, "draft_id");
      const outcome = metadataString(item.metadata, "pwm_outcome");
      const validDraft =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          draftId,
        );
      return {
        icon,
        domainLabel,
        label:
          outcome === "ready" || outcome === "partial"
            ? "Your Personal World Model is ready to review"
            : "Your Personal World Model needs a quick check",
        description:
          outcome === "attention"
            ? "Open your model to check the next step."
            : "Confirm the details that are yours.",
        href: validDraft
          ? `${ROUTES.PROFILE_WORLD_MODEL}?draft_id=${encodeURIComponent(draftId)}`
          : ROUTES.PROFILE_WORLD_MODEL,
      };
    }
    case "connector_connected":
    case "connector_reconnect_required":
    case "connector_disconnected":
      return {
        icon,
        domainLabel,
        label: item.actor_label || "Connected app",
        description:
          item.event_type === "connector_connected"
            ? "Connected to One."
            : item.event_type === "connector_reconnect_required"
              ? "Reconnect this app to keep using it in One."
              : "Disconnected. One no longer has access.",
        recovery: item.event_type === "connector_reconnect_required" ? { href: buildProfilePaneHref("/one/feed", null,
          profileConnectorsLocation(metadataString(item.metadata, "connector_key").replace(/^external:/, ""))), label: "Reconnect" } : undefined,
        href: buildProfileConnectorsPaneHref(),
      };
    case "circle_invite_declined":
    case "circle_invite_cancelled":
    case "circle_member_left":
    case "circle_membership_ended":
    case "circle_deleted":
      return {
        icon,
        domainLabel,
        label: metadataString(item.metadata, "circle_name") || "Circle",
        description:
          item.event_type === "circle_invite_declined"
            ? who === "Someone"
              ? "Your circle invitation was declined."
              : `${who} declined your circle invitation.`
            : item.event_type === "circle_invite_cancelled"
              ? "Your circle invitation was withdrawn."
              : item.event_type === "circle_member_left"
                ? who === "Someone"
                  ? "A member left your circle."
                  : `${who} left your circle.`
                : item.event_type === "circle_membership_ended"
                  ? "Your membership in this circle ended."
                  : "This circle was deleted.",
        href: CONNECT_CIRCLES_LIST_HREF,
      };
    case "drive_question_withdrawn":
    case "drive_question_retry_required":
      return {
        icon: FileText,
        domainLabel: "Google Drive",
        label: "Drive question",
        description:
          item.event_type === "drive_question_withdrawn"
            ? "The requester withdrew this question."
            : "The question could not finish. Review it before allowing another try.",
        exactDestination: documentShareNotificationSelection({ type: "document_share_question", request_id: metadataString(item.metadata, "request_id") }) ? "request" : undefined,
        href: buildConsentCenterHref(
          item.event_type === "drive_question_withdrawn"
            ? "previous"
            : "pending",
          {
            requestId:
              documentShareNotificationSelection({
                type: "document_share_question",
                request_id: metadataString(item.metadata, "request_id"),
              }) || undefined,
          },
        ),
      };
    // Paid answers. Each row goes to the card that owns the decision: the
    // owner's row to the review, the requester's to the price and later the
    // answer. The generic consent path would grant the scopes without ever
    // showing the question or what it costs.
    case "answer_request_received":
    case "answer_request_payment_ready":
    case "answer_request_declined":
    case "answer_delivered": {
      const answerRequestId = metadataString(item.metadata, "request_id");
      const copy: Record<string, [string, string]> = {
        answer_request_received: [
          // The owner's row names the lane it belongs to, in the same words as
          // the profile CTA and the Consent Center row.
          "Request scope",
          "Review the question; set a price",
        ],
        answer_request_payment_ready: [
          "Answer priced",
          "Check answer preparation",
        ],
        answer_request_declined: [
          "Question declined",
          "Check payment details",
        ],
        answer_delivered: ["Answer ready", ""],
      };
      const state = metadataString(item.metadata, "status");
      const terminal = [
        "answered",
        "declined",
        "cancelled",
        "expired",
      ].includes(state || "");
      const [label, originalDescription] = copy[item.event_type] ?? [
        "Question",
        "",
      ];
      const description =
        item.event_type === "answer_request_payment_ready" && state === "staged"
          ? "Their answer is prepared. Open the request to review the price and pay."
          : terminal
            ? `Request ${state}. Open its current status.`
            : state === "answering"
              ? "Payment verified. Open the request to continue."
              : originalDescription;
      return {
        icon,
        domainLabel,
        label,
        description,
        exactDestination: answerRequestId ? "request" : undefined,
        href: buildConsentCenterHref(
          terminal || item.event_type === "answer_request_declined"
            ? "previous"
            : "pending",
          {
            requestId: answerRequestId
              ? `answer_request:${answerRequestId}`
              : undefined,
          },
        ),
      };
    }
    case "connection_withdrawn":
      return {
        icon: UserRound,
        domainLabel,
        label: who === "Someone" ? "Connection" : who,
        person: counterpartPerson(item.metadata, who),
        description: metadataBool(item.metadata, "actor_is_self")
          ? "You withdrew the connection request"
          : "Withdrew the connection request",
        href: ROUTES.CONNECT,
      };
    // Consent rows are person-first like every other request in the Feed, and
    // name what was asked for in the same words as the "Needs you" row and the
    // decision sheet. They used to read "Someone requested Preferences.":
    // no name, a label that disagreed with the access it became, one row per
    // item. `requester_label`, `bundle_id`, `reason` and `scopes` are what the
    // per-request row carries (CONTRACT C5); a per-item row with none of them
    // still reads as a sentence.
    case "consent_requested":
    case "consent_granted":
    case "consent_revoked": {
      const requester = consentRequesterName(item);
      const what = joinInformationLabels(consentRowLabels(item.metadata), 2);
      const reason = reasonMidSentence(metadataString(item.metadata, "reason"));
      const person = requester
        ? counterpartPerson(item.metadata, requester)
        : null;
      if (item.event_type === "consent_requested") {
        return {
          icon,
          domainLabel,
          label: requester || "Information request",
          person,
          description: `${requester ? "Asked" : "Someone asked"} for your ${what}${reason ? ` · ${reason}` : ""}`,
          href: buildConsentCenterHref("pending", {
            bundleId: metadataString(item.metadata, "bundle_id") || undefined,
          }),
        };
      }
      if (item.event_type === "consent_granted") {
        const personRef = metadataString(item.metadata, "person_ref");
        if (iAskedForThis || personRef) {
          return {
            icon: ShieldCheck,
            domainLabel: "Consent",
            label: requester ? `${requester} shared information with you` : "Information shared with you",
            person: counterpartPerson(item.metadata, requester || who),
            description: `Granted access to ${what}. Tap to view.`,
            href: personRef
              ? `/people/${encodeURIComponent(personRef)}?section=shared`
              : buildConsentCenterHref("active"),
          };
        }
        return {
          icon,
          domainLabel,
          label: requester || "Sharing started",
          person,
          description: `You shared your ${what}`,
          href: buildConsentCenterHref("active"),
        };
      }
      return {
        icon,
        domainLabel,
        label: requester || "Sharing ended",
        person,
        description: `You stopped sharing your ${what}`,
        href: buildConsentCenterHref("previous"),
      };
    }
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
        icon: Bot,
        domainLabel: "Private agent",
        label: "Your private agent is on the way",
        description: "We reserved your own private agent. Nothing for you to do.",
        href: null,
      };
    case "personal_agent_provisioning":
      return {
        icon: Bot,
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
        icon: Bot,
        domainLabel: "Private agent",
        label: "Your private agent is starting up",
        description:
          "Your own private compute is running. It is handing over its key so only your agent can read your records.",
        href: null,
      };
    case "personal_agent_ready":
      return {
        icon: Bot,
        domainLabel: "Private agent",
        label: "Your private agent is ready",
        description: "It is set up and ready whenever you are.",
        href: ROUTES.AGENT,
      };
    case "personal_agent_updated":
      return {
        icon: Bot,
        domainLabel: "Private agent",
        label: "Your private agent was updated",
        description: "It is running the newest build, in your own private space.",
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
        icon: Bot,
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
        icon: Bot,
        domainLabel: "Private agent",
        label: "Your private agent is resting",
        description: "It was idle for a while, so we powered it down. It wakes when you need it.",
        href: ROUTES.AGENT,
      };
    case "location_referral_invite": {
      const ownerLabel = metadataString(item.metadata, "owner_label");
      return {
        icon,
        domainLabel,
        label: who !== "Someone" ? who : "Location referral",
        person: counterpartPerson(item.metadata, who),
        description: ownerLabel
          ? `Referred you into a location request for ${ownerLabel}`
          : "Referred you into a location request",
        href: buildOneLocationWorkflowHref({
          requestId: metadataString(item.metadata, "request_id") || undefined,
          referralId: metadataString(item.metadata, "referral_id") || undefined,
          section: "my_requests",
        }),
      };
    }
    case "location_public_invite_submitted": {
      const publicLocationViewed = metadataBool(
        item.metadata,
        "public_location_view",
      );
      return {
        icon,
        domainLabel,
        label: who !== "Someone" ? who : "Public location link",
        person: counterpartPerson(item.metadata, who),
        description: publicLocationViewed
          ? "Opened your public location link"
          : "Requested location access from your public link",
        href: buildOneLocationWorkflowHref({
          requestId: metadataString(item.metadata, "request_id") || undefined,
          submissionId:
            metadataString(item.metadata, "submission_id") || undefined,
          section: "public_responses",
        }),
      };
    }
    case "location_one_network_joined": {
      return {
        icon,
        domainLabel,
        label: who !== "Someone" ? who : "One Network",
        person: counterpartPerson(item.metadata, who),
        description: sharedWithMe
          ? "You joined the One Network"
          : "Joined your One Network",
        href: buildOneLocationWorkflowHref({ section: "people" }),
      };
    }
    case "location_circle_code_joined": {
      const circleName = metadataString(item.metadata, "circle_name");
      return {
        icon,
        domainLabel,
        label: who !== "Someone" ? who : "Circle member",
        person: counterpartPerson(item.metadata, who),
        description: circleName
          ? `Joined ${circleName} using your code`
          : "Joined your Circle using your code",
        href: buildOneLocationWorkflowHref({
          circleId: metadataString(item.metadata, "circle_id") || undefined,
          section: "people",
        }),
      };
    }
    case "location_circle_member_invite_accepted": {
      const circleName = metadataString(item.metadata, "circle_name");
      return {
        icon,
        domainLabel,
        label: who !== "Someone" ? who : "Circle member",
        person: counterpartPerson(item.metadata, who),
        description: circleName
          ? `Accepted your invitation and joined ${circleName}`
          : "Accepted your invitation and joined your Circle",
        href: buildOneLocationWorkflowHref({
          circleId: metadataString(item.metadata, "circle_id") || undefined,
          section: "people",
        }),
      };
    }
    case "circle_member_invited": {
      const circleName = metadataString(item.metadata, "circle_name");
      const inviteId = metadataString(item.metadata, "invite_id");
      return {
        icon,
        domainLabel,
        label: "Circle invitation",
        person: counterpartPerson(item.metadata, who),
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
    case "location_circle_message": {
      const unread = Number(item.metadata.chat_unread_count) || 0;
      return {
        icon: Users,
        domainLabel: "Circle chat",
        label: metadataString(item.metadata, "circle_name") || "Circle chat",
        description:
          unread > 1
            ? `${unread} new messages`
            : unread === 1
              ? "1 new message"
              : "Open your circle chat",
        exactDestination: circleChatHref(metadataString(item.metadata, "circle_id")) ? "conversation" : undefined,
        href: circleChatHref(metadataString(item.metadata, "circle_id")),
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
        person: counterpartPerson(item.metadata, addedBy || who),
        description: addedBy
          ? circleName
            ? `${addedBy} added you to ${circleName}.`
            : `${addedBy} added you to a Circle.`
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
      const runId = metadataString(item.metadata, "run_id");
      return {
        icon,
        domainLabel,
        label: ticker ? `${ticker} analysis finished` : "Analysis finished",
        symbol: ticker || undefined,
        description: "",
        // Open this run's own saved result. `?ticker=` is the stock-preview
        // route: it opened the "Start debate" sheet instead of the result.
        exactDestination: runId ? "report" : undefined,
        href: runId
          ? savedAnalysisFeedHref(getAnalysisHistoryRunRouteId(runId))
          : null,
      };
    }
    case "funding_transfer_status": {
      const status = metadataString(item.metadata, "user_facing_status");
      const direction = metadataString(
        item.metadata,
        "direction",
      ).toUpperCase();
      const transferKind = direction === "OUTGOING" ? "withdrawal"
        : direction === "INCOMING" ? "deposit" : "transfer";
      const statusCopy =
        status === "completed"
          ? "completed"
          : status === "failed"
            ? "failed"
            : status === "returned"
              ? "returned"
              : ["pending", "queued", "processing", "canceled"].includes(status)
                ? status
                : "updated";
      return {
        icon: Banknote,
        domainLabel,
        label: `${transferKind.charAt(0).toUpperCase()}${transferKind.slice(1)} ${statusCopy}`,
        description: "",
        exactDestination: item.metadata?.retained_funding_history === true ? "transfer" : undefined,
        href: item.metadata?.retained_funding_history === true ? historicalFundingFeedHref(item.id) : null,
      };
    }
    case "kyc_status_changed": {
      const status = metadataString(item.metadata, "new_status").replace(
        /_/g,
        " ",
      );
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
      return {
        icon,
        domainLabel,
        label: "App request approved",
        description: "Your app request was approved.",
        href: ROUTES.CONNECTED_SYSTEMS,
      };
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
        label: "App action needs review",
        description: "Open Connected apps to review what happened.",
        href: ROUTES.CONNECTED_SYSTEMS,
      };
    case "calendar_connected":
      return {
        icon: CalendarAgentIcon,
        domainLabel: "Calendar",
        label: "Calendar connected",
        description: "Your calendar is ready in One.",
        href: ROUTES.CALENDAR,
      };
    case "calendar_reconnect_required":
      return {
        icon: CalendarAgentIcon,
        domainLabel: "Calendar",
        label: "Reconnect Calendar",
        recovery: { href: ROUTES.CALENDAR, label: "Reconnect" },
        description: "Reconnect Calendar to keep using it in One.",
        href: ROUTES.CALENDAR,
      };
    case "calendar_disconnected":
      return {
        icon: CalendarAgentIcon,
        domainLabel: "Calendar",
        label: "Calendar disconnected",
        description: "One no longer has access to your calendar.",
        href: ROUTES.CALENDAR,
      };
    case "calendar_event_created":
    case "calendar_event_rescheduled":
    case "calendar_event_canceled":
      return {
        icon: CalendarAgentIcon,
        domainLabel: "Calendar",
        label:
          item.event_type === "calendar_event_created"
            ? "Event created"
            : item.event_type === "calendar_event_rescheduled"
              ? "Event rescheduled"
              : "Event canceled",
        description: "Your confirmed Calendar change is complete.",
        href: ROUTES.CALENDAR,
      };
    case "mail_connected":
      return {
        icon: Mail,
        domainLabel: "Mail",
        label: "Mail connected",
        description: "Your Mail connection is ready in One.",
        href: ROUTES.GMAIL,
      };
    case "mail_reconnect_required":
      return {
        icon: Mail,
        domainLabel: "Mail",
        label: "Reconnect Mail",
        recovery: { href: ROUTES.GMAIL, label: "Reconnect" },
        description: "Open Mail to check your connection.",
        href: ROUTES.GMAIL,
      };
    case "mail_disconnected":
      return {
        icon: Mail,
        domainLabel: "Mail",
        label: "Mail disconnected",
        description: "One no longer has access to your mailbox.",
        href: ROUTES.GMAIL,
      };
    case "mail_information_request_detected":
      return {
        icon: Mail,
        domainLabel: "Mail",
        label: "Information request detected",
        description: "Review a new request in Mail before sharing anything.",
        href: `${ROUTES.GMAIL}?workspace=kyc`,
      };
    case "mail_receipts_imported":
      return {
        icon: Mail,
        domainLabel: "Mail",
        label: "New receipts found",
        description: "Your Mail receipts are ready to review.",
        href: `${ROUTES.GMAIL}?workspace=receipts`,
      };
    case "mail_sync_completed":
      return {
        icon: Mail,
        domainLabel: "Mail",
        label: "Mail is up to date",
        description: "Your manual sync finished without new receipts.",
        href: `${ROUTES.GMAIL}?workspace=receipts`,
      };
    case "mail_sync_failed":
      return {
        icon: Mail,
        domainLabel: "Mail",
        label: "Mail sync interrupted",
        description:
          "Open Mail for the current status; One may retry automatically.",
        href: `${ROUTES.GMAIL}?workspace=receipts`,
      };
    case "mail_message_sent":
    case "mail_message_failed":
    case "mail_delivery_unconfirmed":
      return {
        icon: Mail,
        domainLabel: "Mail",
        label:
          item.event_type === "mail_message_sent"
            ? "Message sent"
            : item.event_type === "mail_message_failed"
              ? "Message wasn't sent"
              : "Message delivery unconfirmed",
        description:
          item.event_type === "mail_message_sent"
            ? ""
            : item.event_type === "mail_message_failed"
              ? "Open Mail to review what happened."
              : "Check Mail before trying again; delivery may have succeeded.",
        href: `${ROUTES.GMAIL}?workspace=kyc`,
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
        person: counterpartPerson(item.metadata, who),
        description: !hasWho
          ? "Connection accepted"
          : actorIsSelf
            ? "You accepted the request"
            : "Accepted your request",
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
        person: counterpartPerson(item.metadata, who),
        description: !hasWho
          ? "Request declined"
          : actorIsSelf
            ? "You declined the request"
            : "Declined your request",
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
        person: counterpartPerson(item.metadata, who),
        description: !hasWho
          ? "Connection removed"
          : actorIsSelf
            ? "You removed this connection"
            : "Removed your connection",
        href: ROUTES.CONNECT,
      };
    }
    case "direct_message_received": {
      const hasWho = who !== "Someone";
      const cardRequest = metadataString(item.metadata, "wallet_card_request_id");
      if (isCardRequestId(cardRequest)) {
        const status = metadataString(item.metadata, "wallet_card_request_status");
        return { icon: ShieldCheck, domainLabel: "Wallet", label: `${who} requested a card`,
          person: counterpartPerson(item.metadata, who),
          description: status === "pending" ? "Choose card" : status === "fulfilled" ? "Card sent" : "View request",
          exactDestination: "card", href: walletCardRequestHref(cardRequest) };
      }
      const cardGrant = metadataString(item.metadata, "wallet_card_grant_id");
      if (cardGrant && /^[a-f0-9-]{36}$/i.test(cardGrant)) {
        return {
          icon: ShieldCheck,
          domainLabel: "Wallet",
          label: `${who} shared their card with you`,
          person: counterpartPerson(item.metadata, who),
          description: "View card",
          exactDestination: directMessageFeedHref(item.metadata) !== ROUTES.ONE_MESSAGES ? "conversation" : undefined,
          href: directMessageFeedHref(item.metadata),
        };
      }
      const preview = walletMessagePreview(
        metadataString(item.metadata, "message_preview"),
      );
      const unread = Number(item.metadata.chat_unread_count) || 0;
      return {
        icon: MessageCircle,
        domainLabel: "Messages",
        label: hasWho ? who : "New message",
        person: counterpartPerson(item.metadata, who),
        description:
          unread > 1
            ? `${unread} new messages${preview ? ` · ${preview}` : ""}`
            : preview || "Sent you a message",
        exactDestination: directMessageFeedHref(item.metadata) !== ROUTES.ONE_MESSAGES ? "conversation" : undefined,
          href: directMessageFeedHref(item.metadata),
      };
    }
    case "document_share_files_sent": {
      // The owner's one card per request, updated as batches are shared. The
      // Feed opens its file list in place; the route is only the fallback.
      const count = Number(item.metadata.shared_count);
      const files = Number.isSafeInteger(count) && count > 0 ? count : 0;
      const filesLabel = `${files} ${files === 1 ? "file" : "files"}`;
      return {
        icon: FileText,
        domainLabel: "Google Drive",
        label: who !== "Someone" ? `One sent ${filesLabel} to ${who}` : `One sent ${filesLabel}`,
        person: counterpartPerson(item.metadata, who),
        description: "Tap to review",
        href: ROUTES.ONE_FEED,
      };
    }
    case "document_share_request_sent":
    case "document_share_request":
    case "document_share_review_ready":
    case "document_share_review_requested":
    case "document_share_payment_ready":
    case "document_share_payment_confirmed":
    case "document_share_payment_refunded":
    case "document_share_decided":
    case "document_share_outcome":
    case "document_share_revoked":
    case "document_share_revocation_outcome":
    case "document_share_question":
    case "document_share_answered":
    case "document_share_declined": {
      const hasWho = who !== "Someone";
      const selection = documentShareNotificationSelection({
        type: item.event_type,
        request_id: metadataString(item.metadata, "request_id"),
      });
      return {
        icon: FileText,
        domainLabel: "Google Drive",
        label: hasWho ? who : "Google Drive",
        person: counterpartPerson(item.metadata, who),
        description: [
          driveFeedLine(
            item.event_type,
            sharedWithMe,
            metadataString(item.metadata, "user_facing_status"),
            item.metadata,
          ),
          ownerDocumentPayoutFeedLine(item.metadata),
        ]
          .filter(Boolean)
          .join(" · "),
        href: ownerDocumentPayoutSetupNeeded(item.metadata)
          ? documentRequestSetupHref("payouts")
          : item.event_type === "document_share_payment_ready" ||
              item.event_type === "document_share_payment_confirmed" ||
              item.event_type === "document_share_payment_refunded"
            ? ROUTES.ONE_FEED
            : buildConsentCenterHref(
                "pending",
                selection ? { requestId: selection } : undefined,
              ),
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

/** Recorded steps never acquire the current operation's headline. */
export function presentFeedMilestone(item: FeedItem): FeedItemPresentation {
  return presentFeedItem({ ...item, activity_group_id: undefined });
}
