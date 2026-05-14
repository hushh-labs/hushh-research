"use client";

/**
 * useConsentStore + useConsentSSE
 * =================================
 * Zustand store for live consent state + SSE connection hook.
 *
 * Architecture:
 *   useConsentSSE  → calls ApiService.subscribeConsentEvents()
 *                  → parses SSE frames
 *                  → writes to useConsentStore
 *   ConsentLiveDashboard reads useConsentStore
 *
 * Mount useConsentSSE once near the root of your consent-gated layout.
 * All dashboard instances read from the same store slice.
 */

import { create } from "zustand";
import { useEffect } from "react";
import { ApiService } from "@/lib/services/api-service";
import type { ConsentSSEEvent } from "@/lib/services/api-service";

// ============================================================================
// Public Types
// ============================================================================

export type ConsentEventType =
  | "consent_granted"
  | "consent_denied"
  | "consent_revoked";

export interface ConsentActivityItem {
  /** Unique per-item ID for React key + GSAP targeting */
  id: string;
  type: ConsentEventType;
  scope: string;
  developer: string;
  /** Unix ms timestamp from server */
  ts: number;
  requestId?: string;
  /** Whether this was an idempotent token reuse */
  reused?: boolean;
}

export type SSEConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

// ============================================================================
// Store Shape
// ============================================================================

interface ConsentStoreState {
  /** Current SSE connection state */
  sseStatus: SSEConnectionStatus;

  /**
   * Live activity feed — newest first, capped at 50 items.
   * Each item drives one GSAP-animated card in ConsentLiveDashboard.
   */
  activityFeed: ConsentActivityItem[];

  /** Pending consent count — set externally by the page that polls /pending */
  pendingCount: number;

  /** Server timestamp of the last received event (null = no events yet) */
  lastEventAt: number | null;

  // ── Internal mutators (prefix _ = store-private by convention) ──────────
  _setSseStatus: (status: SSEConnectionStatus) => void;
  _pushActivity: (item: ConsentActivityItem) => void;

  // ── Public actions ───────────────────────────────────────────────────────
  setPendingCount: (count: number) => void;
  clearFeed: () => void;
}

// ============================================================================
// Store
// ============================================================================

export const useConsentStore = create<ConsentStoreState>((set) => ({
  sseStatus: "idle",
  activityFeed: [],
  pendingCount: 0,
  lastEventAt: null,

  _setSseStatus: (sseStatus) => set({ sseStatus }),

  _pushActivity: (item) =>
    set((state) => ({
      activityFeed: [item, ...state.activityFeed].slice(0, 50),
      lastEventAt: item.ts,
    })),

  setPendingCount: (pendingCount) => set({ pendingCount }),
  clearFeed: () => set({ activityFeed: [], lastEventAt: null }),
}));

// ============================================================================
// SSE Connection Hook
// ============================================================================

const CONSENT_EVENT_TYPES = new Set<ConsentEventType>([
  "consent_granted",
  "consent_denied",
  "consent_revoked",
]);

function isConsentEventType(type: string): type is ConsentEventType {
  return CONSENT_EVENT_TYPES.has(type as ConsentEventType);
}

/**
 * useConsentSSE
 * =============
 * Opens a Server-Sent Events connection to /api/consent/events/stream
 * and feeds received events into useConsentStore.
 *
 * Features:
 * - Exponential backoff reconnect (1 s → 30 s max)
 * - Resets backoff on successful connect
 * - Safe cleanup on unmount or credential change
 * - No-op when userId or vaultOwnerToken are missing
 *
 * @example
 * // In your consent-gated layout root:
 * useConsentSSE(userId, vaultOwnerToken);
 */
export function useConsentSSE(
  userId: string | null | undefined,
  vaultOwnerToken: string | null | undefined
): void {
  const { _setSseStatus, _pushActivity } = useConsentStore();

  useEffect(() => {
    if (!userId || !vaultOwnerToken) {
      _setSseStatus("idle");
      return;
    }

    let cancelled = false;
    let abortController = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1_000;

    const connect = async () => {
      if (cancelled) return;
      _setSseStatus("connecting");

      try {
        await ApiService.subscribeConsentEvents(
          userId,
          vaultOwnerToken,
          {
            onConnected: () => {
              if (cancelled) return;
              _setSseStatus("connected");
              backoffMs = 1_000; // Reset backoff on clean connect
            },
            onEvent: (event: ConsentSSEEvent) => {
              if (cancelled) return;
              if (!isConsentEventType(event.type)) return;

              _pushActivity({
                id: `${event.type}-${event.ts}-${Math.random()
                  .toString(36)
                  .slice(2)}`,
                type: event.type,
                scope: event.scope ?? "",
                developer: event.developer ?? event.agent_id ?? "Unknown",
                ts: event.ts,
                requestId: event.requestId,
                reused: event.reused,
              });
            },
          },
          abortController.signal
        );

        // Stream closed cleanly (server restart, timeout, etc.) — reconnect
        if (!cancelled) {
          _setSseStatus("reconnecting");
          reconnectTimer = setTimeout(connect, backoffMs);
        }
      } catch (err) {
        const isAbort =
          (err as Error)?.name === "AbortError" ||
          (err as DOMException)?.code === DOMException.ABORT_ERR;
        if (isAbort || cancelled) return;

        _setSseStatus("error");
        backoffMs = Math.min(backoffMs * 2, 30_000);
        reconnectTimer = setTimeout(() => {
          if (!cancelled) connect();
        }, backoffMs);
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      abortController.abort();
      _setSseStatus("idle");
    };
    // Re-connect if credentials rotate
  }, [userId, vaultOwnerToken, _setSseStatus, _pushActivity]);
}