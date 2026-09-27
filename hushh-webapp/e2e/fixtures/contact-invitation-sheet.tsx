import { createRoot } from "react-dom/client";
import { ContactInvitationSheet } from "../../components/connections/contact-invitation-sheet";
import type { ContactInvitationController } from "../../lib/contacts/use-contact-invitations";
import type { InviteCandidate } from "../../lib/contacts/invitation-candidates";
import { useInvitationQueue } from "../../lib/contacts/use-invitation-queue";

// The sheet and its queue hook are real. Only the messaging hand-off service is
// stubbed (see the spec's aliases), because nothing here sends anything.
const CANDIDATES: InviteCandidate[] = Array.from({ length: 40 }, (_, index) => ({
  id: `contact-${index}`,
  displayName: `Contact person ${index + 1}`,
  destinations: [{ kind: "phone", value: `+1 415 555 ${String(1000 + index)}` }],
  classification: index < 32 ? "no_match" : "email_only",
}));

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

createRoot(document.getElementById("root")!).render(<Harness />);
