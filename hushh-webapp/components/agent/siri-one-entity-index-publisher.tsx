"use client";

import { useCallback, useEffect, useRef } from "react";

import { useAuth } from "@/hooks/use-auth";
import { OneSystemActionInvocationBridge } from "@/lib/capacitor/one-system-action-invocation";
import { FEED_STATE_CHANGED_EVENT } from "@/lib/feed/feed-events";
import { OneLocationService } from "@/lib/one-location/service";
import { useVault } from "@/lib/vault/vault-context";

/**
 * Publishes a bounded, this-device-only AppEntity search index from the
 * existing Location models. It contains only stable ids and display names;
 * no phone numbers, tokens, coordinates, routes, or contact-book records.
 */
export function SiriOneEntityIndexPublisher(): null {
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (
      !OneSystemActionInvocationBridge.isSupported() ||
      !user?.uid ||
      !vaultOwnerToken
    ) {
      return;
    }
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const task = (async () => {
      try {
        const [contacts, circles] = await Promise.all([
          OneLocationService.listRecipients(vaultOwnerToken),
          OneLocationService.listCircles(vaultOwnerToken),
        ]);
        await OneSystemActionInvocationBridge.updateEntityIndex({
          ownerId: user.uid,
          contacts: contacts.map((contact) => ({
            id: contact.userId,
            name: contact.displayName,
          })),
          circles: circles.map((circle) => ({
            id: circle.id,
            name: circle.name,
          })),
        });
      } catch (error) {
        console.info(
          `[SIRI_ONE_ACTION] state=entity_index_failed outcome=failed reason=${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      } finally {
        refreshInFlightRef.current = null;
      }
    })();
    refreshInFlightRef.current = task;
    return task;
  }, [user?.uid, vaultOwnerToken]);

  useEffect(() => {
    if (!OneSystemActionInvocationBridge.isSupported()) return;
    if (!authLoading && !user) {
      void OneSystemActionInvocationBridge.clear({
        outcome: "sign_out",
        clearEntityIndex: true,
      });
      return;
    }
    void refresh();
  }, [authLoading, refresh, user]);

  useEffect(() => {
    if (!OneSystemActionInvocationBridge.isSupported()) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 500);
    };
    window.addEventListener(FEED_STATE_CHANGED_EVENT, scheduleRefresh);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, scheduleRefresh);
    };
  }, [refresh]);

  return null;
}
