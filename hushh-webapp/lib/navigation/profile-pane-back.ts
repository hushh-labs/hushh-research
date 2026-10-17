"use client";

import { unwindBackLayer } from "./back-layers";
import { popProfilePaneLocation, PROFILE_PANE_QUERY } from "./profile-pane";

/** Native and web pane headers unwind the same authored feature before its
 * query parent. This composes the existing owners; it does not own history. */
export function backProfilePane(pathname: string, query: { get(name: string): string | null; toString(): string }): void {
  if (unwindBackLayer(pathname, query, { [PROFILE_PANE_QUERY]: "1" })) return;
  popProfilePaneLocation(pathname, query);
}
