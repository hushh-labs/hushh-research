"use client";

/**
 * Host hook for One's conversational onboarding.
 *
 * State layers, smallest authority first:
 * - the machine (turns, step, unconfirmed answers) lives in a session-only
 *   in-memory store, so leaving chat for a connect flow and coming back keeps
 *   the conversation, while a reload drops unconfirmed answers (they are
 *   never written to browser storage);
 * - durable progress (question ids answered/skipped, two dates) lives in the
 *   per-person setup record through `PreVaultUserStateService`;
 * - confirmed answers go to encrypted memory, client-side.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import {
  activeChipTurnId,
  isAwaitingTypedName,
  reduceChatOnboarding,
  type ChatOnboardingEvent,
  type ChatOnboardingState,
  type ChatOnboardingTurn,
} from "@/lib/agent/chat-onboarding/chat-onboarding-machine";
import {
  localCalendarDate,
  pickDailyTip,
  progressFromWire,
  progressToWire,
} from "@/lib/agent/chat-onboarding/chat-onboarding-progress";
import { saveChatOnboardingPreferences } from "@/lib/agent/chat-onboarding/chat-onboarding-preferences";
import {
  signInFirstName,
  type ChatOnboardingChipId,
} from "@/lib/agent/chat-onboarding/chat-onboarding-script";
import {
  PreVaultUserStateService,
  type OneChatOnboardingState,
} from "@/lib/services/pre-vault-user-state-service";

type ChatOnboardingSession = {
  userId: string | null;
  /** `undefined` until the durable record was read; `null` means never started. */
  durable: OneChatOnboardingState | null | undefined;
  machine: ChatOnboardingState | null;
  /**
   * Turns already shown, with the time label they were first shown at, so a
   * remount (leaving chat for a connect flow and returning) never re-types a
   * turn or re-stamps it with the wrong time.
   */
  shownTurns: ReadonlyMap<string, string>;
  /**
   * When each turn was first shown (epoch ms). Drives the transcript's
   * centered time separators; kept beside the label so the label stays the
   * exact string the person saw.
   */
  shownTurnTimes: ReadonlyMap<string, number>;
  /**
   * The conversation onboarding happened in, once it has an id. A finished
   * onboarding stays in that conversation; a new chat starts clean.
   */
  homeConversationId: string | null;
};

const EMPTY_SESSION: ChatOnboardingSession = {
  userId: null,
  durable: undefined,
  machine: null,
  shownTurns: new Map(),
  shownTurnTimes: new Map(),
  homeConversationId: null,
};

export const useChatOnboardingSession = create<
  ChatOnboardingSession & {
    reset: (userId: string | null) => void;
    patch: (next: Partial<ChatOnboardingSession>) => void;
    markShown: (turnId: string, timeLabel: string, shownAtMs?: number) => void;
  }
>((set) => ({
  ...EMPTY_SESSION,
  reset: (userId) =>
    set({ ...EMPTY_SESSION, shownTurns: new Map(), shownTurnTimes: new Map(), userId }),
  patch: (next) => set(next),
  markShown: (turnId, timeLabel, shownAtMs) =>
    set((state) =>
      state.shownTurns.has(turnId)
        ? state
        : {
            shownTurns: new Map([...state.shownTurns, [turnId, timeLabel]]),
            shownTurnTimes:
              typeof shownAtMs === "number"
                ? new Map([...state.shownTurnTimes, [turnId, shownAtMs]])
                : state.shownTurnTimes,
          },
    ),
}));

/** What the event runner needs from the mounted workspace. */
export type ChatOnboardingHost = {
  anchor: () => string | null;
  vault: () => { vaultKey: string | null; vaultOwnerToken: string | null };
  focusComposer: () => void;
};

