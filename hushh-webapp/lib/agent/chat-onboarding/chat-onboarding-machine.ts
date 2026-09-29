/**
 * Pure state machine for One's conversational onboarding.
 *
 * No React, no I/O: `reduceChatOnboarding` takes an event and returns the next
 * state plus the side effects the host must run. That keeps the ordering
 * guarantees (one question per turn, save only on confirm, typed text is an
 * answer only after an explicit "Something else") provable in unit tests.
 */
import {
  CHAT_ONBOARDING_FOCUS_PLAN,
  CHAT_ONBOARDING_QUESTIONS,
  CHAT_ONBOARDING_TONE_LABEL,
  DONE_TEXT,
  NAME_TYPING_HINT,
  NOT_SAVED_TEXT,
  SAVED_TEXT,
  SAVE_FAILED_TEXT,
  confirmChips,
  confirmText,
  focusChips,
  focusLabel,
  focusQuestionText,
  nameChips,
  normalizePreferredName,
  resumeQuestionText,
  toneChips,
  toneQuestionText,
  welcomeText,
  type ChatOnboardingChip,
  type ChatOnboardingChipId,
  type ChatOnboardingConnectAction,
  type ChatOnboardingFocus,
  type ChatOnboardingQuestionId,
  type ChatOnboardingQuestionStatus,
  type ChatOnboardingTone,
} from "@/lib/agent/chat-onboarding/chat-onboarding-script";

/**
 * The only state that outlives the tab. It carries no answer values: which
 * questions were answered or skipped, and two calendar dates. Names and tone
 * live in encrypted memory, and only after the person confirms.
 */
export type ChatOnboardingProgress = {
  version: 1;
  status: "in_progress" | "completed";
  questions: Record<ChatOnboardingQuestionId, ChatOnboardingQuestionStatus>;
  /** Local calendar date (YYYY-MM-DD) the flow finished; drives the daily tip. */
  completedOn: string | null;
  /** Local calendar date the person last dismissed the daily tip. */
  tipDismissedOn: string | null;
};

export type ChatOnboardingStep =
  | "name"
  | "name_typing"
  | "focus"
  | "tone"
  | "confirm"
  | "saving"
  | "save_failed"
  | "done";

export type ChatOnboardingTurn = {
  id: string;
  role: "assistant" | "user";
  text: string;
  /**
   * The id of the last real chat message when this turn was created, so an
   * unrelated exchange interleaves in order. `null` means "before any message".
   */
  anchor: string | null;
  /** Rendered only while this is the active assistant turn. */
  chips?: ChatOnboardingChip[];
  /** At most one inline connect action (the "help with first" reply). */
  action?: ChatOnboardingConnectAction;
};

export type ChatOnboardingState = {
  progress: ChatOnboardingProgress;
  step: ChatOnboardingStep;
  /** Session-only drafts. Never persisted, never sent to the server in plaintext. */
  draft: { name: string | null; tone: ChatOnboardingTone | null };
  turns: ChatOnboardingTurn[];
  seq: number;
};

export type ChatOnboardingEffect =
  | { type: "persist_progress"; progress: ChatOnboardingProgress }
  | { type: "save_preferences"; name: string | null; tone: ChatOnboardingTone | null }
  | { type: "focus_composer" };

export type ChatOnboardingEvent =
  | { type: "start"; displayName: string; firstName: string | null; anchor: string | null }
  | {
      type: "resume";
      progress: ChatOnboardingProgress;
      firstName: string | null;
      anchor: string | null;
      today: string;
    }
  | { type: "chip"; chipId: ChatOnboardingChipId; anchor: string | null; today: string; firstName: string | null }
  | { type: "typed_answer"; text: string; anchor: string | null }
  | { type: "save_result"; ok: boolean; anchor: string | null; today: string };

export type ChatOnboardingResult = {
  state: ChatOnboardingState;
  effects: ChatOnboardingEffect[];
  /**
   * For `typed_answer` only: whether the composer text was taken as the
   * onboarding answer. `false` means it goes to One as an ordinary turn.
   */
  consumed?: boolean;
};

export function newChatOnboardingProgress(): ChatOnboardingProgress {
  return {
    version: 1,
    status: "in_progress",
    questions: { name: "pending", focus: "pending", tone: "pending" },
    completedOn: null,
    tipDismissedOn: null,
  };
}

export function firstPendingQuestion(
  progress: ChatOnboardingProgress,
): ChatOnboardingQuestionId | null {
  return CHAT_ONBOARDING_QUESTIONS.find((id) => progress.questions[id] === "pending") ?? null;
}

/** The step a person is waiting on. `name_typing` counts as the name question. */
export function isAwaitingTypedName(state: ChatOnboardingState | null): boolean {
  return state?.step === "name_typing";
}

