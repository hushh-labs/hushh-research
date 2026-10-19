"use client";

import { unwindBackLayer } from "./back-layers";
import { popProfilePaneLocation, PROFILE_PANE_QUERY } from "./profile-pane";

/** Native and web pane headers unwind the same authored feature before its
 * query parent. False means a local feature consumed Back: UIKit must restore
 * its pop rather than wait for a route change that was never requested.
 * Web callers ignore the result and keep the same hierarchy. */
export function backProfilePane(pathname: string, query: { get(name: string): string | null; toString(): string }): boolean {
  if (unwindBackLayer(pathname, query, { [PROFILE_PANE_QUERY]: "1" })) return false;
  popProfilePaneLocation(pathname, query);
  return true;
}
