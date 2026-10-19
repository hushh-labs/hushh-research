"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  profilePanePresentationSnapshot,
  resolveProfilePaneUrlState,
  type ProfilePaneHistoryState,
} from "@/lib/navigation/profile-pane";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

const serverSnapshot = () => "";

/** Native projection only; never pushes, replaces or maintains a route stack.
 * useSyncExternalStore also rechecks this entry before a concurrent commit. */
export function useProfilePanePresentation() {
  const encoded = useSyncExternalStore(subscribe, profilePanePresentationSnapshot, serverSnapshot);
  return useMemo(() => {
    if (!encoded) return null;
    const [pathname, query, history] = JSON.parse(encoded) as [string, string, ProfilePaneHistoryState];
    const searchParams = new URLSearchParams(query);
    return { pathname, searchParams, history, ...resolveProfilePaneUrlState(searchParams) };
  }, [encoded]);
}

export type ProfilePanePresentation = NonNullable<ReturnType<typeof useProfilePanePresentation>>;
