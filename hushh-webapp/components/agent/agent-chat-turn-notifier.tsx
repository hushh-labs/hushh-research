"use client";

// App-shell owner for One turns that outlive the screen that started them.
//
// A turn keeps running on the server when the person leaves the chat or the
// native app goes to the background, and its answer is sealed into history.
// This component, mounted once above every route:
//   * stops reading in-flight turns when the native app goes to the background,
//     so the server knows nobody saw the answer and sends its bare push;
//   * polls a detached turn's state (two flags, never message text) while the
//     app is open and the vault unlocked, until the answer is written;
//   * shows "One replied" with an Open action when the person is elsewhere in
//     the app, and nothing when they are already looking at that chat;
//   * opens the conversation a push tap named (`/?conversation=<id>`), after
//     unlock, through the chat's own owner-checked history load.
//
// It holds identifiers only. The notice never carries answer text, so a locked
// vault reveals nothing.

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { dispatchAgentChatHistoryInvalidated } from "@/lib/agent/agent-chat-history-events";
import {
  AGENT_TURN_WATCH_WINDOW_MS,
  clearWatchedAgentTurns,
  decideAgentTurnNotice,
  detachAttachedAgentTurns,
  isAgentConversationId,
  listWatchedAgentTurns,
  markWatchedAgentTurnForeground,
  requestOpenAgentConversation,
  setAgentTurnAppBackgrounded,
  settleWatchedAgentTurn,
  subscribeAgentTurnSettled,
  subscribeWatchedAgentTurns,
  type AgentTurnSettled,
} from "@/lib/agent/agent-chat-turn-watch";
import { rememberInAppChat, selectedInAppChat } from "@/lib/agent/in-app-chat-selection";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { ROUTES } from "@/lib/navigation/routes";
import { getAgentChatTurnState } from "@/lib/services/agent-chat-client";
import { useVault } from "@/lib/vault/vault-context";

export const ONE_REPLY_NOTICE_TITLE = "One replied";
export const ONE_REPLY_NOTICE_DESCRIPTION = "Your answer is ready.";
/** Query parameter a push tap uses to name the conversation to open at `/`. */
export const AGENT_CONVERSATION_QUERY = "conversation";

const POLL_INTERVAL_MS = 2_500;
// Each status read decrypts the conversation server-side; slow down once a
// turn has run past the first half minute.
const SLOW_POLL_AFTER_MS = 30_000;
const SLOW_POLL_INTERVAL_MS = 6_000;

function appIsActive(): boolean {
  return appInteractionCoordinator.getLifecycleSnapshot().state === "active";
}

