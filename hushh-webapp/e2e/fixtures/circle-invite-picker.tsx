import { startFramePacingProbe } from "../../lib/perf/frame-pacing";
import React, { useState } from "react";
import { CircleMemberActionsMenu } from "../../components/one-location/redesign/circles/circle-member-actions-menu";
import { Dialog, DialogTitle } from "../../components/ui/dialog";
import { CreateCirclePeopleStep } from "../../components/one-location/redesign/circles/create-circle-people-step";
import { Sheet, SheetHeader, SheetTitle, SheetDescription } from "../../components/ui/sheet";
import { AlertDialog, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "../../components/ui/alert-dialog";
import { AdaptiveSheetContent, TaskDialogContent, TaskAlertDialogContent, taskSurfaceStyles } from "../../lib/morphy-ux/ui/task-surfaces";
import { LivingCirclePanel } from "../../components/connect/circles/living-circle-panel";
import { createRoot } from "react-dom/client";
import { CircleInvitePeopleSheet } from "../../components/one-location/redesign/circles/circle-grow-actions";

const eligibleConnections = Array.from({ length: 45 }, (_, index) => ({
  connectionId: `connection-${index + 1}`,
  userId: `person-${index + 1}`,
  displayName: `Connected person ${index + 1}`,
  photoUrl: null,
  connectedFromContacts: true,
  connectedAt: `2026-10-19T11:${String(index).padStart(2, "0")}:00Z`,
  isRia: index === 0,
}));

function Fixture() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  if (document.documentElement.dataset.fixture === "member-actions") return (
    <CircleMemberActionsMenu displayName="Asha" initials="AM" canShare canRemove busy={false}
      onShare={() => {}} onRemove={async () => {}} />
  );
  if (document.documentElement.dataset.fixture === "create-people") return (
    <Dialog modal open><TaskDialogContent aria-label="Create Circle: add people">
      <DialogTitle className="sr-only">Create Circle: add people</DialogTitle>
      <CreateCirclePeopleStep circleId="family" circleName="Family" active
        onLoad={async (_id, options) => ({ eligibleConnections: eligibleConnections.filter(person => person.displayName.includes(options.query ?? "")), pendingInvites: [], remainingCapacity: 50, page: options.page, hasMore: options.page === 1, totalCount: 45 })}
        onAdd={async () => {}} onComplete={() => {}} onBack={() => {}} onSavingChange={() => {}} />
    </TaskDialogContent></Dialog>
  );
  if (document.documentElement.dataset.fixture === "confirmation") return (
    <AlertDialog open><TaskAlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Remove this person from your Circle?</AlertDialogTitle>
        <AlertDialogDescription>{"A long translated explanation of the existing removal action. ".repeat(20)}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction>Remove</AlertDialogAction></AlertDialogFooter>
    </TaskAlertDialogContent></AlertDialog>
  );
  if (document.documentElement.dataset.fixture === "living") return (
    <Sheet modal open><AdaptiveSheetContent dragDismiss={false} className={taskSurfaceStyles.people}>
      <SheetHeader><SheetTitle>Add people</SheetTitle><SheetDescription>Select connections to add to Family.</SheetDescription></SheetHeader>
      <LivingCirclePanel focusOnAdding circleName="Family" members={[]} memberCount={1} canInvite candidates={eligibleConnections.filter(person => person.displayName.includes(query))}
        selectedPeople={eligibleConnections.filter(person => selected.has(person.userId))} availableCount={45} remainingCapacity={20} loading={false} error={null}
        selectedUserIds={selected} submitting={false} onAdd={id => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
        onSubmit={() => {}} searchQuery={query} onSearchChange={setQuery} hasMore={false} loadingMore={false} onLoadMore={() => {}} onRetry={() => {}} />
    </AdaptiveSheetContent></Sheet>
  );
  return (
  <CircleInvitePeopleSheet
    open
    onOpenChange={() => {}}
    circleId="trusted"
    circleName="Trusted"
    onLoadEligibleConnections={async () => ({ eligibleConnections, pendingInvites: [], remainingCapacity: 50 })}
    onInviteConnections={async () => {}}
    onCancelMemberInvite={async () => {}}
  />
  );
}
if (document.documentElement.dataset.probe) {
  const probe = startFramePacingProbe({ hud: false });
  probe.setRoute("/one/connect", "?fixture=circle-picker");
  Object.assign(window, { stopFixtureProbe: () => probe.stop() });
}
createRoot(document.getElementById("root")!).render(<Fixture />);
