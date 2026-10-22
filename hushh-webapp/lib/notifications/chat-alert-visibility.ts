import { Capacitor } from "@capacitor/core";
import { useEffect, type RefObject } from "react";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { chatReadIsBlocked, subscribeChatLayerChanges } from "@/lib/interaction/chat-read-visibility";

import { activeNotificationKeyId, subscribeNotificationKey } from "./preview-keys";

const panes = new Map<symbol, { tag: string; root: HTMLElement }>();
let activeTag = "";
let pending = Promise.resolve();
let nativePublished: { tag: string; keyId: string } | null = null;
function publishNative(tag: string): void {
  const keyId = activeNotificationKeyId();
  if (!keyId) { nativePublished = null; return; }
  if (!Capacitor.isNativePlatform()) return;
  pending = pending.catch(() => {}).then(async () => {
    if (activeNotificationKeyId() !== keyId || activeTag !== tag) return;
    if (nativePublished?.keyId === keyId && nativePublished.tag === tag) return;
    const { HushhNotifications } = await import("@/lib/capacitor");
    if (activeNotificationKeyId() !== keyId || activeTag !== tag) return;
    await HushhNotifications.setActiveChat({ tag, keyId });
    if (activeNotificationKeyId() === keyId && activeTag === tag) nativePublished = { tag, keyId };
  }).catch(() => {});
}
export function chatAlertIsVisible(data: Record<string, unknown>): boolean {
  const tag = data.type === "location_circle_message" ? `circle-chat:${data.circle_id}` : `direct-chat:${data.conversation_id}`;
  return activeTag === tag && [...panes.values()].some(pane => pane.tag === tag && !chatReadIsBlocked(pane.root)) && document.visibilityState === "visible" && document.hasFocus()
    && appInteractionCoordinator.getLifecycleSnapshot().state === "active";
}

/** A presentation hint only. The message service still owns read receipts. */
export function useChatAlertVisibility(tag: string | null, root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const owner = Symbol();
    const publish = () => {
      if (tag && root.current && !chatReadIsBlocked(root.current) && document.visibilityState === "visible" && document.hasFocus()
          && appInteractionCoordinator.getLifecycleSnapshot().state === "active") panes.set(owner, { tag, root: root.current });
      else panes.delete(owner);
      const next = [...panes.values()].at(-1)?.tag ?? "";
      activeTag = next;
      publishNative(next);
    };
    publish();
    const lifecycle = appInteractionCoordinator.subscribeLifecycle(publish);
    const layers = subscribeChatLayerChanges(publish);
    const keys = subscribeNotificationKey(publish);
    document.addEventListener("visibilitychange", publish);
    window.addEventListener("focus", publish); window.addEventListener("blur", publish);
    return () => { panes.delete(owner); lifecycle(); layers(); keys(); document.removeEventListener("visibilitychange", publish);
      window.removeEventListener("focus", publish); window.removeEventListener("blur", publish);
      // Reconcile the remaining owner rather than clearing another live pane.
      const next = [...panes.values()].at(-1)?.tag ?? "";
      activeTag = next;
      publishNative(next);
    };
  }, [tag, root]);
}
