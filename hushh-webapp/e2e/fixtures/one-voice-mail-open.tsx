/**
 * The real mail result card, in a real browser, with a real Open call.
 *
 * `ToolResultCard` and `MailDetail` are the shipped components, and `onOpenMail`
 * is the shipped `openOfferedMail` -- so the tap makes an actual POST that the
 * spec answers. Nothing about the row, the ordinal or the binding is simulated.
 */

import { createRoot } from "react-dom/client";

import { ToolResultCard } from "../../components/one-voice/tool-result-card";
import { openOfferedMail } from "../../lib/one-voice/mail-open";
import type { ToolResultPublic } from "../../lib/one-voice/protocol";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

const RESULT: ToolResultPublic = {
  status: "ok",
  spoken_facts: ["I read your 3 newest messages."],
  ui_refresh: ["mail"],
  answer:
    "Priya needs the Q3 deck by Friday, and the March invoice is overdue.",
  sources: [
    { source_ref: "mail:1", label: "Mail", kind: "message" },
    { source_ref: "mail:3", label: "Mail", kind: "message" },
  ],
  items: [
    {
      source_ref: "mail:1",
      subject: "Q3 deck",
      sender: "Priya Nair",
      received_at: "2026-09-28T09:00:00+00:00",
      unread: true,
      gist: "Priya wants the Q3 deck by Friday.",
    },
    // Deliberately unlabelled. It used to be filtered out, which renumbered the
    // rows below it; row three must still open the third message.
    { source_ref: "mail:2" },
    {
      source_ref: "mail:3",
      subject: "March invoice",
      sender: "Acme Billing",
      received_at: "2026-09-27T14:30:00+00:00",
      gist: "The March invoice is overdue.",
    },
  ],
  coverage: {
    operation: "read_message",
    mailbox: "inbox",
    scope: "newest",
    unit: "messages",
    assessed: 3,
    returned: 3,
    cited: 2,
    matches_beyond_page: false,
    items_omitted: false,
    content_shortened: false,
    content_depth: "message",
    one_page_only: true,
  },
  truncated: false,
  metadata_only: false,
  offer_revision: 7,
  conversation_id: CONVERSATION_ID,
};

function Fixture() {
  return (
    <main className="mx-auto min-h-dvh max-w-xl space-y-4 bg-background p-4 text-foreground">
      <ToolResultCard
        result={RESULT}
        tool="read_mail"
        ok
        onOpenMail={(input) =>
          openOfferedMail({
            vaultOwnerToken: "HCT:synthetic-owner-token",
            conversationId: input.conversationId,
            ordinal: input.ordinal,
            offerRevision: input.offerRevision,
          })
        }
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
