"use client";

/**
 * Route a Universal Link / App Link back into the running app.
 *
 * The OS half of this is a claim on both sides: `applinks:<domain>` in the iOS
 * entitlements plus a matching path in the served
 * `.well-known/apple-app-site-association`, and an `autoVerify` https intent
 * filter plus `.well-known/assetlinks.json` on Android. When those line up, the
 * system stops opening Safari or Chrome and hands the URL to the app instead.
 *
 * It hands it to the app as an event, not as navigation. Without this listener
 * the app would receive the OAuth return and simply sit on whatever screen it
 * was already showing, which reads to a person as "nothing happened" after they
 * finished connecting an account. This is the half that turns the handoff into
 * an arrival.
 *
 * Only same-origin paths are followed. An incoming URL is attacker-influenced
 * (anyone can send a link), so an origin that is not ours is ignored rather
 * than navigated to.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { APP_FRONTEND_ORIGIN } from "@/lib/config";

export const NATIVE_CONNECTOR_RETURN_EVENT = "hushh:native-connector-return";
export const NATIVE_DRIVE_PICKER_RETURN_EVENT =
  "hushh:native-drive-picker-return";

export type NativeConnectorReturn = {
  attemptId: string;
  outcome: "ready" | "cancelled" | "failed";
};

/**
 * Keep file-selection handoffs distinct from connection handoffs. Both are
 * opaque browser arrivals, but a selected-file candidate must never be
 * mistaken for a completed credential connection (or vice versa).
 */
export type NativeDrivePickerReturn = NativeConnectorReturn;

function knownOrigins(): string[] {
  const configured = String(APP_FRONTEND_ORIGIN || "")
    .trim()
    .replace(/\/+$/, "");
  const origins = [
    configured,
    "https://one.hushh.ai",
    "https://uat.one.hushh.ai",
    "https://dev.one.hushh.ai",
  ];
  return origins.filter(Boolean);
}

/** The in-app path to navigate to, or null when the URL is not ours to follow. */
export function resolveDeepLinkPath(rawUrl: string): string | null {
  const value = String(rawUrl || "").trim();
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;

  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!knownOrigins().includes(origin)) return null;

  // Preserve the query and hash: an OAuth return carries its state there, and
  // dropping it would strand the flow just as surely as opening a browser.
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
}

/**
 * Native Drive OAuth returns are opaque handoffs, never routes. They must be
 * consumed before generic navigation so an external URL cannot replace the
 * mounted chat, composer, or draft while the owner finishes activation.
 */
export function resolveNativeConnectorReturn(
  rawUrl: string,
): NativeConnectorReturn | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "hushh:" ||
    parsed.hostname !== "connectors" ||
    parsed.pathname !== "/return" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    return null;
  }
  const keys = [...parsed.searchParams.keys()];
  if (
    keys.length !== 2 ||
    !keys.includes("attemptId") ||
    !keys.includes("outcome")
  ) {
    return null;
  }
  const attemptIds = parsed.searchParams.getAll("attemptId");
  const outcomes = parsed.searchParams.getAll("outcome");
  const attemptId = attemptIds[0] || "";
  const outcome = outcomes[0];
  if (
    attemptIds.length !== 1 ||
    outcomes.length !== 1 ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(attemptId) ||
    (outcome !== "ready" && outcome !== "cancelled" && outcome !== "failed")
  ) {
    return null;
  }
  return { attemptId, outcome };
}

/**
 * Native Google Picker returns are opaque events, never app navigation. The
 * exact path is part of the protocol so a connection return cannot release a
 * staged selection, and no callback can inject a provider URL or file data
 * into the mounted chat.
 */
export function resolveNativeDrivePickerReturn(
  rawUrl: string,
): NativeDrivePickerReturn | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "hushh:" ||
    parsed.hostname !== "connectors" ||
    parsed.pathname !== "/picker-return" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    return null;
  }
  const keys = [...parsed.searchParams.keys()];
  if (
    keys.length !== 2 ||
    !keys.includes("attemptId") ||
    !keys.includes("outcome")
  ) {
    return null;
  }
  const attemptIds = parsed.searchParams.getAll("attemptId");
  const outcomes = parsed.searchParams.getAll("outcome");
  const attemptId = attemptIds[0] || "";
  const outcome = outcomes[0];
  if (
    attemptIds.length !== 1 ||
    outcomes.length !== 1 ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(attemptId) ||
    (outcome !== "ready" && outcome !== "cancelled" && outcome !== "failed")
  ) {
    return null;
  }
  return { attemptId, outcome };
}

export function useDeepLinkReturn(): void {
  const router = useRouter();

  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | undefined;
    let latestConnectorReturn = "";
    let latestPickerReturn = "";

    void (async () => {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform() || disposed) return;

      const { App } = await import("@capacitor/app");

      const consume = (rawUrl: string) => {
        const connectorReturn = resolveNativeConnectorReturn(rawUrl);
        if (connectorReturn) {
          const key = `${connectorReturn.attemptId}:${connectorReturn.outcome}`;
          if (latestConnectorReturn === key || disposed) return;
          latestConnectorReturn = key;
          window.dispatchEvent(
            new CustomEvent<NativeConnectorReturn>(
              NATIVE_CONNECTOR_RETURN_EVENT,
              {
                detail: connectorReturn,
              },
            ),
          );
          return;
        }
        const pickerReturn = resolveNativeDrivePickerReturn(rawUrl);
        if (pickerReturn) {
          const key = `${pickerReturn.attemptId}:${pickerReturn.outcome}`;
          if (latestPickerReturn === key || disposed) return;
          latestPickerReturn = key;
          window.dispatchEvent(
            new CustomEvent<NativeDrivePickerReturn>(
              NATIVE_DRIVE_PICKER_RETURN_EVENT,
              {
                detail: pickerReturn,
              },
            ),
          );
          return;
        }
        const path = resolveDeepLinkPath(rawUrl);
        if (path && !disposed) router.replace(path);
      };

      // Register the listener before reading the cold URL so an early OAuth
      // return cannot race generic navigation during app bootstrap.
      const handle = await App.addListener("appUrlOpen", (event) =>
        consume(event.url),
      );
      if (disposed) {
        void handle.remove();
        return;
      }
      remove = () => void handle.remove();

      // A cold start opens the app directly on the link, so the event may have
      // fired before the web runtime mounted. Ask for it after subscribing.
      try {
        const launch = await App.getLaunchUrl();
        if (launch?.url) consume(launch.url);
      } catch {
        // A missing launch URL is the normal case, not a failure.
      }
    })();

    return () => {
      disposed = true;
      remove?.();
    };
  }, [router]);
}
