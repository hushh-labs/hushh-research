import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { LivingCirclePanelFixture } from "./living-circle-panel";
import { CircleDiscoveryCard } from "../../components/connect/circle-discovery-card";
import type {
  CircleStarter,
  ConnectCirclesSnapshot,
} from "../../components/connect/circle-discovery";
import type { OneLocationCircleMember, OneLocationCircleSummary } from "../../lib/one-location/types";
import type { ConnectionSummaryEntry } from "../../lib/services/connections-service";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../../components/app-ui/signed-in-shell-content-offset";

const connections = ["Alex Chen", "Jordan Lee", "Casey Brooks"].map(
  (displayName, index) => ({
    connectionId: `connection-${index}`,
    userId: `user-${index}`,
    displayName,
  }),
) as ConnectionSummaryEntry[];
const populatedCircle: OneLocationCircleSummary = {
  id: "location-with-members",
  name: "Location Circle",
  kind: "other",
  role: "owner",
  memberCount: 3,
  memberLimit: 100,
};
const populatedMembers: OneLocationCircleMember[] = [
  { userId: "test-owner", displayName: "Taylor Kim", role: "owner", phoneVerified: true, secureLocationReady: true },
  { userId: "alex", displayName: "Alex Chen", role: "member", phoneVerified: true, secureLocationReady: true },
  { userId: "jordan", displayName: "Jordan Lee", role: "member", phoneVerified: true, secureLocationReady: true },
];
const loadCircleMembers = async () => populatedMembers;
function Fixture() {
  const [state, setState] = useState("new");
  const [circles, setCircles] = useState<OneLocationCircleSummary[]>([]);
  const [action, setAction] = useState("");
  const snapshot: ConnectCirclesSnapshot = {
    ownerId: "test-owner",
    loading: state === "loading",
    error: state === "error" ? "unavailable" : null,
    count: state === "populated" ? 1 : circles.length,
    available: true,
    circles:
      state === "populated"
        ? [populatedCircle]
        : state === "connected"
        ? [
            ...circles,
            {
              id: "trusted",
              name: "Trusted",
              kind: "other",
              systemKind: "trusted",
              role: "owner",
              memberCount: 49,
              memberLimit: null,
            },
          ]
        : circles,
  };
  function create(starter: CircleStarter) {
    setCircles((current) => [
      ...current,
      {
        id: starter.id,
        name: starter.name,
        kind: starter.kind,
        systemKind: starter.id === "sms" ? "sms" : null,
        role: "owner",
        memberCount: 1,
        memberLimit: 100,
      },
    ]);
  }
  const card = (
    <CircleDiscoveryCard
      ownerName="Taylor Kim"
      ownerPhotoUrl={null}
      connections={state === "connected" ? connections : []}
      totalCount={state === "connected" ? 48 : 0}
      loading={false}
      error={false}
      snapshot={snapshot}
      loadCircleMembers={loadCircleMembers}
      creating={null}
      onUseStarter={create}
      onFindPeople={() => setAction("Find people")}
      onCreateCircle={() => setAction("Custom circle")}
      onOpenCircle={(id) => setAction(`Open ${id}`)}
      onRetry={() => setAction("Retry connections")}
      onRetryCircles={() => setAction("Retry circles")}
      onSetupCircles={() => setAction("Set up One")}
    />
  );
  const shell = document.documentElement.dataset.shell === "true";
  return (
    <>
      <div className={shell ? "sr-only" : "mb-4"}>
        <label>
          Fixture state{" "}
          <select
            aria-label="Fixture state"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="new">New user</option>
            <option value="connected">Connected user</option>
            <option value="populated">Circle with members</option>
            <option value="error">Unavailable</option>
            <option value="loading">Loading</option>
          </select>
        </label>
        <span role="status">{action}</span>
      </div>
      {shell ? (
        <div
          data-app-shell-root="true"
          style={
            {
              ...resolveSignedInShellContentOffset({
                shellVisible: true,
                routeLayoutMode: "standard",
              }).style,
              ...resolveTopShellGeometryStyle({ hasTabs: false }),
              "--safe-area-inset-top":
                document.documentElement.dataset.safeTop || "0px",
              "--top-inset": document.documentElement.dataset.safeTop || "0px",
            } as React.CSSProperties
          }
        >
          <div
            data-app-scroll-root="true"
            style={{
              position: "fixed",
              inset: 0,
              overflowY: "auto",
              paddingBottom: "166px",
            }}
          >
            <div data-app-shell-top-spacer="true" aria-hidden="true" />
            <AppPageShell fitContent width="agent">
              <AppPageHeaderRegion>
                <PageHeader title="Connect" titleRole="agent" />
              </AppPageHeaderRegion>
              <AppPageContentRegion className="min-w-0">
                <div className="relative space-y-3 sm:space-y-4">
                  <div className={document.documentElement.dataset.headerClass}>
                    <div
                      style={{ height: 38 }}
                      className="rounded-xl bg-[color:var(--app-secondary-surface)] text-center"
                    >
                      Connections · Circles
                    </div>
                  </div>
                  {card}
                  <p>My connections</p>
                </div>
              </AppPageContentRegion>
            </AppPageShell>
          </div>
          <div
            data-bottom-chrome
            style={{
              position: "fixed",
              bottom: 0,
              insetInline: 0,
              height: 166,
              background: "var(--app-secondary-surface)",
            }}
          >
            Bottom navigation + Talk to One + safe area
          </div>
        </div>
      ) : (
        <main className="mx-auto w-full max-w-[52rem] p-4 sm:p-6">{card}</main>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  document.documentElement.dataset.circleDetail === "true" ? (
    <LivingCirclePanelFixture />
  ) : (
    <Fixture />
  ),
);
