import { FeedRow } from "../../components/feed/feed-row";
import { presentFeedItem } from "../../lib/feed/feed-item-renderers";
import { appendFeedPage, createFeedPaginationState, reconcileFeedFirstPage } from "../../lib/feed/feed-pagination";
import type { FeedItem } from "../../lib/services/feed-service";
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { CircleChat } from "../../components/connect/circles/circle-chat";
import { CircleDetailFlow, CreateCircleFlow } from "../../components/one-location/redesign/circles/named-circle-flows";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
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
  const creation = new URLSearchParams(location.search).has("create");
  const circle = useRef(creation ? { ...initial, memberCount: 1, members: initial.members.slice(0, 1) } : initial);
  const [creating, setCreating] = useState(creation);
  const [memberSetup, setMemberSetup] = useState(creation);
  if (creating) return <Dialog modal open>
    <DialogContent>
      <DialogHeader><DialogTitle>Create a Circle</DialogTitle></DialogHeader>
      <CreateCircleFlow busy={false} onSubmit={async (name, kind) => {
        circle.current = { ...circle.current, name, kind };
        setCreating(false);
      }} />
    </DialogContent>
  </Dialog>;
  return <AppPageShell width="agent" fitContent className="py-6 sm:py-10">
    <CircleDetailFlow circleId="circle" currentUserId="alice" busy={false} livingCircleExperience
      memberSetup={memberSetup} onMemberSetupComplete={() => setMemberSetup(false)}
      onBack={() => {}} onLoad={async () => circle.current}
      onRename={async (_id, name) => { circle.current = { ...circle.current, name }; return circle.current; }}
      onPhotoUpdate={async (_id, photoUrl) => { circle.current = { ...circle.current, photoUrl }; return circle.current; }}
      onGenerateCode={async () => { throw new Error("Unused fixture action"); }} onCopyCode={async () => {}} onShareCode={async () => {}}
      onShareWithMember={() => {}} onRemoveMember={async () => {}} onConnectMember={async () => {}}
      onLoadEligibleConnections={async () => ({ eligibleConnections: creation && circle.current.memberCount === 1
        ? [{ connectionId: "connection-bob", userId: "bob", displayName: names[1], photoUrl: "/fixture-person-1.webp" }] : [],
        pendingInvites: [], remainingCapacity: 20 - circle.current.memberCount })}
      onInviteConnections={async (_id, userIds) => {
        circle.current = { ...circle.current, memberCount: circle.current.memberCount + userIds.length,
          members: [...circle.current.members, ...initial.members.filter((member) => userIds.includes(member.userId))] };
      }} onCancelMemberInvite={async () => {}} onLeave={async () => {}} onDelete={async () => {}}
      renderChat={(loaded, { active, readingBlocked }) => <CircleChat session={session} circleName={loaded.name} initialOpen active={active} readingBlocked={readingBlocked} collapsible={false} />}
    />
  </AppPageShell>;
}
function GroupedFeed() {
  const [opened, setOpened] = useState("");
  const circle: FeedItem = { id: "123", source_domain: "location", event_type: "location_circle_message", actor_label: null,
    metadata: { circle_id: "11111111-1111-4111-8111-111111111111", circle_name: "Release Hunter", chat_thread_key: "circle:release", chat_unread_count: 7 }, read: false, created_at: "2026-10-10T05:06:00Z" };
  const direct: FeedItem = { ...circle, id: "122", source_domain: "connections", event_type: "direct_message_received",
    metadata: { counterpart_label: "Parth Mawai", direct_message_conversation_id: "22222222-2222-4222-8222-222222222222", chat_thread_key: "direct:parth", chat_unread_count: 3, message_preview: "See you at the meetup" } };
  const other: FeedItem = { ...direct, id: "121", event_type: "connection_rejected", metadata: { counterpart_label: "Asha Meena" } };
  let pagination = reconcileFeedFirstPage(createFeedPaginationState(), { items: [circle, direct, other], next_cursor: "121", unread_count: 3 });
  pagination = appendFeedPage(pagination, { items: [{ ...circle, id: "100" }], next_cursor: null, unread_count: 3 }, "121");
  return <AppPageShell width="content" className="py-6 sm:py-10">
    <h1 className="mb-5 text-2xl font-semibold">Feed</h1>
    <div className="rounded-2xl bg-background px-3">
      {[...pagination.previousFirstPageItems, ...pagination.additionalItems].map(item => <FeedRow key={item.id} item={item} onOpen={item => setOpened(presentFeedItem(item).href ?? "")} />)}
    </div>
    <output className="sr-only" data-testid="opened-chat">{opened}</output>
  </AppPageShell>;
}
createRoot(document.getElementById("root")!).render(<div data-app-scroll-root="true" className="h-dvh overflow-y-auto overscroll-contain">
  {new URLSearchParams(location.search).has("feed") ? <GroupedFeed /> : new URLSearchParams(location.search).has("workspace") ? <Workspace /> : <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
  <h1 className="text-xl font-semibold">Weekend friends</h1>
  <CircleChat initialOpen circleName="Weekend friends" session={{ userId: "alice", circleId: "circle", vaultKey: "fixture", vaultOwnerToken: "fixture" }} />
</main>}
</div>);
