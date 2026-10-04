import { createRoot } from "react-dom/client";
import { useState } from "react";
import { CircleChat } from "../../components/connect/circles/circle-chat";
import { CircleDetailFlow } from "../../components/one-location/redesign/circles/named-circle-flows";
import type { OneLocationCircleDetail } from "../../lib/one-location/types";
import { AppPageShell } from "../../components/app-ui/app-page-shell";
const session = { userId: "alice", circleId: "circle", vaultKey: "fixture", vaultOwnerToken: "fixture" };
const names = ["Neelesh Meena", "Kushal Trivedi", "John Smith", "Asha Meena", "Maya Rao", "Sam Patel"];
const initial: OneLocationCircleDetail = {
  id: "circle", name: "Business Circle", kind: "friends", role: "owner", memberCount: 6, memberLimit: 20,
  members: names.map((displayName, index) => ({ userId: index === 0 ? "alice" : index === 1 ? "bob" : `person-${index}`,
    displayName, role: index === 0 ? "owner" : "member", photoUrl: index < 3 ? `/fixture-person-${index}.webp` : null,
    connectionStatus: "connected", phoneVerified: true, secureLocationReady: true })),
};
function Workspace() {
  const [circle, setCircle] = useState(initial);
  return <AppPageShell width="agent" fitContent className="py-6 sm:py-10">
    <CircleDetailFlow circleId="circle" currentUserId="alice" busy={false} livingCircleExperience
      onBack={() => {}} onLoad={async () => circle}
      onRename={async (_id, name) => { const next = { ...circle, name }; setCircle(next); return next; }}
      onPhotoUpdate={async (_id, photoUrl) => { const next = { ...circle, photoUrl }; setCircle(next); return next; }}
      onGenerateCode={async () => { throw new Error("Unused fixture action"); }} onCopyCode={async () => {}} onShareCode={async () => {}}
      onShareWithMember={() => {}} onRemoveMember={async () => {}} onConnectMember={async () => {}}
      onLoadEligibleConnections={async () => ({ eligibleConnections: [], pendingInvites: [], remainingCapacity: 14 })}
      onInviteConnections={async () => {}} onCancelMemberInvite={async () => {}} onLeave={async () => {}} onDelete={async () => {}}
      renderChat={(loaded, { active, readingBlocked }) => <CircleChat session={session} circleName={loaded.name} initialOpen active={active} readingBlocked={readingBlocked} collapsible={false} />}
    />
  </AppPageShell>;
}
createRoot(document.getElementById("root")!).render(<div data-app-scroll-root="true" className="h-dvh overflow-y-auto overscroll-contain">
  {new URLSearchParams(location.search).has("workspace") ? <Workspace /> : <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
  <h1 className="text-xl font-semibold">Weekend friends</h1>
  <CircleChat initialOpen circleName="Weekend friends" session={{ userId: "alice", circleId: "circle", vaultKey: "fixture", vaultOwnerToken: "fixture" }} />
</main>}
</div>);
