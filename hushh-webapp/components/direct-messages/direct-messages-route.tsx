"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { DirectMessagesService } from "@/lib/services/direct-messages-service";
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
  const { user, loading } = useAuth();
  const historySelection = useSyncExternalStore(subscribeMessageHistory, readMessageHistory, () => "");
  const stored = historySelection ? JSON.parse(historySelection) as { owner: string; token: string } : null;
  const lastSelection = useSyncExternalStore(
    subscribeLastMessagesSelection,
    () => readLastMessagesSelection(user?.uid),
    () => "",
  );
  const saved = parseLastMessagesSelection(lastSelection);
  const hasExplicitSelection = Boolean(params?.has("token") || params?.has("conversation") ||
    params?.has("conversationId") || params?.has("person"));
  const explicitToken = params?.get("token") || "";
  const token = explicitToken || (!hasExplicitSelection
    ? (stored && stored.owner === user?.uid ? stored.token : "") || (saved?.lane === "people" ? saved.token : "") || ""
    : "");
  const conversationId = params?.get("conversation") || params?.get("conversationId") || "";
  const personRef = params?.get("person") || "";
  const selectionKey = JSON.stringify([user?.uid || "", token, conversationId, personRef]);
  const [selection, setSelection] = useState<{ key: string; kind: "conversation" | "person"; ref: string } | null>(null);
  const selected = Boolean(token || conversationId || personRef);
  useEffect(() => {
    let active = true;
    setSelection(null);
    if (!user || !selected) return;
    void (async () => {
      try {
        const result = await DirectMessagesService.routeSelection({
          idToken: await user.getIdToken(),
          ...(token ? { token } : conversationId ? { conversationId } : { personRef }),
        });
        if (!active) return;
        replaceMessageHistory({ owner: user.uid, token: result.token });
        writeLastMessagesSelection(user.uid, { lane: "people", token: result.token });
        setSelection({ key: token ? selectionKey : JSON.stringify([user.uid, result.token, "", ""]), kind: result.kind, ref: result.ref });
      } catch {
        if (active) {
          replaceMessageHistory(null);
          writeLastMessagesSelection(user.uid, { lane: "people", token: null });
          router.replace("/one/messages", { scroll: false });
        }
      }
    })();
    return () => { active = false; };
  }, [user, selected, token, conversationId, personRef, selectionKey, router]);
  return <DirectMessagesPage key={user?.uid || "signed-out"} resolvingSelection={loading || Boolean(user && selected && selection?.key !== selectionKey)} selection={selection?.key === selectionKey ? selection : null} restoredSelection={hasExplicitSelection || selected ? null : saved} />;
}
