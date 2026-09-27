"use client";

// App-shell owner for information requests sent from One chat.
//
// When a request the person sent is answered, the chat that asked continues:
//   * on that chat, its request card continues it in place (this component
//     only nudges the card with the ledger change);
//   * anywhere else in the open app, this component continues it in the
//     background, says "Consent approved" (or the honest outcome) at once, and
//     the existing "One replied" notice follows when One's answer is written;
//   * from a push tap (`/?informationRequest=<bundle>`), after unlock, it finds
//     the conversation in the person's own sealed history and opens it, where
//     the card continues.
//
// It polls only requests this tab saw waiting, reads ledger status (never
// values) and holds identifiers only. Shared information is decrypted on this
// device just before the follow-up turn and never stored.

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
  isInformationRequestCardMounted,
  listSentInformationRequests,
  prepareConsentContinuation,
  releaseConsentContinuation,
  sentInformationRequest,
  subscribeSentInformationRequests,
  type SentInformationRequest,
} from "@/lib/agent/consent-continuation";
import { rememberInAppChat } from "@/lib/agent/in-app-chat-selection";
import { CONSENT_STATE_CHANGED_EVENT, dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import {
  CONSENT_OUTCOME_LABELS,
  informationRequestOutcome,
  type ConsentOutcome,
} from "@/lib/consent/open-granted-person-information";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { ROUTES } from "@/lib/navigation/routes";
import {
  findInformationRequestConversation,
  streamAgentChat,
} from "@/lib/services/agent-chat-client";
import {
  PersonProfileService,
  type InformationRequestBundle,
} from "@/lib/services/person-profile-service";
import { useVault } from "@/lib/vault/vault-context";

/** Query parameter an answer push uses to name the request at `/`. */
export const INFORMATION_REQUEST_QUERY = "informationRequest";
export const CONSENT_ANSWER_NOTICE_TITLE = "Your information request has an answer";
const POLL_INTERVAL_MS = 8_000;
const BUNDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_ACTIONS = new Set(["CONSENT_GRANTED", "CONSENT_DENIED", "TIMEOUT"]);
const LEDGER_ACTION: Record<ConsentOutcome, string> = {
  granted: "CONSENT_GRANTED",
  denied: "CONSENT_DENIED",
  expired: "TIMEOUT",
};

function appIsActive(): boolean {
  return appInteractionCoordinator.getLifecycleSnapshot().state === "active";
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
  const pollRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    clearSentInformationRequests(ownerId);
  }, [ownerId]);

  // Continue answered requests; poll the ones this tab is waiting on.
  useEffect(() => {
    if (!ownerId || !vaultKey) {
      pollRef.current = () => undefined;
      return undefined;
    }
    const inFlight = new Set<string>();

    const continueInBackground = async (
      request: SentInformationRequest,
      outcome: ConsentOutcome,
      token: string,
    ) => {
      if (!claimConsentContinuation(ownerId, request.bundleId)) return;
      toast(CONSENT_OUTCOME_LABELS[outcome], {
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
        dispatchAgentChatHistoryInvalidated(ownerId);
        // Raises the existing "One replied" notice with an Open action.
        settleWatchedAgentTurn(ownerId, request.conversationId, true);
      } catch {
        releaseConsentContinuation(ownerId, request.bundleId);
        settleWatchedAgentTurn(ownerId, request.conversationId, false);
        toast.error("One couldn't finish that answer. Open the chat to try again.", {
          id: `consent-outcome-${request.bundleId}`,
        });
      }
    };

    const onAnswered = (request: SentInformationRequest, bundle: InformationRequestBundle) => {
      const outcome = informationRequestOutcome(bundle);
      if (!outcome) return;
      if (isInformationRequestCardMounted(ownerId, request.bundleId)) {
        // The card on screen owns this; tell it the ledger moved.
        dispatchConsentStateChanged({
          source: "information_request_updated",
          bundleId: request.bundleId,
          requestId: bundle.items[0]?.requestId ?? "",
          action: LEDGER_ACTION[outcome],
        });
        return;
      }
      const token = getVaultOwnerToken();
      if (token) void continueInBackground(request, outcome, token);
    };

    const poll = () => {
      if (!appIsActive()) return;
      const token = getVaultOwnerToken();
      if (!token) return;
      for (const request of listSentInformationRequests(ownerId)) {
        if (inFlight.has(request.bundleId)) continue;
        inFlight.add(request.bundleId);
        void PersonProfileService.getInformationRequest({
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
    pollRef.current = poll;
    poll();
    const intervalId = window.setInterval(poll, POLL_INTERVAL_MS);
    const unsubscribe = subscribeSentInformationRequests(poll);
    return () => {
      window.clearInterval(intervalId);
      unsubscribe();
      pollRef.current = () => undefined;
    };
  }, [getVaultOwnerToken, ownerId, vaultKey]);

  // A push or live event about an answer: check now, or offer to open it.
  useEffect(() => {
    if (!ownerId) return undefined;
    const onConsentChanged = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail?.source !== "information_request_updated") return;
      const bundleId = String(detail.bundleId || "").toLowerCase();
      if (!BUNDLE_ID.test(bundleId) || !TERMINAL_ACTIONS.has(String(detail.action || ""))) return;
      if (sentInformationRequest(ownerId, bundleId)) {
        pollRef.current();
        return;
      }
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