function emptyState(progress: ChatOnboardingProgress): ChatOnboardingState {
  return { progress, step: "done", draft: { name: null, tone: null }, turns: [], seq: 0 };
}

function pushTurn(
  state: ChatOnboardingState,
  turn: Omit<ChatOnboardingTurn, "id">,
): ChatOnboardingState {
  const seq = state.seq + 1;
  return { ...state, seq, turns: [...state.turns, { ...turn, id: `onboarding-${seq}` }] };
}

function mark(
  progress: ChatOnboardingProgress,
  question: ChatOnboardingQuestionId,
  status: ChatOnboardingQuestionStatus,
): ChatOnboardingProgress {
  return { ...progress, questions: { ...progress.questions, [question]: status } };
}

function complete(progress: ChatOnboardingProgress, today: string): ChatOnboardingProgress {
  return { ...progress, status: "completed", completedOn: progress.completedOn ?? today };
}

function askQuestion(
  state: ChatOnboardingState,
  question: ChatOnboardingQuestionId,
  text: string,
  anchor: string | null,
  firstName: string | null,
): ChatOnboardingState {
  const chips =
    question === "name" ? nameChips(firstName) : question === "focus" ? focusChips() : toneChips();
  return pushTurn({ ...state, step: question }, { role: "assistant", text, anchor, chips });
}

/** After the tone question: confirm only when something is worth saving. */
function finishQuestions(
  state: ChatOnboardingState,
  anchor: string | null,
  today: string,
): ChatOnboardingResult {
  const { name, tone } = state.draft;
  if (name || tone) {
    // Progress is persisted only when the flow ends (save, decline or failure
    // acknowledged), so a reload before confirming re-asks nothing but also
    // saves nothing.
    const next = pushTurn(
      { ...state, step: "confirm" },
      { role: "assistant", text: confirmText({ name, tone }), anchor, chips: confirmChips() },
    );
    return { state: next, effects: [{ type: "persist_progress", progress: next.progress }] };
  }
  const progress = complete(state.progress, today);
  const next = pushTurn({ ...state, progress, step: "done" }, { role: "assistant", text: DONE_TEXT, anchor });
  return { state: next, effects: [{ type: "persist_progress", progress }] };
}

function answerQuestion(
  state: ChatOnboardingState,
  question: ChatOnboardingQuestionId,
  status: "answered" | "skipped",
  userText: string,
  anchor: string | null,
  today: string,
  firstName: string | null,
): ChatOnboardingResult {
  const progress = mark(state.progress, question, status);
  let next = pushTurn({ ...state, progress }, { role: "user", text: userText, anchor });
  if (question === "name") {
    next = askQuestion(
      next,
      "focus",
      focusQuestionText(next.draft.name, status === "skipped"),
      anchor,
      firstName,
    );
    return { state: next, effects: [{ type: "persist_progress", progress }] };
  }
  if (question === "focus") {
    next = askQuestion(next, "tone", toneQuestionText(), anchor, firstName);
    return { state: next, effects: [{ type: "persist_progress", progress }] };
  }
  return finishQuestions(next, anchor, today);
}

