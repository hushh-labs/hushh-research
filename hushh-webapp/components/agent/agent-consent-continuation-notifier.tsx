"use client";

// App-shell owner for information requests sent from One chat.
//
// When a request the person sent is answered, the chat that asked continues:
//   * on that chat, its request card continues it in place (this component
//     only nudges the card with the ledger change);
//   * anywhere else in the open app, this component continues it in the
//     background, says what happened at once ("Kushal shared Food
//     preferences"), and the existing "One replied" notice follows when One's
//     answer is written;
//   * from a push tap (`/?informationRequest=<bundle>`), after unlock, it finds
//     the conversation in the person's own sealed history and opens it, where
//     the card continues.
//
// The doorbell is the one app-wide scheduler for requests that are waiting
// (sent in this tab, or rebuilt from the open conversation's history after a
// reload): about every 2s for five minutes while the app is visible, then 5s,
// then 15s, paused while hidden, and at once on focus, a push, or a live
// event. Each tick reads each waiting bundle once, through the shared reader
// (`readInformationRequest`), so a card showing the same request never adds a
// read of its own: it takes the published reading. The moment a request is
// answered it leaves the doorbell; the live-access watch (about 5s, then 10s)
// takes over for as long as that sharing is live. It reads ledger status
// (never values) and holds identifiers only. Shared information is decrypted
// on this device just before the follow-up turn and never stored.

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { dispatchAgentChatHistoryInvalidated } from "@/lib/agent/agent-chat-history-events";
import {
  requestOpenAgentConversation,
  settleWatchedAgentTurn,
  watchDetachedAgentTurn,
} from "@/lib/agent/agent-chat-turn-watch";
import {
  armConsentContinuation,
  claimConsentContinuation,
  clearSentInformationRequests,
  continuedElsewhere,
  isConsentContinuationClaimed,
  isConsentContinuationUnavailable,
  isInformationRequestCardMounted,
  isStaleRestoredAnswer,
  listSentInformationRequests,
  newestWaitingSinceMs,
  prepareConsentContinuation,
  releaseConsentContinuation,
  sentInformationRequest,
  setInformationRequestPhase,
  startInformationRequestDoorbell,
  subscribeSentInformationRequests,
  unwatchSentInformationRequest,
  type SentInformationRequest,
} from "@/lib/agent/consent-continuation";
import { rememberInAppChat } from "@/lib/agent/in-app-chat-selection";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { readInformationRequest } from "@/lib/consent/information-request-reads";
import {
  consentOutcomeDisplayText,
  informationRequestOutcome,
  sharedItemLabels,
  type ConsentOutcome,
} from "@/lib/consent/open-granted-person-information";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { ROUTES } from "@/lib/navigation/routes";
import {
  findInformationRequestConversation,
  streamAgentChat,
} from "@/lib/services/agent-chat-client";
import type { InformationRequestBundle } from "@/lib/services/person-profile-service";
import { useVault } from "@/lib/vault/vault-context";

/** Query parameter an answer push uses to name the request at `/`. */
export const INFORMATION_REQUEST_QUERY = "informationRequest";
export const CONSENT_ANSWER_NOTICE_TITLE = "Your information request has an answer";
const BUNDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_ACTIONS = new Set(["CONSENT_GRANTED", "CONSENT_DENIED", "TIMEOUT", "CONSENT_REVOKED", "REVOKED"]);

function appIsActive(): boolean {
  return appInteractionCoordinator.getLifecycleSnapshot().state === "active";
}

function chatIsVisible(): boolean {
  return (typeof document === "undefined" || document.visibilityState !== "hidden") && appIsActive();
}

