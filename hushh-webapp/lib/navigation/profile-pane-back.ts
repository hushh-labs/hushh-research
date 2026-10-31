"use client";

import { unwindBackLayer } from "./back-layers";
import { popProfilePaneLocation, PROFILE_PANE_QUERY, pushProfilePaneLocation,
  replaceProfilePaneLocation, resolveProfilePaneUrlState } from "./profile-pane";

/** A retained connector's Back consumes its existing detail visit. Pushing a
 * catalog entry here would make the next Back reopen the connector just left. */
export function changeProfilePaneConnector(
  pathname: string,
  searchParams: { get(name: string): string | null; toString(): string },
  connectorId: string | null,
): void {
  const current = resolveProfilePaneUrlState(searchParams);
  if (!current.open || current.location.panel !== "connectors") return;
  const detail = connectorId ? `connector:${connectorId}` as const : null;
  if (current.location.detail === detail) return;
  if (detail === null) {
    popProfilePaneLocation(pathname, searchParams);
  } else if (current.location.detail) {
    replaceProfilePaneLocation(pathname, searchParams, { panel: "connectors", detail });
  } else {
    pushProfilePaneLocation(pathname, searchParams, { panel: "connectors", detail });
  }
}

/** Native and web pane headers unwind the same authored feature before its
 * query parent. False means a local feature consumed Back: UIKit must restore
 * its pop rather than wait for a route change that was never requested.
 * Web callers ignore the result and keep the same hierarchy. */
export function backProfilePane(pathname: string, query: { get(name: string): string | null; toString(): string }): boolean {
  if (unwindBackLayer(pathname, query, { [PROFILE_PANE_QUERY]: "1" })) return false;
  popProfilePaneLocation(pathname, query);
  return true;
}
