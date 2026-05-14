"use client";

/**
 * useConsentHeartbeat
 *
 * Haptic Vital Sync by Abdul Gaffar — Beast Mode initiative.
 *
 * Connects to the backend WebSocket heartbeat endpoint and triggers
 * navigator.vibrate() (where supported) on every incoming consent pulse.
 * Provides real-time physical feedback that a consent validation occurred,
 * supporting the Data Vital Tracker vision of embodied consent transparency.
 *
 * Browser compatibility note
 * --------------------------
 * navigator.vibrate() is available in Chromium-based browsers on Android.
 * It is NOT supported in Safari (iOS or macOS) or Firefox on iOS.
 * The hook guards every vibration call with a feature check so it degrades
 * gracefully to a no-op on unsupported browsers.
 *
 * WebSocket URL
 * -------------
 * The hook does NOT derive the backend URL from server-side env vars
 * (those are unavailable on the client). Pass the WebSocket URL explicitly:
 *
 *   const { isConnected } = useConsentHeartbeat({
 *     wsUrl: "wss://your-backend.run.app/ws/heartbeat",
 *   });
 *
 * For local development the default falls back to ws://127.0.0.1:8000/ws/heartbeat.
 * In production set NEXT_PUBLIC_BACKEND_WS_URL in your deployment environment.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsentPulse {
  event: "pulse";
  timestamp_ms: number;
  scope_hint: string;
  engine: string;
}

export interface UseConsentHeartbeatOptions {
  /**
   * Full WebSocket URL to the heartbeat endpoint.
   * Defaults to the NEXT_PUBLIC_BACKEND_WS_URL env var with /ws/heartbeat
   * appended, falling back to ws://127.0.0.1:8000/ws/heartbeat for local dev.
   */
  wsUrl?: string;
  /** Disable the hook entirely (useful in SSR or test environments). */
  enabled?: boolean;
  /**
   * Vibration pattern passed to navigator.vibrate().
   * A single number is ms on; an array alternates on/off durations.
   * Default: [40] — a single short tap.
   */
  vibrationPattern?: number | number[];
  /** Called on every pulse with the decoded payload. */
  onPulse?: (pulse: ConsentPulse) => void;
  /** Called when the WebSocket connects successfully. */
  onConnect?: () => void;
  /** Called when the WebSocket closes or errors. */
  onDisconnect?: () => void;
  /** Reconnect delay in ms after an unexpected close. Set to 0 to disable. */
  reconnectDelayMs?: number;
}

export interface UseConsentHeartbeatReturn {
  /** True while the WebSocket connection is open. */
  isConnected: boolean;
  /** Number of pulses received since mount (resets on reconnect). */
  pulseCount: number;
  /** Manually trigger the haptic pattern (e.g. for a UI preview). */
  triggerHaptic: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _ENGINE = "Haptic Vital Sync by Abdul Gaffar";

function _resolveWsUrl(override?: string): string {
  if (override) return override;
  if (typeof window === "undefined") return "";

  const envBase =
    typeof process !== "undefined"
      ? (process.env["NEXT_PUBLIC_BACKEND_WS_URL"] ?? "")
      : "";

  if (envBase) {
    return envBase.replace(/\/$/, "") + "/ws/heartbeat";
  }

  // Derive from current page origin for local dev
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//127.0.0.1:8000/ws/heartbeat`;
}

function _vibrate(pattern: number | number[]): void {
  if (typeof window === "undefined") return;
  if (!("vibrate" in navigator)) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Silently ignore — vibrate() may throw in sandboxed iframes
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConsentHeartbeat(
  options: UseConsentHeartbeatOptions = {}
): UseConsentHeartbeatReturn {
  const {
    wsUrl,
    enabled = true,
    vibrationPattern = [40],
    onPulse,
    onConnect,
    onDisconnect,
    reconnectDelayMs = 3000,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [pulseCount, setPulseCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  const triggerHaptic = useCallback(() => {
    _vibrate(vibrationPattern);
  }, [vibrationPattern]);

  useEffect(() => {
    unmountedRef.current = false;

    if (!enabled || typeof window === "undefined") return;

    const url = _resolveWsUrl(wsUrl);
    if (!url) return;

    function connect(): WebSocket {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current) return;
        setIsConnected(true);
        setPulseCount(0);
        onConnect?.();
        console.debug(`[${_ENGINE}] connected ${url}`);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (unmountedRef.current) return;
        try {
          const pulse = JSON.parse(event.data) as ConsentPulse;
          if (pulse.event !== "pulse") return;
          _vibrate(vibrationPattern);
          setPulseCount((n) => n + 1);
          onPulse?.(pulse);
        } catch {
          // Malformed frame — ignore
        }
      };

      ws.onclose = () => {
        if (unmountedRef.current) return;
        setIsConnected(false);
        onDisconnect?.();
        if (reconnectDelayMs > 0) {
          reconnectTimer.current = setTimeout(() => {
            if (!unmountedRef.current) connect();
          }, reconnectDelayMs);
        }
      };

      ws.onerror = () => {
        // onclose fires after onerror; reconnect logic lives there
        console.debug(`[${_ENGINE}] ws error — will retry in ${reconnectDelayMs}ms`);
      };

      return ws;
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, wsUrl, reconnectDelayMs]);

  return { isConnected, pulseCount, triggerHaptic };
}
