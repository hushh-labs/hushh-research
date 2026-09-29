import { useState } from "react";
import { createRoot } from "react-dom/client";

import { CHAT_USER_BUBBLE_CLASSNAME } from "../../components/agent/chat-message-styles";
import {
  ChatOnboardingDailyTip,
  ChatOnboardingTurns,
} from "../../components/agent/chat-onboarding/chat-onboarding-transcript";
import type { ChatOnboardingController } from "../../lib/agent/chat-onboarding/use-chat-onboarding";
import type { ChatOnboardingTurn } from "../../lib/agent/chat-onboarding/chat-onboarding-machine";
import {
  CHAT_ONBOARDING_FOCUS_PLAN,
  focusChips,
  welcomeText,
} from "../../lib/agent/chat-onboarding/chat-onboarding-script";

/**
 * One chat's onboarding at real width: the shipped transcript, chips, connect
 * action and daily tip, inside the chat's reading column. The assistant bubble
 * is a stand-in with AgentBubble's exact width and type classes (the real one
 * pulls the whole signed-in workspace into the bundle); the onboarding pieces
 * under test are the real modules. The person's own turn wears the shipped
 * accent bubble (CHAT_USER_BUBBLE_CLASSNAME), so text selection on it is
 * measured against the real fill.
 */
const TURNS: ChatOnboardingTurn[] = [
  { id: "t1", role: "assistant", text: welcomeText("Kushal"), anchor: null },
  { id: "t2", role: "user", text: "Call me Kushal", anchor: null },
  {
    id: "t3",
    role: "assistant",
    text: "Nice to meet you, Kushal. What should I help with first?",
    anchor: null,
    chips: focusChips(),
  },
];
const EXPLANATION: ChatOnboardingTurn = {
  id: "t4",
  role: "assistant",
  text: CHAT_ONBOARDING_FOCUS_PLAN.email.explanation,
  anchor: null,
  action: CHAT_ONBOARDING_FOCUS_PLAN.email.action!,
};

function Harness() {
  const [tipOpen, setTipOpen] = useState(true);
  const controller: ChatOnboardingController = {
    turns: [...TURNS, EXPLANATION],
    activeChipTurnId: "t3",
    shownTurns: new Map([...TURNS, EXPLANATION].map((turn) => [turn.id, "9:41 AM"])),
    shownTurnTimes: new Map(),
    markShown: () => undefined,
    busy: false,
    onChip: () => undefined,
    captureComposerText: () => false,
    composerPlaceholder: null,
    dailyTip: null,
    dismissDailyTip: () => undefined,
  };
  return (
    <main className="min-h-dvh bg-background px-4 pt-5 text-foreground sm:px-6 lg:px-8">
      <div data-testid="transcript" className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <ChatOnboardingTurns
          controller={controller}
          slot={{ kind: "top" }}
          renderBubble={(message) => (
            <div
              data-message-role={message.role}
              className={
                message.role === "user"
                  ? "flex w-full justify-end"
                  : "flex w-full justify-start"
              }
            >
              <div className="min-w-0 max-w-[90%] sm:max-w-[min(82%,48rem)]">
                {message.role === "user" ? (
                  <div className={`text-sm leading-6 ${CHAT_USER_BUBBLE_CLASSNAME}`}>
                    <span className="whitespace-pre-wrap break-words">{message.text}</span>
                  </div>
                ) : (
                  <div className="px-1 py-2 text-sm leading-6">{message.text}</div>
                )}
              </div>
            </div>
          )}
          onConnect={() => undefined}
        />
        {tipOpen ? (
          <ChatOnboardingDailyTip
            tip="Which emails need a reply?"
            onUse={() => undefined}
            onDismiss={() => setTipOpen(false)}
          />
        ) : null}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
