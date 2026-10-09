"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { DirectMessagesService } from "@/lib/services/direct-messages-service";
import { DirectMessagesPage } from "./direct-messages-page";

export function DirectMessagesRoute() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const token = params?.get("token") || "";
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
        if (!token) router.replace(`/one/messages?token=${encodeURIComponent(result.token)}`, { scroll: false });
        setSelection({ key: token ? selectionKey : JSON.stringify([user.uid, result.token, "", ""]), kind: result.kind, ref: result.ref });
      } catch {
        if (active) router.replace("/one/messages", { scroll: false });
      }
    })();
    return () => { active = false; };
  }, [user, selected, token, conversationId, personRef, selectionKey, router]);
  return <DirectMessagesPage key={selectionKey} resolvingSelection={loading || Boolean(user && selected && selection?.key !== selectionKey)} selection={selection?.key === selectionKey ? selection : null} />;
}