function persistDurable(durable: OneChatOnboardingState): void {
  const owner = useChatOnboardingSession.getState().userId;
  if (!owner) return;
  useChatOnboardingSession.getState().patch({ durable });
  // Best effort: a failed write leaves this session correct, and the next
  // change re-sends the full record (replace, not append).
  void PreVaultUserStateService.syncOneChatOnboarding(owner, durable).catch(() => undefined);
}

/**
 * Apply one event to the session machine and run its effects. Returns the
 * reducer's `consumed` flag (typed answers only).
 */
export function runChatOnboardingEvent(
  event: ChatOnboardingEvent,
  host: ChatOnboardingHost,
): boolean | undefined {
  const store = useChatOnboardingSession.getState();
  const result = reduceChatOnboarding(store.machine, event);
  store.patch({ machine: result.state });
  for (const effect of result.effects) {
    if (effect.type === "persist_progress") {
      const current = useChatOnboardingSession.getState().durable;
      persistDurable({
        ...progressToWire(effect.progress),
        // The tip dismissal is owned by the tip, not by the machine.
        tipDismissedOn: current?.tipDismissedOn ?? effect.progress.tipDismissedOn,
      });
    } else if (effect.type === "focus_composer") {
      host.focusComposer();
    } else if (effect.type === "save_preferences") {
      const owner = store.userId;
      const { vaultKey, vaultOwnerToken } = host.vault();
      const save = owner
        ? saveChatOnboardingPreferences({
            userId: owner,
            vaultKey,
            vaultOwnerToken,
            name: effect.name,
            tone: effect.tone,
          }).catch(() => false)
        : Promise.resolve(false);
      void save.then((ok) => {
        // Ignore a result that lands after the signed-in person changed.
        if (useChatOnboardingSession.getState().userId !== owner) return;
        runChatOnboardingEvent(
          { type: "save_result", ok, anchor: host.anchor(), today: localCalendarDate() },
          host,
        );
      });
    }
  }
  return result.consumed;
}

export type ChatOnboardingController = {
  /** Onboarding turns to render (empty when there is nothing to show). */
  turns: readonly ChatOnboardingTurn[];
  /** The one assistant turn whose chips are live, if any. */
  activeChipTurnId: string | null;
  shownTurns: ReadonlyMap<string, string>;
  shownTurnTimes: ReadonlyMap<string, number>;
  markShown: (turnId: string, timeLabel: string, shownAtMs?: number) => void;
  /** True while a save to memory is in flight: chips are inert. */
  busy: boolean;
  onChip: (chipId: ChatOnboardingChipId) => void;
  /**
   * Called with composer text before it is sent. Returns true only when the
   * person had explicitly chosen to type their name and the text is
   * name-shaped; the workspace then does not send it to One.
   */
  captureComposerText: (text: string) => boolean;
  composerPlaceholder: string | null;
  /** Tip-of-the-day starter for the first few days after onboarding. */
  dailyTip: string | null;
  dismissDailyTip: () => void;
};

