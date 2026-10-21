import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { CHAT_USER_BUBBLE_CLASSNAME } from "../../components/agent/chat-message-styles";
import {
  AgentFollowUpSuggestions,
  AgentSuggestionList,
} from "../../components/agent/agent-follow-up-suggestions";
import {
  ChatOnboardingDailyTip,
  ChatOnboardingTurns,
} from "../../components/agent/chat-onboarding/chat-onboarding-transcript";
import { useChatOnboarding, type ChatOnboardingController } from "../../lib/agent/chat-onboarding/use-chat-onboarding";
import { useOneDisplayName } from "../../lib/agent/use-one-display-name";
import { beginChatPreferredNameTurn } from "../../lib/agent/chat-preferred-name-turn";
import { saveChatPreferredName } from "../../lib/agent/owner-style-settings-writer";
import { ApiService } from "@/lib/services/api-service";
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
    resolved: false,
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
    <main data-agent-chat-workspace="page" data-profile-type-scale="chat" className="min-h-dvh bg-background px-4 pt-5 text-foreground sm:px-6 lg:px-8">
      <div data-testid="transcript" className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <AgentSuggestionList
            suggestions={["What's on my calendar this week?", "Which emails need a reply?", "Who has access to my information?"]}
            layout="starter-grid"
            label="Start a conversation"
            testId="agent-prompt-suggestions"
            onSelect={() => undefined}
          />
          {tipOpen ? (
            <ChatOnboardingDailyTip
              tip="Which emails need a reply?"
              onUse={() => undefined}
              onDismiss={() => setTipOpen(false)}
            />
          ) : null}
        </div>
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
        <AgentFollowUpSuggestions
          suggestions={["Show my connected apps", "Help me prepare for tomorrow with a short plan that I can review and edit before using it"]}
          onSelect={() => undefined}
        />
      </div>
    </main>
  );
}

function NameJourney() {
  const ordinary = window.location.search.includes("ordinary-name");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const name = useOneDisplayName();
  const controller = useChatOnboarding({
    userId: "synthetic-owner", displayName: "Owner", vaultKey: "ab".repeat(32),
    vaultOwnerToken: "synthetic-owner-token", isVaultUnlocked: true, startSignal: !ordinary,
    messages: [], conversationId: "synthetic-chat", visiblePrompts: [],
    onFocusComposer: () => input.current?.focus(),
  });
  async function submit() {
    if (!text.trim() || sending || controller.busy) return;
    const turn = ordinary ? null : controller.beginNameTurn?.(() => true);
    const nameTurn = ordinary ? beginChatPreferredNameTurn({
      isCurrent: () => true,
      save: (chosen, beforeEffect, mayPublish) => saveChatPreferredName({
        userId: "synthetic-owner", vaultKey: "ab".repeat(32),
        vaultOwnerToken: "synthetic-owner-token", name: chosen, beforeEffect, mayPublish,
      }),
    }) : null;
    setSending(true);
    setMessage("");
    try {
      const response = await ApiService.apiFetch("/__fixture/one", { method: "POST", body: JSON.stringify({ text, ...turn?.screenState }) });
      if (!response.ok) throw new Error("Synthetic turn failure");
      const result = await response.json();
      turn?.stage(result, "name-call");
      nameTurn?.stage(result, "name-call");
      turn?.finish(true);
      const saved = await nameTurn?.finish(true);
      if (saved === true) setMessage("Preferred name saved.");
      else if (saved === false) setMessage("Couldn't save your name. Please try again.");
      setText("");
    } catch {
      turn?.finish(false);
      void nameTurn?.finish(false);
      setMessage("I couldn't read that reply. Please try again.");
    } finally { setSending(false); }
  }
  return <main className="mx-auto flex max-w-4xl flex-col gap-6 p-4 text-foreground">
    <div aria-label="Chat profile name" className="text-center">{name}</div>
    <ChatOnboardingTurns controller={controller} slot={{ kind: "top" }}
      renderBubble={message => <p>{message.text}</p>} onConnect={() => undefined} />
    <form onSubmit={event => { event.preventDefault(); void submit(); }} className="flex gap-2">
      <input ref={input} aria-label="Your reply" placeholder={controller.composerPlaceholder ?? "Message One"}
        value={text} onChange={event => setText(event.target.value)} disabled={sending || controller.busy}
        className="min-h-11 min-w-0 flex-1 rounded-full border px-4" />
      <button disabled={sending || controller.busy || !text.trim()} className="min-h-11 px-4">Send</button>
    </form>
    <p role="status">{sending || controller.busy ? "Saving your answer…" : message}</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(
  /name-journey|ordinary-name/.test(window.location.search) ? <NameJourney /> : <Harness />,
);
