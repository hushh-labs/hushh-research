"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

/**
 * Root Chat owns the first paint after unlock.  Badge-only reads belong to the
 * persistent shell, but they must not compete with conversation restoration or
 * the first agent turn.  Release those reads during the first idle window;
 * route surfaces other than Chat remain eager so their notification badges are
 * ready when the user opens them.
 */
const ROOT_CHAT_IDLE_TIMEOUT_MS = 2_000;

function isRootChatPath(pathname: string | null): boolean {
  return pathname === ROUTES.HOME || pathname === "/chat";
}

export function useRootChatDeferredReady(): boolean {
  const pathname = usePathname();
  const rootChat = isRootChatPath(pathname);
  const [releasedPath, setReleasedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!rootChat) return;

    let active = true;
    const release = () => {
      if (active) setReleasedPath(pathname);
    };

    if (typeof window === "undefined") return;

    if ("requestIdleCallback" in window) {
      const requestIdle = window.requestIdleCallback as (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
      const handle = requestIdle(release, {
        timeout: ROOT_CHAT_IDLE_TIMEOUT_MS,
      });
      return () => {
        active = false;
        cancelIdle(handle);
      };
    }

    const handle = setTimeout(release, ROOT_CHAT_IDLE_TIMEOUT_MS);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [pathname, rootChat]);

  return !rootChat || releasedPath === pathname;
}
