"use client";

import { useSyncExternalStore } from "react";

import {
  getPuppyLinkSnapshot,
  subscribePuppyLink,
  type PuppyLink,
} from "@/lib/services/puppy-one-service";

/**
 * The link to Hussh One, as One's backend sees it, shared by every surface
 * on the page.
 *
 * Backed by one store and one poll (`subscribePuppyLink`), so the chat panel
 * and the machine strip change together and can never disagree about one
 * machine. Null until the first read lands; "unavailable" after a failed one.
 */
export function usePuppyLink(): PuppyLink | null {
  return useSyncExternalStore(
    subscribePuppyLink,
    getPuppyLinkSnapshot,
    () => null,
  );
}
