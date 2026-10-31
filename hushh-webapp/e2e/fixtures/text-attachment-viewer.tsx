import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { AgentMessageAttachments } from "../../components/agent/agent-message-attachments";
import { AgentComposerTextAttachment } from "../../components/agent/agent-text-attachment-editor";
import {
  findPendingAssistantTurn,
  measureTranscriptReveal,
  transcriptRevealScrollTop,
} from "../../lib/agent/agent-chat-transcript-scroll";
import {
  createAgentTextAttachment,
  createPendingTextAttachment,
  type PendingTextAttachment,
} from "../../lib/agent/large-text-attachment";

/**
 * One chat's geometry in miniature: a transcript that scrolls inside a fixed
 * frame and reserves its bottom band, and a composer laid OVER that band
 * (`absolute bottom-0`), as in agent-chat-workspace. The chip, the viewer and
 * the reveal helper are the real modules; only the chat around them is a
 * stand-in, so the spec measures real layout without a signed-in session.
 *
 * `?reveal=legacy` swaps the send scroll for the old
 * `scrollIntoView({ block: "end" })`, the negative control.
 * `?pending=<KB>` puts a pending paste of about that size in the composer, as
 * the editor's chip; the sent chip offers "Edit and send again", which appends
 * the edited copy as a NEW row.
 */
const params = new URLSearchParams(window.location.hash.slice(1));
const legacy = params.get("reveal") === "legacy";
const lineCount = Number(params.get("lines") ?? "2000");
const pendingKb = Number(params.get("pending") ?? "0");

const PASTE = Array.from({ length: lineCount }, (_, index) =>
  index % 40 === 0
    ? `function section${index}() {`
    : `  const row${index} = ledger.entries[${index}] ?? { amount: ${index} * 3, note: "row ${index}" };`,
).join("\n");
const ATTACHMENTS = [createAgentTextAttachment(PASTE)];

function pendingPaste(kilobytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let index = 0; size < kilobytes * 1024; index += 1) {
    const line =
      index % 25 === 0
        ? `## Ledger section ${index / 25 + 1}`
        : `ledger ${index}: paid ${index * 7} to vendor ${index % 13} for invoice ${1000 + index}, reconciled.`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}
const LONG_PROMPT = Array.from(
  { length: 40 },
  (_, index) => `Line ${index + 1} of a long prompt the person typed before pressing Send.`,
).join("\n");

type Row = { id: string; role: "user" | "assistant"; text: string; status?: string };

const HISTORY: Row[] = Array.from({ length: 12 }, (_, index) => ({
  id: `history-${index}`,
  role: index % 2 ? "assistant" : "user",
  text: `Earlier message ${index + 1}. `.repeat(6),
  status: "done",
}));

function Harness() {
  const [rows, setRows] = useState<Row[]>(HISTORY);
  const [draft, setDraft] = useState("half-typed reply");
  const [pending, setPending] = useState<PendingTextAttachment | null>(() =>
    pendingKb ? createPendingTextAttachment(pendingPaste(pendingKb)) : null,
  );
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const submitted = useRef(false);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const end = endRef.current;
    if (!transcript || !end) return;
    if (!submitted.current) {
      transcript.scrollTop = transcript.scrollHeight;
      return;
    }
    submitted.current = false;
    if (legacy) {
      end.scrollIntoView({ block: "end" });
      return;
    }
    const target = findPendingAssistantTurn(transcript) ?? end;
    transcript.scrollTo({
      top: transcriptRevealScrollTop(
        measureTranscriptReveal(transcript, target, composerRef.current),
      ),
    });
  }, [rows]);

  const send = () => {
    submitted.current = true;
    setRows((current) => [
      ...current,
      { id: "sent", role: "user", text: LONG_PROMPT, status: "done" },
      { id: "pending", role: "assistant", text: "One is preparing your response.", status: "streaming" },
    ]);
  };

  return (
    <div className="relative h-dvh overflow-hidden bg-background text-foreground">
      <div
        ref={transcriptRef}
        data-testid="transcript"
        className="h-full overflow-y-auto px-4 pt-5 pb-[calc(5rem+5.5rem)]"
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <div data-message-role="user" className="flex justify-end">
            <div className="max-w-[76%] rounded-[22px] bg-[color:var(--app-accent)] px-4 py-2.5 text-sm text-[color:var(--app-accent-fg)]">
              <span>Summarize this</span>
              <div className="mt-2">
                <AgentMessageAttachments
                  attachments={ATTACHMENTS}
                  onResend={(_, text) => {
                    setRows((current) => [
                      ...current,
                      {
                        id: `resent-${current.length}`,
                        role: "user",
                        text: `Sent again: ${text.split("\n").length} lines`,
                        status: "done",
                      },
                    ]);
                    return true;
                  }}
                />
              </div>
            </div>
          </div>
          {rows.map((row) => (
            <div
              key={row.id}
              data-message-role={row.role}
              data-message-status={row.status}
              data-testid={
                row.id === "pending" ? "pending-turn" : row.id.startsWith("resent-") ? "resent-turn" : undefined
              }
              className={row.role === "user" ? "flex justify-end" : "flex"}
            >
              <div className="max-w-[76%] whitespace-pre-wrap rounded-[22px] bg-foreground/[0.06] px-4 py-2.5 text-sm">
                {row.text}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <form
        className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-[5rem] pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {pending ? (
          <div className="pointer-events-auto mx-auto max-w-xl">
            <AgentComposerTextAttachment
              attachment={pending}
              onChange={(text) => setPending(text.trim() ? createPendingTextAttachment(text) : null)}
              onRemove={() => setPending(null)}
              onCollapse={() => undefined}
            />
          </div>
        ) : null}
        <div ref={composerRef} data-testid="composer" className="pointer-events-auto mx-auto flex max-w-xl gap-2">
          <textarea
            aria-label="Message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[3.75rem] flex-1 rounded-[24px] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3"
          />
          <button type="submit" className="rounded-full bg-[color:var(--app-accent)] px-4 text-[color:var(--app-accent-fg)]">
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