export function AgentChatTurnNotifier(): null {
  const { user } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const pathname = usePathname();
  const router = useRouter();
  const ownerId = user?.uid ?? null;

  const pathnameRef = useRef(pathname);
  const ownerRef = useRef(ownerId);
  const deferredRef = useRef<AgentTurnSettled[]>([]);
  const pollRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    pathnameRef.current = pathname;
    ownerRef.current = ownerId;
  }, [ownerId, pathname]);

  // Watches belong to one signed-in owner; sign-out or a switch drops the rest.
  useEffect(() => {
    clearWatchedAgentTurns(ownerId);
    deferredRef.current = deferredRef.current.filter((turn) => turn.ownerId === ownerId);
  }, [ownerId]);

  useEffect(() => {
    const openConversation = (owner: string, conversationId: string) => {
      rememberInAppChat(owner, conversationId);
      if (pathnameRef.current === ROUTES.HOME) {
        requestOpenAgentConversation(owner, conversationId);
      } else {
        router.push(ROUTES.HOME);
      }
    };

    const present = (turn: AgentTurnSettled) => {
      if (!turn.answered || turn.ownerId !== ownerRef.current) return;
      const notice = decideAgentTurnNotice({
        viewingConversation:
          pathnameRef.current === ROUTES.HOME &&
          selectedInAppChat(turn.ownerId) === turn.conversationId,
        pageVisible: appIsActive(),
        pushOwnsNotice: Capacitor.isNativePlatform() && turn.backgroundedSinceDetach,
      });
      if (notice === "defer") {
        deferredRef.current = [...deferredRef.current, turn];
        return;
      }
      if (notice !== "toast") return;
      toast(ONE_REPLY_NOTICE_TITLE, {
        id: `one-reply-${turn.conversationId}`,
        description: ONE_REPLY_NOTICE_DESCRIPTION,
        action: {
          label: "Open",
          onClick: () => openConversation(turn.ownerId, turn.conversationId),
        },
      });
    };

    const onLifecycle = () => {
      setAgentTurnAppBackgrounded(!appIsActive());
      if (!appIsActive()) {
        // Native only: a backgrounded app stops reading so the server, seeing
        // the stream close, owns the notice. A hidden browser tab keeps reading.
        if (Capacitor.isNativePlatform()) detachAttachedAgentTurns();
        return;
      }
      const deferred = deferredRef.current;
      deferredRef.current = [];
      for (const turn of deferred) present(turn);
      pollRef.current();
    };

    const unsubscribeSettled = subscribeAgentTurnSettled(present);
    const unsubscribeLifecycle = appInteractionCoordinator.subscribeLifecycle(onLifecycle);
    return () => {
      unsubscribeSettled();
      unsubscribeLifecycle();
    };
  }, [router]);

  // A turn the person left keeps its conversation as the chat to return to.
  useEffect(() => {
    if (!ownerId) return undefined;
    const seen = new Set<string>();
    return subscribeWatchedAgentTurns(() => {
      for (const turn of listWatchedAgentTurns()) {
        if (turn.ownerId !== ownerId || seen.has(turn.conversationId)) continue;
        seen.add(turn.conversationId);
        if (!selectedInAppChat(ownerId)) rememberInAppChat(ownerId, turn.conversationId);
      }
      pollRef.current();
    });
  }, [ownerId]);

  // Reattach: read each detached turn's two flags until its answer is written.
  useEffect(() => {
    if (!ownerId || !vaultKey) {
      pollRef.current = () => undefined;
      return undefined;
    }
    const inFlight = new Set<string>();
    const lastReadAt = new Map<string, number>();
    const poll = () => {
      if (!appIsActive()) return;
      const token = getVaultOwnerToken();
      if (!token) return;
      for (const turn of listWatchedAgentTurns()) {
        if (turn.ownerId !== ownerId || inFlight.has(turn.conversationId)) continue;
        const elapsed = Date.now() - turn.startedAtMs;
        const interval = elapsed > SLOW_POLL_AFTER_MS ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
        if (Date.now() - (lastReadAt.get(turn.conversationId) ?? 0) < interval - 100) continue;
        if (elapsed > AGENT_TURN_WATCH_WINDOW_MS) {
          dispatchAgentChatHistoryInvalidated(ownerId);
          settleWatchedAgentTurn(ownerId, turn.conversationId, false);
          continue;
        }
        inFlight.add(turn.conversationId);
        lastReadAt.set(turn.conversationId, Date.now());
        void getAgentChatTurnState({
          conversationId: turn.conversationId,
          vaultOwnerToken: token,
          vaultKey,
        })
          .then((state) => {
            if (ownerRef.current !== ownerId) return;
            if (state.pending) {
              markWatchedAgentTurnForeground(ownerId, turn.conversationId);
              return;
            }
            // The next history read must see the written answer, not the cache.
            dispatchAgentChatHistoryInvalidated(ownerId);
            settleWatchedAgentTurn(ownerId, turn.conversationId, state.answered);
          })
          .catch(() => undefined)
          .finally(() => inFlight.delete(turn.conversationId));
      }
    };
    pollRef.current = poll;
    poll();
    const intervalId = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
      pollRef.current = () => undefined;
    };
  }, [getVaultOwnerToken, ownerId, vaultKey]);

  // A push tap lands on `/?conversation=<id>`. Select it through the chat's own
  // owner-checked load (which waits for unlock), then drop the parameter.
  useEffect(() => {
    if (pathname !== ROUTES.HOME || !ownerId || typeof window === "undefined") return;
    const requested = new URLSearchParams(window.location.search).get(AGENT_CONVERSATION_QUERY);
    if (requested === null) return;
    if (isAgentConversationId(requested)) {
      rememberInAppChat(ownerId, requested);
      requestOpenAgentConversation(ownerId, requested);
    }
    router.replace(ROUTES.HOME, { scroll: false });
  }, [ownerId, pathname, router]);

  return null;
}