export function AgentConsentContinuationNotifier(): null {
  const { user } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const ownerId = user?.uid ?? null;
  const requestedAnswer = searchParams?.get(INFORMATION_REQUEST_QUERY) ?? null;
  const pathnameRef = useRef(pathname);
  const ringRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    clearSentInformationRequests(ownerId);
  }, [ownerId]);

  // Continue answered requests; ring the doorbell for the waiting ones.
  useEffect(() => {
    if (!ownerId || !vaultKey) {
      ringRef.current = () => undefined;
      return undefined;
    }
    const inFlight = new Set<string>();

    const continueInBackground = async (
      request: SentInformationRequest,
      outcome: ConsentOutcome,
      sharedLabels: string[],
      token: string,
    ) => {
      if (!claimConsentContinuation(ownerId, request.bundleId)) return;
      setInformationRequestPhase(ownerId, request.bundleId, "reading");
      toast(consentOutcomeDisplayText({ outcome, personName: request.personName, sharedLabels }), {
        id: `consent-outcome-${request.bundleId}`,
        description: "One is finishing your answer.",
      });
      try {
        const prepared = await prepareConsentContinuation({
          userId: ownerId,
          vaultKey,
          vaultOwnerToken: token,
          bundleId: request.bundleId,
          subjectRef: request.subjectRef,
          outcome,
        });
        if (!prepared) {
          releaseConsentContinuation(ownerId, request.bundleId);
          setInformationRequestPhase(ownerId, request.bundleId, null);
          return;
        }
        watchDetachedAgentTurn({
          ownerId,
          conversationId: request.conversationId,
          startedAtMs: Date.now(),
        });
        await streamAgentChat({
          userId: ownerId,
          message: prepared.message,
          conversationId: request.conversationId,
          vaultOwnerToken: token,
          vaultKey,
          consentContinuation: prepared.continuation,
        });
        setInformationRequestPhase(ownerId, request.bundleId, "answered");
        dispatchAgentChatHistoryInvalidated(ownerId);
        // Raises the existing "One replied" notice with an Open action.
        settleWatchedAgentTurn(ownerId, request.conversationId, true);
      } catch {
        // Another device may have continued this answer first; the server
        // refused ours (409). That answer is in the chat already: no error.
        if (await continuedElsewhere({
          conversationId: request.conversationId,
          bundleId: request.bundleId,
          vaultOwnerToken: token,
          vaultKey,
        })) {
          setInformationRequestPhase(ownerId, request.bundleId, "answered");
          settleWatchedAgentTurn(ownerId, request.conversationId, true);
          dispatchAgentChatHistoryInvalidated(ownerId);
          toast.dismiss(`consent-outcome-${request.bundleId}`);
          return;
        }
        releaseConsentContinuation(ownerId, request.bundleId);
        setInformationRequestPhase(ownerId, request.bundleId, null);
        settleWatchedAgentTurn(ownerId, request.conversationId, false);
        toast.error("One couldn't finish that answer. Open the chat to try again.", {
          id: `consent-outcome-${request.bundleId}`,
        });
      }
    };

    const onAnswered = (request: SentInformationRequest, bundle: InformationRequestBundle) => {
      const outcome = informationRequestOutcome(bundle);
      if (!outcome) return;
      if (request.restored && isStaleRestoredAnswer(bundle)) {
        // Rebuilt from an old chat and answered long ago: it stays as it is.
        unwatchSentInformationRequest(ownerId, request.bundleId);
        return;
      }
      if (isInformationRequestCardMounted(ownerId, request.bundleId)) {
        // The card on screen owns this. It already has this very reading
        // (the shared reader published it), so it shows "Reading…" now and
        // continues in place. The request stops waiting: answered means no
        // more fast checks (measured 2026-09-29: an answered request left
        // waiting was polled 166 times in 18 minutes, plus a card-wide
        // refresh event every 10s). The card may still continue it.
        armConsentContinuation(ownerId, request.bundleId);
        unwatchSentInformationRequest(ownerId, request.bundleId);
        setInformationRequestPhase(ownerId, request.bundleId, "reading");
        // No receipt, so no follow-up turn: the card shows the answer.
        if (isConsentContinuationUnavailable(ownerId, request.bundleId)) return;
        // Continued on another device already: the card settles as answered
        // and this one stops waiting; nothing here is an error.
        const token = getVaultOwnerToken();
        if (token) {
          void continuedElsewhere({
            conversationId: request.conversationId,
            bundleId: request.bundleId,
            vaultOwnerToken: token,
            vaultKey,
          }).then((done) => {
            // This tab's own continuation also leaves the marker; only
            // another device's answer settles the card from here.
            if (!done || isConsentContinuationClaimed(ownerId, request.bundleId)) return;
            setInformationRequestPhase(ownerId, request.bundleId, "answered");
          });
        }
        return;
      }
      if (isConsentContinuationUnavailable(ownerId, request.bundleId)) {
        // The server would refuse this follow-up (no receipt): stay quiet.
        unwatchSentInformationRequest(ownerId, request.bundleId);
        return;
      }
      const token = getVaultOwnerToken();
      if (token) void continueInBackground(request, outcome, sharedItemLabels(bundle), token);
    };

    // The only server call: GET /api/one/information-requests/{bundle}, one
    // per waiting bundle per tick, shared with any other reader of it.
    const poll = () => {
      const token = getVaultOwnerToken();
      if (!token) return;
      for (const request of listSentInformationRequests(ownerId)) {
        if (inFlight.has(request.bundleId)) continue;
        inFlight.add(request.bundleId);
        void readInformationRequest({
          bundleId: request.bundleId,
          vaultOwnerToken: token,
        })
          .then((bundle) => {
            if (bundle.bundleId.toLowerCase() !== request.bundleId) return;
            onAnswered(request, bundle);
          })
          .catch(() => undefined)
          .finally(() => inFlight.delete(request.bundleId));
      }
    };
    const doorbell = startInformationRequestDoorbell({
      check: poll,
      hasWaiting: () => listSentInformationRequests(ownerId).length > 0,
      waitingSinceMs: () => newestWaitingSinceMs(ownerId),
      isVisible: chatIsVisible,
    });
    ringRef.current = doorbell.ring;
    const unsubscribe = subscribeSentInformationRequests(doorbell.ring);
    const unsubscribeLifecycle = appInteractionCoordinator.subscribeLifecycle(doorbell.visibilityChanged);
    doorbell.ring();
    return () => {
      doorbell.stop();
      unsubscribe();
      unsubscribeLifecycle();
      ringRef.current = () => undefined;
    };
  }, [getVaultOwnerToken, ownerId, vaultKey]);

  // A push or live event about an answer: check now, or offer to open it.
  useEffect(() => {
    if (!ownerId) return undefined;
    const onConsentChanged = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail?.source !== "information_request_updated") return;
      const bundleId = String(detail.bundleId || "").toLowerCase();
      if (!BUNDLE_ID.test(bundleId)) return;
      // Any doorbell for a waiting request checks now; the ledger read decides.
      if (sentInformationRequest(ownerId, bundleId)) {
        ringRef.current();
        return;
      }
      const action = String(detail.action || "").toUpperCase();
      if (!TERMINAL_ACTIONS.has(action)) return;
      // A stop to sharing is not a new answer; the open chat hides what it
      // derived from it (see the workspace's access-ended handling).
      if (action === "CONSENT_REVOKED" || action === "REVOKED") return;
      if (pathnameRef.current === ROUTES.HOME) return; // the open chat reads its own cards
      toast(CONSENT_ANSWER_NOTICE_TITLE, {
        id: `consent-answer-${bundleId}`,
        action: {
          label: "Open",
          onClick: () =>
            router.push(`${ROUTES.HOME}?${new URLSearchParams({ [INFORMATION_REQUEST_QUERY]: bundleId })}`),
        },
      });
    };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
    return () => window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
  }, [ownerId, router]);

  // `/?informationRequest=<bundle>`: find the asking chat after unlock, open it.
  useEffect(() => {
    if (pathname !== ROUTES.HOME || !ownerId || requestedAnswer === null) return;
    const requested = requestedAnswer;
    const token = getVaultOwnerToken();
    if (!vaultKey || !token) return; // re-runs once the vault is unlocked
    let active = true;
    const bundleId = requested.toLowerCase();
    void (async () => {
      const conversationId = BUNDLE_ID.test(bundleId)
        ? await findInformationRequestConversation({ bundleId, vaultOwnerToken: token, vaultKey })
            .catch(() => null)
        : null;
      if (!active) return;
      if (conversationId) {
        armConsentContinuation(ownerId, bundleId);
        rememberInAppChat(ownerId, conversationId);
        requestOpenAgentConversation(ownerId, conversationId);
      }
      router.replace(ROUTES.HOME, { scroll: false });
    })();
    return () => {
      active = false;
    };
  }, [getVaultOwnerToken, ownerId, pathname, requestedAnswer, router, vaultKey]);

  return null;
}
