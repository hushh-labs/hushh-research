import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { AppBottomShell } from "../../components/app-ui/app-bottom-shell";
import { useVoiceSessionStore } from "../../lib/one-voice/session-store";
import { INITIAL_VOICE_SESSION_STATE } from "../../lib/one-voice/session-types";
import { AgentDockProvider, AgentDockPortal } from "../../components/agent/agent-dock";
import { AgentBarSurface } from "../../components/agent/agent-bar-surface";
import { ShellActionSurface } from "../../components/app-ui/shell-action-surface";

/**
 * The persistent bottom chrome exactly as `app/providers.tsx` mounts it: the
 * production `AppBottomShell` with its "Talk to One" slot and navigation pill.
 *
 * `<html>` data attributes pick the state before the script runs:
 *   data-agent="live"      One Live Voice dock instead of the command bar
 *   data-voice="expanded"  a live session with its conversation panel open
 *   data-command="working" the command bar mid-task (transcript above it)
 *   data-path="/one/location" the route the navigation resolves against
 */
const dataset = document.documentElement.dataset;

if (dataset.voice === "expanded") {
  useVoiceSessionStore.setState({
    state: {
      ...INITIAL_VOICE_SESSION_STATE,
      phase: "listening",
      conversationId: "fixture",
      sessionId: "fixture",
      transcript: [
        {
          id: "t1",
          role: "you",
          text: "Who is in my trusted circle?",
          final: true,
          turnId: "turn-1",
        },
        {
          id: "t2",
          role: "one",
          text: "Three people: Alex, Jordan and Casey.",
          final: true,
          turnId: "turn-1",
        },
      ],
    },
  });
}

function Page() {
  const [chat, setChat] = useState(dataset.composer === "true");
  const [voice, setVoice] = useState(false);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!field.current) return;
    field.current.style.height = "0px";
    const ceiling = Number.parseFloat(getComputedStyle(field.current).maxHeight);
    field.current.style.height = `${Math.min(field.current.scrollHeight, ceiling)}px`;
  }, [draft, chat]);
  return (
    <AgentDockProvider>
      <main
        data-fixture-page=""
        style={{ minHeight: "180vh", padding: "24px 16px" }}
        className="bg-background text-foreground"
      >
        {Array.from({ length: 12 }, (_, index) => (
          <p key={index} className="py-3">
            Route content row {index + 1}
          </p>
        ))}
        {dataset.composer === "true" ? <div>
          <button data-testid="fixture-route" onClick={() => setChat(value => !value)}>Switch route</button>
          <button data-testid="fixture-mode" onClick={() => setVoice(value => !value)}>Switch input mode</button>
        </div> : null}
      </main>
      <AppBottomShell model={{ navigationHidden: false, agentBarHidden: chat }} />
      {chat ? <AgentDockPortal enabled visible={!voice}>
        <form data-agent-chat-composer-form="root" onSubmit={event => event.preventDefault()}>
          <AgentBarSurface embedded className="agent-chat-composer-surface agent-chat-composer-compact flex min-w-0 items-end gap-2 overflow-hidden">
            <div className="relative flex min-h-0 min-w-0 flex-1 items-center">
              <textarea ref={field} aria-label="Message One" placeholder="Message One..." rows={1} value={draft} onChange={event => setDraft(event.target.value)} className="agent-chat-composer-field block w-full min-w-0 resize-none overflow-y-auto border-0 bg-transparent text-[16px] break-words [overflow-wrap:anywhere]" />
            </div>
            <div className="agent-chat-composer-actions flex shrink-0 items-center gap-1">
              <ShellActionSurface aria-label="Start voice mode">Mic</ShellActionSurface>
              <ShellActionSurface type="submit" aria-label="Send message">Send</ShellActionSurface>
            </div>
          </AgentBarSurface>
        </form>
      </AgentDockPortal> : null}
    </AgentDockProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
