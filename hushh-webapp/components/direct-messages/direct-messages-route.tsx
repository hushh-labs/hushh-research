"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { DirectMessagesService } from "@/lib/services/direct-messages-service";
import { DirectMessagesResourceService } from "@/lib/services/direct-messages-resource-service";
import { DirectMessagesPage } from "./direct-messages-page";

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
  const selected = Boolean(token || conversationId || personRef);
  const cachedSelection = user && userId && token ? DirectMessagesResourceService.readRoute(userId, token) : null;
  const visibleSelection = selection?.key === selectionKey ? selection : cachedSelection;
  useEffect(() => {
    let active = true;
    setSelection(null);
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
        replaceMessageHistory({ owner: userId, token: result.token });
        writeLastMessagesSelection(userId, { lane: "people", token: result.token });
        setSelection({ key: token ? selectionKey : JSON.stringify([userId, result.token, "", ""]), kind: result.kind, ref: result.ref });
      } catch {
        if (active) {
          replaceMessageHistory(null);
          writeLastMessagesSelection(userId, { lane: "people", token: null });
          router.replace("/one/messages", { scroll: false });
        }
      }
    })();
    return () => { active = false; };
  }, [user, userId, selected, token, conversationId, personRef, selectionKey, router]);
  return <DirectMessagesPage key={userId || "signed-out"} resolvingSelection={loading || Boolean(user && selected && !visibleSelection)} selection={visibleSelection} restoredSelection={hasExplicitSelection || selected ? null : saved} />;
}