export function reduceChatOnboarding(
  state: ChatOnboardingState | null,
  event: ChatOnboardingEvent,
): ChatOnboardingResult {
  if (event.type === "start") {
    const progress = newChatOnboardingProgress();
    const next = pushTurn(
      { ...emptyState(progress), step: "name" },
      {
        role: "assistant",
        text: welcomeText(event.displayName),
        anchor: event.anchor,
        chips: nameChips(event.firstName),
      },
    );
    return { state: next, effects: [{ type: "persist_progress", progress }] };
  }

  if (event.type === "resume") {
    const question = firstPendingQuestion(event.progress);
    if (event.progress.status === "completed") {
      return { state: emptyState(event.progress), effects: [] };
    }
    if (!question) {
      // Every question was answered or skipped but the tab closed before the
      // person confirmed. The unconfirmed answers were session-only and are
      // gone, so nothing is saved; close the flow so it never repeats.
      const progress = complete(event.progress, event.today);
      return { state: emptyState(progress), effects: [{ type: "persist_progress", progress }] };
    }
    const next = askQuestion(
      emptyState(event.progress),
      question,
      resumeQuestionText(question),
      event.anchor,
      event.firstName,
    );
    return { state: next, effects: [] };
  }

  if (!state) return { state: emptyState(newChatOnboardingProgress()), effects: [] };

  if (event.type === "typed_answer") {
    if (state.step !== "name_typing") return { state, effects: [], consumed: false };
    const name = normalizePreferredName(event.text);
    if (!name) {
      // Not name-shaped (format validation only, never a meaning guess):
      // One answers it as an ordinary message and the name question waits.
      return { state: { ...state, step: "name" }, effects: [], consumed: false };
    }
    const answered = answerQuestion(
      { ...state, draft: { ...state.draft, name } },
      "name",
      "answered",
      name,
      event.anchor,
      "",
      null,
    );
    return { ...answered, consumed: true };
  }

  if (event.type === "save_result") {
    if (state.step !== "saving") return { state, effects: [] };
    if (!event.ok) {
      const next = pushTurn(
        { ...state, step: "save_failed" },
        {
          role: "assistant",
          text: SAVE_FAILED_TEXT,
          anchor: event.anchor,
          chips: [
            { id: "retry_save", label: "Try again" },
            { id: "dont_save", label: "Not now" },
          ],
        },
      );
      return { state: next, effects: [] };
    }
    const progress = complete(state.progress, event.today);
    const next = pushTurn(
      { ...state, progress, step: "done", draft: { name: null, tone: null } },
      { role: "assistant", text: SAVED_TEXT, anchor: event.anchor },
    );
    return { state: next, effects: [{ type: "persist_progress", progress }] };
  }

  // Chip events.
  const { chipId, anchor, today, firstName } = event;
  const current = state.step;

  if (chipId === "skip") {
    const question: ChatOnboardingQuestionId | null =
      current === "name" || current === "name_typing"
        ? "name"
        : current === "focus"
          ? "focus"
          : current === "tone"
            ? "tone"
            : null;
    if (!question) return { state, effects: [] };
    return answerQuestion(state, question, "skipped", "Skip for now", anchor, today, firstName);
  }

  if (current === "name" || current === "name_typing") {
    if (chipId === "name_signin" && firstName) {
      return answerQuestion(
        { ...state, draft: { ...state.draft, name: firstName } },
        "name",
        "answered",
        `Call me ${firstName}`,
        anchor,
        today,
        firstName,
      );
    }
    if (chipId === "name_other") {
      if (current === "name_typing") {
        return { state, effects: [{ type: "focus_composer" }] };
      }
      const next = pushTurn(
        { ...state, step: "name_typing" },
        { role: "assistant", text: NAME_TYPING_HINT, anchor, chips: nameChips(firstName) },
      );
      return { state: next, effects: [{ type: "focus_composer" }] };
    }
    return { state, effects: [] };
  }

  if (current === "focus" && chipId.startsWith("focus_")) {
    const focus = chipId.slice("focus_".length) as ChatOnboardingFocus;
    const plan = CHAT_ONBOARDING_FOCUS_PLAN[focus];
    if (!plan) return { state, effects: [] };
    const progress = mark(state.progress, "focus", "answered");
    let next = pushTurn({ ...state, progress }, { role: "user", text: focusLabel(focus), anchor });
    next = pushTurn(next, {
      role: "assistant",
      text: plan.explanation,
      anchor,
      ...(plan.action ? { action: plan.action } : {}),
    });
    next = askQuestion(next, "tone", toneQuestionText(), anchor, firstName);
    return { state: next, effects: [{ type: "persist_progress", progress }] };
  }

  if (current === "tone" && chipId.startsWith("tone_")) {
    const tone = chipId.slice("tone_".length) as ChatOnboardingTone;
    if (!(tone in CHAT_ONBOARDING_TONE_LABEL)) return { state, effects: [] };
    return answerQuestion(
      { ...state, draft: { ...state.draft, tone } },
      "tone",
      "answered",
      CHAT_ONBOARDING_TONE_LABEL[tone],
      anchor,
      today,
      firstName,
    );
  }

  if ((current === "confirm" && chipId === "save") || (current === "save_failed" && chipId === "retry_save")) {
    const next = pushTurn(
      { ...state, step: "saving" },
      { role: "user", text: chipId === "save" ? "Save to memory" : "Try again", anchor },
    );
    return {
      state: next,
      effects: [{ type: "save_preferences", name: state.draft.name, tone: state.draft.tone }],
    };
  }

  if ((current === "confirm" || current === "save_failed") && chipId === "dont_save") {
    const progress = complete(state.progress, today);
    let next = pushTurn(
      { ...state, progress, step: "done", draft: { name: null, tone: null } },
      { role: "user", text: current === "confirm" ? "Don't save" : "Not now", anchor },
    );
    next = pushTurn(next, { role: "assistant", text: NOT_SAVED_TEXT, anchor });
    return { state: next, effects: [{ type: "persist_progress", progress }] };
  }

  return { state, effects: [] };
}

/** The assistant turn whose chips are live: the latest turn, when it is One's. */
export function activeChipTurnId(state: ChatOnboardingState | null): string | null {
  const last = state?.turns.at(-1);
  if (!last || last.role !== "assistant" || !last.chips?.length) return null;
  if (state?.step === "done" || state?.step === "saving") return null;
  return last.id;
}
