import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Toaster } from "../../components/ui/sonner";
import { ContactSyncResultsSheet } from "../../components/one-location/contact-sync-results-sheet";
import { useContactInvitationSession } from "../../lib/contacts/use-contact-invitations";
import type { OneLocationContactSignalResult } from "../../lib/one-location/contact-signals";
import { createRoot } from "react-dom/client";
import { ContactInvitationSheet } from "../../components/connections/contact-invitation-sheet";
import type { ContactInvitationController } from "../../lib/contacts/use-contact-invitations";
import type { InviteCandidate } from "../../lib/contacts/invitation-candidates";
import { useInvitationQueue } from "../../lib/contacts/use-invitation-queue";

// Sheets, notifications and invitation session/queue hooks are real. External
// matching outcomes and messaging hand-offs are stubbed; nothing is sent.
const CANDIDATES: InviteCandidate[] = Array.from(
  { length: 40 },
  (_, index) => ({
    id: `contact-${index}`,
    displayName: `Contact person ${index + 1}`,
    destinations: [
      { kind: "phone", value: `+1 415 555 ${String(1000 + index)}` },
    ],
    classification: index < 32 ? "no_match" : "email_only",
  }),
).reverse();

function Harness() {
  const draft = useInvitationQueue(CANDIDATES, null, () => () => true);
  const controller = {
    enabled: true,
    version: 1,
    clear: () => {},
    beginSync: () => undefined,
    open: async () => true,
    retryPreparation: async () => {},
    captureSession: () => () => true,
    candidates: CANDIDATES,
    active: true,
    share: null,
    preparing: false,
    error: null,
    draft,
  } as unknown as ContactInvitationController;
  return <ContactInvitationSheet controller={controller} onFinish={() => {}} />;
}

const RESULT: OneLocationContactSignalResult = {
  matches: [],
  matchedUserIds: [],
  totalContacts: 40,
  readContactCount: 40,
  checkedContactCount: 40,
  matchedContactCount: 0,
  unmatchedContactCount: 40,
  uncheckableContactCount: 0,
  excludedSelfContactCount: 0,
  lookupLimitedContactCount: 0,
  lookupLimitExceeded: false,
  unknownContactCount: 0,
  mutationOutcomeUnknown: false,
  uncheckedContactCount: 0,
  inviteCandidateCount: 40,
  autoConnectedCount: 0,
  alreadyConnectedCount: 0,
  requestRequiredCount: 0,
  suppressedCount: 0,
  completedBatchCount: 1,
  totalBatchCount: 1,
  partial: false,
  sourcePlatform: "ios",
  region: null,
  limited: false,
  truncated: false,
};
function SyncNotificationHarness() {
  const invitations = useContactInvitationSession("fixture-owner");
  const {
    beginSync,
    candidates,
    captureSession,
    open: openInvitations,
  } = invitations;
  const [open, setOpen] = useState(true);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    beginSync()?.(CANDIDATES);
    setReady(true);
  }, [beginSync]);
  useEffect(() => {
    if (!ready || !candidates.length) return;
    const isCurrent = captureSession();
    const id = toast.info("No eligible contacts matched", {
      duration: Infinity,
      action: {
        label: "Invite them",
        onClick: () => {
          if (isCurrent()) void openInvitations(async () => null);
        },
      },
    });
    return () => {
      toast.dismiss(id);
    };
  }, [ready, candidates, captureSession, openInvitations]);
  return (
    <>
      <Toaster />
      <ContactSyncResultsSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) invitations.clear();
          setOpen(next);
        }}
        result={RESULT}
        syncing={false}
        onSyncAgain={() => {}}
        onInvite={() => {
          void openInvitations(async () => null);
        }}
        onRequestConnection={async () => {}}
        invitations={invitations}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  document.documentElement.dataset.syncNotification === "true" ? (
    <SyncNotificationHarness />
  ) : (
    <Harness />
  ),
);
