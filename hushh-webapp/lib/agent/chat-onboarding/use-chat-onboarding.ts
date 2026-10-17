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
import { PREFERRED_NAME_MAX, sanitizeStyleText } from "@/lib/agent/owner-style-settings";
import { containsSecretSpan } from "@/lib/pkm/secret-patterns";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

import {
  activeChipTurnId,
  isAwaitingTypedName,
  reduceChatOnboarding,
  type ChatOnboardingEvent,
  type ChatOnboardingTurn,
} from "@/lib/agent/chat-onboarding/chat-onboarding-machine";
import { useChatOnboardingSession } from "@/lib/agent/chat-onboarding/chat-onboarding-session";
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

export { useChatOnboardingSession };

/** What the event runner needs from the mounted workspace. */
export type ChatOnboardingHost = {
  anchor: () => string | null;
  vault: () => { vaultKey: string | null; vaultOwnerToken: string | null };
  focusComposer: () => void;
  isCurrent?: () => boolean;
};

export type OnboardingNameTurn = {
  screenState: { onboarding_name_request: string };
  stage: (result: unknown, callId: string) => void;
  finish: (succeeded: boolean) => void;
};

/** Correlate One's assessment; this nonce carries no identity or authority. */
export function beginChatOnboardingNameTurn(host: ChatOnboardingHost): OnboardingNameTurn | null {
  const initial = useChatOnboardingSession.getState();
  const machine = initial.machine;
  const vault = host.vault();
  if (!initial.userId || machine?.step !== "name_typing" || !vault.vaultKey || !vault.vaultOwnerToken) return null;
  const epoch = snapshotVaultSessionEpoch();
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
  initial.patch({ nameRequestId: requestId });
  const isCurrent = () => {
    const current = useChatOnboardingSession.getState();
    const keys = host.vault();
    return current.userId === initial.userId && current.machine === machine &&
      current.nameRequestId === requestId && isVaultSessionEpochCurrent(epoch) &&
      keys.vaultKey === vault.vaultKey && keys.vaultOwnerToken === vault.vaultOwnerToken &&
      (host.isCurrent?.() ?? true);
  };
  let assessment: { decision: "name" | "skip" | "clarify" | "other"; name?: string } | null = null;
  let firstCallId: string | null = null;
  let firstResult: string | null = null;
  let invalid = false;
  let finished = false;
  return {
    screenState: { onboarding_name_request: requestId },
    stage: (raw, callId) => {
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { invalid = true; return; }
      }
      if (finished || !isCurrent() || !raw || typeof raw !== "object") return;
      const result = raw as Record<string, unknown>;
      if (result.status !== "onboarding_name_assessed") return;
      const fingerprint = JSON.stringify(raw);
      if (firstCallId === callId && firstResult === fingerprint) return; // Transport redelivery.
      if (firstCallId !== null) { invalid = true; return; }
      firstCallId = callId;
      firstResult = fingerprint;
      if (result.request_id !== requestId || !["name", "skip", "clarify", "other"].includes(String(result.decision))) {
        invalid = true; return;
      }
      const decision = result.decision as NonNullable<typeof assessment>["decision"];
      if (decision !== "name") {
        if (result.preferred_name !== undefined) { invalid = true; return; }
        assessment = { decision }; return;
      }
      const name = result.preferred_name;
      if (typeof name !== "string" || !name || name.length > PREFERRED_NAME_MAX ||
        sanitizeStyleText(name) !== name || containsSecretSpan(name)) {
        invalid = true; return;
      }
      assessment = { decision, name };
    },
    finish: (succeeded) => {
      if (finished) return;
      finished = true;
      const current = isCurrent();
      if (useChatOnboardingSession.getState().nameRequestId === requestId)
        useChatOnboardingSession.getState().patch({ nameRequestId: null });
      if (!succeeded || !current || invalid || !assessment) return;
      runChatOnboardingEvent({ type: "name_assessment", ...assessment, anchor: host.anchor(), today: localCalendarDate() }, host);
    },
  };
}

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
      const epoch = snapshotVaultSessionEpoch();
      const currentSave = () => {
        const current = useChatOnboardingSession.getState();
        const keys = host.vault();
        return current.userId === owner && current.machine === result.state &&
          isVaultSessionEpochCurrent(epoch) && keys.vaultKey === vaultKey &&
          keys.vaultOwnerToken === vaultOwnerToken && (host.isCurrent?.() ?? true);
      };
      const save = owner
        ? saveChatOnboardingPreferences({
            userId: owner,
            vaultKey,
            vaultOwnerToken,
            name: effect.name,
            tone: effect.tone,
            beforeEffect: async () => {
              if (!currentSave()) throw new DOMException("Session changed", "AbortError");
            },
          }).catch(() => false)
        : Promise.resolve(false);
      void save.then((ok) => {
        // Ignore a result that lands after the signed-in person changed.
        if (useChatOnboardingSession.getState().userId !== owner || useChatOnboardingSession.getState().machine !== result.state) return;
        runChatOnboardingEvent(
          { type: "save_result", ok: ok && currentSave(), anchor: host.anchor(), today: localCalendarDate() },
          host,
        );
      });
    }
  }
  return result.consumed;
}

