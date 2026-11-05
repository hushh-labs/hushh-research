"use client";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { NetworkPeopleList } from "./network-people-list";

/** Root list route stays a list even when the shared-neighbor count changes. */
export function MutualConnectionsList({ personRef }: { personRef: string; href: string }) {
  return <AppPageShell as="main" width="standard" fitContent data-connect-type-scale="page">
    <NetworkPeopleList mode="mutuals" personRef={personRef} visitKey={`mutuals:${personRef}`} />
  </AppPageShell>;
}
