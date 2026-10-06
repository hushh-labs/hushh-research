/**
 * Copy for a chat turn that could not reach, or was refused by, the person's
 * own private agent before it ran.
 *
 * Every output is a fixed sentence keyed by a typed code from the direct path
 * (lib/services/pod-app-access.ts, lib/services/owner-pod-endpoint.ts,
 * lib/agent/owner-pod-wake.ts) or by a browser's fixed network-failure text.
 * No transport or server detail is ever echoed into the transcript.
 */
import {
  POD_DEVICE_OFFLINE,
  POD_NOT_REACHED,
  POD_SEND_UNCONFIRMED,
  POD_WAKE_TIMEOUT,
} from "@/lib/agent/owner-pod-wake";

const NOT_READY =
  "Your private agent connection is not ready. Open Hosting in Settings to reconnect, then try again.";
const NOT_ESTABLISHED =
  "Your private agent connection could not be established. Check Hosting in Settings, then try again.";
const MOVED =
  "Your private agent moved, and this device could not confirm its new address. Open Hosting in Settings to reconnect, then try again.";
const NOT_CONFIRMED = "Hussh could not confirm this chat with your private agent. Try again in a moment.";
/** The hub says AGENT_NOT_READY for a starting agent and for one that needs attention, so say neither. */
const NOT_READY_TO_CHAT = "Your private agent isn't ready to chat yet. Try again in a moment. If this keeps happening, open Hosting in Settings.";
/** The hub's own migrating sentence (pod_relay._not_ready), used if its copy is missing or unsafe. */
const MIGRATING = "Your agent is moving to your cloud. This takes a minute or two.";
/** A hub-written sentence is shown only when it is plain words: no links, codes, or dashes. */
const HUB_SENTENCE = /^[A-Z][A-Za-z0-9 ,.'’]{0,198}\.$/;
const CHAT_GRANTS_REFUSAL = /^POD_CHAT_AUTHORITY_UNAVAILABLE:\d{3}(?::([A-Z][A-Z_]{0,63}))?$/;

const FIXED_MESSAGES: Readonly<Record<string, string>> = {
  "ENDPOINT_UNAVAILABLE:POD_DIRECT_NOT_READY": NOT_READY,
  POD_CHAT_BUSY: "Your private agent is finishing active work. Try again shortly.",
  POD_CHAT_RECOVERY_FAILED: "This answer could not be saved safely. Reconnect to your private agent before continuing.",
  POD_CHAT_AUTHORITY_UNAVAILABLE: "This action is not available through your private agent yet.",
  POD_APP_ROUTE_REFUSED: "This action is not available through your private agent yet.",
  [POD_WAKE_TIMEOUT]: "Your private agent did not wake up in time, so your message was not sent. Try again in a minute.",
  [POD_NOT_REACHED]: "Your private agent could not be reached, so your message was not sent. Try again in a moment.",
  [POD_SEND_UNCONFIRMED]:
    "The connection to your private agent dropped, so your message may not have been sent. Check this chat before you send it again.",
  [POD_DEVICE_OFFLINE]: "This device is offline, so your message was not sent. Check your internet connection, then try again.",
  POD_ASSIGNMENT_CHANGED: MOVED,
  POD_DIRECT_OWNER_MISMATCH: MOVED,
  POD_CHAT_GRANTS_INVALID: NOT_CONFIRMED,
  POD_OWNER_CHANGED: "You switched accounts while One was sending. Open chat again to continue.",
};

/** Fixed browser text for a request that never got a response (Chrome, Safari, Firefox). */
const BROWSER_NETWORK_FAILURES = new Set([
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
]);

const CONNECTION_REFUSAL = /^(?:ENDPOINT_UNAVAILABLE|BINDING_UNAVAILABLE|POD_CHALLENGE_REFUSED|POD_ADMISSION_REFUSED):[A-Za-z0-9_]+$/;
const ENDPOINT_PIN_REFUSAL = /^ENDPOINT_(?:MALFORMED|VERSION_REGRESSION|CHANGED_WITHOUT_VERSION_BUMP|OWNER_OR_ENVIRONMENT_CHANGED)$/;

/**
 * The hub's chat-grants refusal. A 409 means one of three things, and only one
 * of them is a move: telling a starting agent's owner to reconnect is the wrong fix.
 */
function chatGrantsRefusalMessage(code: string, message: string): string | null {
  const match = CHAT_GRANTS_REFUSAL.exec(code);
  if (!match) return null;
  const hubCode = match[1];
  if (hubCode === "AGENT_MIGRATING") return HUB_SENTENCE.test(message.trim()) ? message.trim() : MIGRATING;
  if (hubCode === "AGENT_NOT_READY") return NOT_READY_TO_CHAT;
  if (hubCode === "POD_ASSIGNMENT_CHANGED") return MOVED;
  return NOT_CONFIRMED;
}

/**
 * The owner-safe sentence for a direct-path failure, or null when the failure
 * is not one. The typed code wins; a bare message is matched only exactly.
 */
export function ownerPodTurnErrorMessage(message: string, code?: string): string | null {
  const connectionCode = code || message.trim();
  const fixed = FIXED_MESSAGES[connectionCode];
  if (fixed) return fixed;
  if (CONNECTION_REFUSAL.test(connectionCode) || ENDPOINT_PIN_REFUSAL.test(connectionCode)) return NOT_ESTABLISHED;
  const grantsRefusal = chatGrantsRefusalMessage(connectionCode, message);
  if (grantsRefusal) return grantsRefusal;
  if (!code && BROWSER_NETWORK_FAILURES.has(message.trim())) {
    return "One could not be reached. Check your internet connection, then try again.";
  }
  return null;
}