export type ChatOnboardingController = {
  /** Owner progress is loaded and personality onboarding is finished or not due. */
  resolved: boolean;
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
   * Compatibility entrypoint: text is always assessed by One, never classified here.
   */
  captureComposerText: (text: string) => boolean;
  beginNameTurn?: (isCurrent: () => boolean) => OnboardingNameTurn | null;
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
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 5000;
    const load = () => {
      const current = useChatOnboardingSession.getState();
      if (!active || inFlight || current.userId !== userId || current.durable !== undefined) return;
      clearTimeout(retryTimer);
      inFlight = true;
      void PreVaultUserStateService.bootstrapState(userId)
        .then((state) => {
          if (active && useChatOnboardingSession.getState().userId === userId) {
            useChatOnboardingSession.getState().patch({ durable: state.oneChatOnboarding });
          }
        })
        .catch(() => {
          // Never treat a failed read as completed onboarding, but do not leave
          // discovery disabled forever after a transient bootstrap failure.
          if (active) {
            retryTimer = setTimeout(load, backoff);
            backoff = Math.min(backoff * 2, 30_000);
          }
        })
        .finally(() => { inFlight = false; });
    };
    const resume = () => { if (document.visibilityState === "visible") load(); };
    load();
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      clearTimeout(retryTimer);
      window.removeEventListener("online", load);
      document.removeEventListener("visibilitychange", resume);
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

  const captureComposerText = useCallback(() => false, []);
  const beginNameTurn = useCallback((isCurrent: () => boolean) =>
    beginChatOnboardingNameTurn({ ...host, isCurrent: () =>
      latest.current.userId === useChatOnboardingSession.getState().userId &&
      latest.current.isVaultUnlocked &&
      (!useChatOnboardingSession.getState().homeConversationId ||
        latest.current.conversationId === useChatOnboardingSession.getState().homeConversationId) && isCurrent() }), [host]);

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
    resolved: ready && session.durable !== undefined && (session.machine
      ? session.machine.step === "done"
      : session.durable?.status === "completed" || (session.durable === null && !input.startSignal)),
    turns: visible?.turns ?? [],
    activeChipTurnId: activeChipTurnId(visible),
    shownTurns: session.shownTurns,
    shownTurnTimes: session.shownTurnTimes,
    markShown: session.markShown,
    busy: visible?.step === "saving" || visible?.step === "saving_name",
    onChip,
    captureComposerText,
    beginNameTurn,
    composerPlaceholder: isAwaitingTypedName(visible) ? "Type what I should call you" : null,
    dailyTip,
    dismissDailyTip,
  };
}
