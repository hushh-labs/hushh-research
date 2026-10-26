/** Typed navigation targets shared by native taps and the web bridge. */
import { circleChatNotificationTarget } from "@/lib/circle-chat/routes";
import { ROUTES } from "@/lib/navigation/routes";
import { isAgentConversationId } from "@/lib/agent/agent-chat-turn-watch";
import { feedAttentionTapTarget } from "@/lib/agent/feed-attention";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { documentRequestSetupHref, isDocumentRequestSetupStep, type DocumentRequestSetupStep } from "@/lib/consent/document-request-setup";
import { documentShareNotificationRequestId, documentShareNotificationSelection } from "@/lib/consent/document-share-consent";
import { buildOneLocationWorkflowHref } from "@/lib/one-location/notifications";

export function normalizedDocumentShareType(
  data: Record<string, unknown> | undefined,
): string {
  return typeof data?.type === "string" ? data.type.trim().toLowerCase() : "";
}

/**
 * The owner's unmet setup step on a document request push. Only this closed
 * value, on this one type with an exact request UUID, can choose a setup
 * screen; any other value is dropped and the tap keeps the review route.
 */
export function documentShareNotificationSetup(
  data: Record<string, unknown> | undefined,
): DocumentRequestSetupStep | null {
  if (normalizedDocumentShareType(data) !== "document_share_request") return null;
  if (!documentShareNotificationRequestId(data)) return null;
  const setup = data?.setup;
  return isDocumentRequestSetupStep(setup) ? setup : null;
}

/**
 * Builds the only Drive-sharing click target. This intentionally does not
 * inspect request_url, deep_link, url, file names, or any provider payload.
 * Keep aligned with notificationTapTarget in public/firebase-messaging-sw.js.
 */
export function documentShareNotificationTapTarget(
  data: Record<string, unknown> | undefined,
): string | null {
  const type = normalizedDocumentShareType(data);
  if ((type === "document_share_payment_ready" || type === "document_share_payment_confirmed" ||
      type === "document_share_payment_refunded") &&
      documentShareNotificationRequestId(data)) return ROUTES.ONE_FEED;
  // An owner who must set something up first goes straight to that screen.
  const setup = documentShareNotificationSetup(data);
  if (setup) return documentRequestSetupHref(setup);
  const selection = documentShareNotificationSelection(data);
  if (!selection) return null;
  return buildConsentCenterHref("pending", { requestId: selection });
}

function incomingLocationShareTarget(
  data: Record<string, unknown> | undefined,
): string | null {
  const type = String(data?.type || "")
    .trim()
    .toLowerCase();
  // These alerts are sent only to the person receiving location access.
  // Open the list using current authorization, not stale grant/request intent.
  // Keep this allowlist aligned with notificationTapTarget in the web worker.
  if (
    type === "location_share_created" ||
    type === "location_access_approved"
  ) {
    return buildOneLocationWorkflowHref({ section: "shared" });
  }
  return null;
}

/**
 * "One replied" is a bare wake-up: type plus an opaque conversation id. The
 * tap opens that conversation at `/`; the chat loads it only after unlock and
 * only if it is in the owner's own history. `deep_link` is never trusted.
 * The server sends this type to native devices only, so the web worker's
 * `notificationTapTarget` deliberately has no case for it.
 */
export function oneReplyNotificationTapTarget(
  data: Record<string, unknown> | undefined,
): string | null {
  const type = String(data?.type || "")
    .trim()
    .toLowerCase();
  if (type !== "one_reply") return null;
  const conversationId = String(data?.conversation_id || "").trim();
  if (!isAgentConversationId(conversationId)) return ROUTES.HOME;
  return `${ROUTES.HOME}?${new URLSearchParams({ conversation: conversationId }).toString()}`;
}

const INFORMATION_REQUEST_BUNDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Your information request has an answer" is a bare wake-up for the person
 * who asked. It carries the request bundle id only; the app finds the
 * conversation that asked in the person's own sealed history after unlock and
 * continues it there. `deep_link` is never trusted.
 */
