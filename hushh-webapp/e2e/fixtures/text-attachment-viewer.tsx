import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { AgentMessageAttachments } from "../../components/agent/agent-message-attachments";
import {
  findPendingAssistantTurn,
  measureTranscriptReveal,
  transcriptRevealScrollTop,
} from "../../lib/agent/agent-chat-transcript-scroll";
import { createAgentTextAttachment } from "../../lib/agent/large-text-attachment";

/**
 * One chat's geometry in miniature: a transcript that scrolls inside a fixed
 * frame and reserves its bottom band, and a composer laid OVER that band
 * (`absolute bottom-0`), as in agent-chat-workspace. The chip, the viewer and
 * the reveal helper are the real modules; only the chat around them is a
 * stand-in, so the spec measures real layout without a signed-in session.
 *
 * `?reveal=legacy` swaps the send scroll for the old
 * `scrollIntoView({ block: "end" })`, the negative control.
 */
const params = new URLSearchParams(window.location.hash.slice(1));
const legacy = params.get("reveal") === "legacy";
const lineCount = Number(params.get("lines") ?? "2000");

const PASTE = Array.from({ length: lineCount }, (_, index) =>
  index % 40 === 0
    ? `function section${index}() {`
    : `  const row${index} = ledger.entries[${index}] ?? { amount: ${index} * 3, note: "row ${index}" };`,
).join("\n");
const ATTACHMENTS = [createAgentTextAttachment(PASTE)];
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
                <AgentMessageAttachments attachments={ATTACHMENTS} />
              </div>
            </div>
          </div>
          {rows.map((row) => (
            <div
              key={row.id}
              data-message-role={row.role}
              data-message-status={row.status}
              data-testid={row.id === "pending" ? "pending-turn" : undefined}
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
