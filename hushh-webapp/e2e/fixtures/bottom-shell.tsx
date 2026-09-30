import React from "react";
import { createRoot } from "react-dom/client";

import { AppBottomShell } from "../../components/app-ui/app-bottom-shell";
import { useVoiceSessionStore } from "../../lib/one-voice/session-store";
import { INITIAL_VOICE_SESSION_STATE } from "../../lib/one-voice/session-types";

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
  return (
    <>
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
      </main>
      <AppBottomShell model={{ navigationHidden: false }} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