export function informationRequestAnswerTapTarget(
  data: Record<string, unknown> | undefined,
): string | null {
  const type = String(data?.type || "")
    .trim()
    .toLowerCase();
  if (type !== "information_request_updated") return null;
  const bundleId = String(data?.bundle_id || "").trim();
  if (!INFORMATION_REQUEST_BUNDLE_ID.test(bundleId)) return ROUTES.HOME;
  return `${ROUTES.HOME}?${new URLSearchParams({ informationRequest: bundleId }).toString()}`;
}

/** A direct-message push carries opaque ids only; the authenticated inbox reloads the body. */
export function directMessageNotificationTapTarget(
  data: Record<string, unknown> | undefined,
): string | null {
  const type = String(data?.type || "").trim().toLowerCase();
  if (type !== "direct_message") return null;
  const routeToken = String(data?.route_token || "");
  if (routeToken.startsWith("dm1.")) return `/one/messages?token=${encodeURIComponent(routeToken)}`;
  return ROUTES.ONE_MESSAGES;
}

export function buildNotificationTapTarget(
  data: Record<string, unknown> | undefined,
): string {
  if (data?.type === "todo_reminder") return ROUTES.ONE_TODOS;
  const circleTarget = circleChatNotificationTarget(data);
  if (circleTarget) return circleTarget;
  const directMessageTarget = directMessageNotificationTapTarget(data);
  if (directMessageTarget) return directMessageTarget;
  const oneReplyTarget = oneReplyNotificationTapTarget(data);
  if (oneReplyTarget) return oneReplyTarget;
  const answerTarget = informationRequestAnswerTapTarget(data);
  if (answerTarget) return answerTarget;
  // "One has something for you": native only, like one_reply, so the web
  // worker's `notificationTapTarget` deliberately has no case for it.
  const feedAttentionTarget = feedAttentionTapTarget(data);
  if (feedAttentionTarget) return feedAttentionTarget;
  const locationTarget = incomingLocationShareTarget(data);
  if (locationTarget) return locationTarget;
  const documentShareTarget = documentShareNotificationTapTarget(data);
  if (documentShareTarget) return documentShareTarget;
  if (
    String(data?.type || "")
      .trim()
      .toLowerCase() !== "consent_request"
  ) {
    return ROUTES.ONE_FEED;
  }
  const params = new URLSearchParams();
  const requestId = String(data?.request_id || "").trim();
  const bundleId = String(data?.bundle_id || "").trim();
  if (requestId) params.set("notificationRequestId", requestId);
  if (bundleId) params.set("notificationBundleId", bundleId);
  const search = params.toString();
  return search ? `${ROUTES.ONE_FEED}?${search}` : ROUTES.ONE_FEED;
}

export function resolveNotificationClickTarget(
  value: unknown,
  data: Record<string, unknown> | undefined,
): string {
  if (data?.type === "todo_reminder") return ROUTES.ONE_TODOS;
  const circleTarget = circleChatNotificationTarget(data);
  if (circleTarget) return circleTarget;
  // Older workers send a Feed URL but retain the original typed payload.
  // Only this known event family may bypass the existing Feed URL boundary.
  const directMessageTarget = directMessageNotificationTapTarget(data);
  if (directMessageTarget) return directMessageTarget;
  const locationTarget = incomingLocationShareTarget(data);
  if (locationTarget) return locationTarget;
  const documentShareTarget = documentShareNotificationTapTarget(data);
  if (documentShareTarget) return documentShareTarget;
  const href = typeof value === "string" ? value.trim() : "";
  if (!href || /[\r\n]/.test(href)) return ROUTES.ONE_FEED;
  try {
    const parsed = new URL(href, "https://hushh.local");
    if (parsed.pathname !== ROUTES.ONE_FEED) return ROUTES.ONE_FEED;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return ROUTES.ONE_FEED;
  }
}
