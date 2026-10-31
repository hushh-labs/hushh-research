import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentQueuedStack, QueuedJoinedCaption } from "../../components/agent/agent-queued-stack";
import { CHAT_USER_BUBBLE_CLASSNAME } from "../../components/agent/chat-message-styles";
import type { QueuedAgentPrompt } from "../../lib/agent/agent-chat-prompt-queue";

/**
 * The queued stack above the composer, from the production components, inside
 * the same width box the chat gives the composer (the bottom shell's max width
 * with 0.75rem gutters). A joined message sits in the transcript above it with
 * its caption. Only the composer field itself is a stand-in: the spec measures
 * the stack against its box, not its contents.
 */
const PROMPTS: QueuedAgentPrompt[] = [
  { id: "a", text: "Also include the Friday design review", createdAtMs: 1, joinable: true, placement: "joining" },
  { id: "b", text: "Actually move the standup to 9:30", createdAtMs: 2, joinable: true, placement: "joining" },
  {
    id: "c",
    text: "And after that, draft a short note to the team explaining the new schedule, with the room and the dial-in for anyone remote this week",
    createdAtMs: 3,
    joinable: true,
    placement: "waiting",
  },
];

function Fixture() {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [prompts, setPrompts] = useState(PROMPTS);
  return (
    <div data-one-chat-surface className="min-h-screen bg-[color:var(--one-chat-canvas)] text-foreground">
      <div className="px-3 pt-6">
        <div data-testid="fixture-transcript" className="mx-auto flex w-full max-w-[var(--app-bottom-shell-max-width)] flex-col gap-3">
          <div className="flex w-full justify-end">
            <div className="min-w-0 max-w-[90%] sm:max-w-[min(76%,42rem)]">
              <div className={`text-sm leading-6 ${CHAT_USER_BUBBLE_CLASSNAME}`}>Plan my week around the launch</div>
            </div>
          </div>
          <div className="flex w-full justify-end">
            <div data-testid="fixture-joined-row" className="min-w-0 max-w-[90%] sm:max-w-[min(76%,42rem)]">
              <div data-testid="fixture-joined-bubble" className={`text-sm leading-6 ${CHAT_USER_BUBBLE_CLASSNAME}`}>
                Also include the Friday design review
              </div>
              <QueuedJoinedCaption />
            </div>
          </div>
        </div>
      </div>
      <form className="px-3 pt-3 pb-6" onSubmit={(event) => event.preventDefault()}>
        <div data-testid="fixture-composer-stack" className="mx-auto w-full max-w-[var(--app-bottom-shell-max-width)]">
          <AgentQueuedStack
            prompts={prompts}
            editingId={editingId}
            editingText={editingText}
            onEditStart={(prompt) => {
              setEditingId(prompt.id);
              setEditingText(prompt.text);
            }}
            onEditChange={setEditingText}
            onEditSave={(id) => {
              setPrompts((current) => current.map((prompt) => (prompt.id === id ? { ...prompt, text: editingText } : prompt)));
              setEditingId(null);
            }}
            onEditCancel={() => setEditingId(null)}
            onRemove={(id) => setPrompts((current) => current.filter((prompt) => prompt.id !== id))}
          />
          <div data-testid="fixture-composer" className="h-14 rounded-[26px] bg-foreground/[0.045]" />
        </div>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