export function useChatOnboarding(input: {
  userId: string | undefined;
  displayName: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  isVaultUnlocked: boolean;
  /** The one-time post-setup signal: only a new person starts onboarding. */
  startSignal: boolean;
  messages: readonly { id: string }[];
  conversationId: string | null;
  onFocusComposer: () => void;
  /** Starters already on screen, so the tip teaches something new. */
  visiblePrompts: readonly string[];
}): ChatOnboardingController {
  const session = useChatOnboardingSession();
  const userId = input.userId ?? null;
  const firstName = signInFirstName(input.displayName);

  const latest = useRef(input);
  // Declared before every other effect, so each one reads this render's input.
  useEffect(() => {
    latest.current = input;
  });
  const anchor = useCallback(() => {
    const list = latest.current.messages.filter((message) => message.id !== "agent-greeting");
    return list.at(-1)?.id ?? null;
  }, []);

  // A different signed-in person never inherits another's onboarding.
  useEffect(() => {
    if (useChatOnboardingSession.getState().userId !== userId) {
      useChatOnboardingSession.getState().reset(userId);
    }
  }, [userId]);

  const host = useMemo<ChatOnboardingHost>(
    () => ({
      anchor,
      vault: () => ({
        vaultKey: latest.current.vaultKey,
        vaultOwnerToken: latest.current.vaultOwnerToken,
      }),
      focusComposer: () => latest.current.onFocusComposer(),
    }),
    [anchor],
  );
  const dispatch = useCallback(
    (event: ChatOnboardingEvent) => runChatOnboardingEvent(event, host),
    [host],
  );

  // Read the durable record once per person.
  useEffect(() => {
    if (!userId || session.userId !== userId || session.durable !== undefined) return;
    let active = true;
    void PreVaultUserStateService.bootstrapState(userId)
      .then((state) => {
        if (active && useChatOnboardingSession.getState().userId === userId) {
          useChatOnboardingSession.getState().patch({ durable: state.oneChatOnboarding });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [userId, session.userId, session.durable]);

  // Start (new person, right after setup) or resume (unfinished, any device).
  const ready = Boolean(userId && input.isVaultUnlocked && session.userId === userId);
  useEffect(() => {
    if (!ready || session.machine || session.durable === undefined) return;
    if (session.durable === null) {
      if (!input.startSignal) return;
      dispatch({
        type: "start",
        displayName: input.displayName,
        firstName,
        anchor: anchor(),
      });
      return;
    }
    if (session.durable.status !== "in_progress") return;
    dispatch({
      type: "resume",
      progress: progressFromWire(session.durable),
      firstName,
      anchor: anchor(),
      today: localCalendarDate(),
    });
  }, [ready, session.machine, session.durable, input.startSignal, input.displayName, firstName, anchor, dispatch]);

  // Remember which conversation the onboarding lives in, once it has an id.
  const hasTurns = Boolean(session.machine?.turns.length);
  useEffect(() => {
    if (hasTurns && !session.homeConversationId && input.conversationId) {
      useChatOnboardingSession.getState().patch({ homeConversationId: input.conversationId });
    }
  }, [hasTurns, session.homeConversationId, input.conversationId]);

  const onChip = useCallback(
    (chipId: ChatOnboardingChipId) => {
      dispatch({ type: "chip", chipId, anchor: anchor(), today: localCalendarDate(), firstName });
    },
    [anchor, dispatch, firstName],
  );

  const captureComposerText = useCallback(
    (text: string) => {
      if (!isAwaitingTypedName(useChatOnboardingSession.getState().machine)) return false;
      return dispatch({ type: "typed_answer", text, anchor: anchor() }) === true;
    },
    [anchor, dispatch],
  );

  const today = localCalendarDate();
  const dailyTip = useMemo(
    () => (ready && !session.machine?.turns.length
      ? pickDailyTip(session.durable ?? null, today, input.visiblePrompts)
      : null),
    [ready, session.machine, session.durable, today, input.visiblePrompts],
  );

  const dismissDailyTip = useCallback(() => {
    const current = useChatOnboardingSession.getState().durable;
    if (!current) return;
    persistDurable({ ...current, tipDismissedOn: localCalendarDate() });
  }, []);

  const finishedElsewhere =
    session.machine?.step === "done" &&
    session.homeConversationId !== null &&
    input.conversationId !== session.homeConversationId;
  const visible = ready && !finishedElsewhere ? session.machine : null;
  return {
    turns: visible?.turns ?? [],
    activeChipTurnId: activeChipTurnId(visible),
    shownTurns: session.shownTurns,
    shownTurnTimes: session.shownTurnTimes,
    markShown: session.markShown,
    busy: visible?.step === "saving",
    onChip,
    captureComposerText,
    composerPlaceholder: isAwaitingTypedName(visible) ? "Type what I should call you" : null,
    dailyTip,
    dismissDailyTip,
  };
}
