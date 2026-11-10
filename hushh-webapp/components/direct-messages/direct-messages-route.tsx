"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { DirectMessagesService } from "@/lib/services/direct-messages-service";
import { DirectMessagesResourceService, type DirectMessageSelection } from "@/lib/services/direct-messages-resource-service";
import { resolveDirectMessageHref } from "@/lib/direct-messages/navigate-direct-message";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { DirectMessagesPage } from "./direct-messages-page";
import { MessagesDraftService } from "@/lib/services/messages-draft-service";

import { readMessageHistory, replaceMessageHistory, subscribeMessageHistory } from "@/lib/direct-messages/message-history";
import {
  parseLastMessagesSelection,
  readLastMessagesSelection,
  subscribeLastMessagesSelection,
  writeLastMessagesSelection,
} from "@/lib/direct-messages/last-selection";

export function DirectMessagesRoute() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, userId, loading } = useAuth();
  const historySelection = useSyncExternalStore(subscribeMessageHistory, readMessageHistory, () => "");
  const stored = historySelection ? JSON.parse(historySelection) as { owner: string; token: string } : null;
  const lastSelection = useSyncExternalStore(
    subscribeLastMessagesSelection,
    () => readLastMessagesSelection(userId),
    () => "",
  );
  const saved = parseLastMessagesSelection(lastSelection);
  const hasExplicitSelection = Boolean(params?.has("token") || params?.has("conversation") ||
    params?.has("conversationId") || params?.has("person"));
  const explicitToken = params?.get("token") || "";
  const token = explicitToken || (!hasExplicitSelection
    ? (stored && stored.owner === userId ? stored.token : "") || (saved?.lane === "people" ? saved.token : "") || ""
    : "");
  const conversationId = params?.get("conversation") || params?.get("conversationId") || "";
  const personRef = params?.get("person") || "";
  const selectionKey = JSON.stringify([userId || "", token, conversationId, personRef]);
  const [selection, setSelection] = useState<{ key: string; kind: "conversation" | "person"; ref: string } | null>(null);
  const [failedSelection, setFailedSelection] = useState<string | null>(null);
  const [opening, setOpening] = useState<(DirectMessageSelection & { ownerId: string }) | null>(null);
  const openingRequest = useRef<DirectMessageSelection | null>(null);
  const issuedTokens = useRef(new Set<string>());
  const draftOwner = useRef(userId);
  const clearOpening = useCallback(() => { openingRequest.current = null; setOpening(null); }, [setOpening]);
  useLayoutEffect(() => {
    if (draftOwner.current && draftOwner.current !== userId)
      void MessagesDraftService.clearForUser(draftOwner.current).catch(() => undefined);
    draftOwner.current = userId;
    clearOpening();
    const tokens = issuedTokens.current;
    tokens.clear();
    return () => { openingRequest.current = null; tokens.clear(); };
  }, [clearOpening, user, userId]);
  const selected = Boolean(token || conversationId || personRef);
  const cachedSelection = user && userId && token ? DirectMessagesResourceService.readRoute(userId, token) : null;
  const visibleSelection = opening?.ownerId === userId ? opening
    : selection?.key === selectionKey ? selection : cachedSelection;
  useLayoutEffect(() => {
    const ownCommit = issuedTokens.current.delete(token);
    const currentOpening = openingRequest.current;
    const committed = userId && token ? DirectMessagesResourceService.readRoute(userId, token) : null;
    if (ownCommit && currentOpening &&
      (currentOpening.kind !== committed?.kind || currentOpening.ref !== committed?.ref)) {
      // An earlier push may commit after a newer tap. Keep the newest intent
      // visible until its own destination commits or the person cancels.
      return;
    } else {
      clearOpening();
      issuedTokens.current.clear();
    }
  }, [clearOpening, selectionKey, token, userId]);
  const openSelection = (destination: DirectMessageSelection) => {
    if (!user || !userId) return;
    const request = { ...destination };
    openingRequest.current = request;
    // Select the known person before any network work. This changes only the
    // presentation; history still checks current read and send permission.
    setOpening({ ...destination, ownerId: userId });
    void resolveDirectMessageHref(destination.kind === "conversation"
      ? { conversationId: destination.ref } : { personRef: destination.ref })
      .then((href) => {
        if (openingRequest.current !== request) return;
        if (href) {
          const mintedToken = new URL(href, "https://navigation.invalid").searchParams.get("token");
          if (mintedToken) {
            issuedTokens.current.add(mintedToken);
            if (issuedTokens.current.size > 64) issuedTokens.current.delete(issuedTokens.current.values().next().value!);
          }
          router.push(href);
        }
        else clearOpening();
      }).catch(() => {
        if (openingRequest.current !== request) return;
        clearOpening();
        morphyToast.error("This conversation could not be opened. Try again.");
      });
  };
  useEffect(() => {
    let active = true;
    setSelection(null);
    setFailedSelection(null);
    if (!user || !userId || !selected) return;
    const session = DirectMessagesResourceService.beginRequest(userId);
    void (async () => {
      try {
        const cached = token ? DirectMessagesResourceService.readRoute(userId, token) : null;
        const result = cached ? { ...cached, token } : await DirectMessagesService.routeSelection({
          idToken: await user.getIdToken(),
          ...(token ? { token } : conversationId ? { conversationId } : { personRef }),
        });
        if (!active) return;
        DirectMessagesResourceService.writeRoute(userId, session, result);
        // Sanitizing a legacy URL is also an owned commit. It must not erase
        // a newer person being opened while this source request completes.
        if (openingRequest.current && !token) issuedTokens.current.add(result.token);
        replaceMessageHistory({ owner: userId, token: result.token });
        writeLastMessagesSelection(userId, { lane: "people", token: result.token });
        setSelection({ key: token ? selectionKey : JSON.stringify([userId, result.token, "", ""]), kind: result.kind, ref: result.ref });
      } catch {
        if (active) setFailedSelection(selectionKey);
      }
    })();
    return () => { active = false; };
  }, [user, userId, selected, token, conversationId, personRef, selectionKey, router]);
  useEffect(() => {
    // Defer a source-link failure while another person is opening. If that
    // opening also fails, return to the inbox instead of waiting indefinitely.
    if (failedSelection !== selectionKey || openingRequest.current) return;
    replaceMessageHistory(null);
    writeLastMessagesSelection(userId, { lane: "people", token: null });
    router.replace("/one/messages", { scroll: false });
  }, [failedSelection, selectionKey, opening, userId, router]);
  return <DirectMessagesPage key={userId || "signed-out"} resolvingSelection={loading || Boolean(user && selected && !visibleSelection)} selection={visibleSelection} onSelect={openSelection} onClearSelection={clearOpening} restoredSelection={hasExplicitSelection || selected ? null : saved} />;
}
