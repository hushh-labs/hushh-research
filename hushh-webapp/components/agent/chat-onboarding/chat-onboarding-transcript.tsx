"use client";

/**
 * One's onboarding conversation, rendered as ordinary chat.
 *
 * Every turn goes through the SAME assistant/user bubble the workspace uses
 * for real replies (`renderBubble` is the workspace's `AgentBubble`), so the
 * typed-out animation, markdown and spacing are the real ones, not a card that
 * imitates them. Turns are local and ephemeral: they are never added to the
 * conversation sent to the model, and they carry no rate/report controls
 * because no model produced them.
 *
 * Typing reuses `useAnimatedAssistantText` inside the bubble: a turn mounts as
 * `streaming` (text types out from empty) and flips to `done` on the next
 * frame, which the hook finishes typing. Reduced motion mounts it `done`, so
 * the text appears at once.
 */
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CheckCircle2, ChevronRight, X } from "@/components/icons";

import { ConnectorBrandMark } from "@/components/agent/connector-brand-mark";
import type { ChatOnboardingController } from "@/lib/agent/chat-onboarding/use-chat-onboarding";
import type { ChatOnboardingTurn } from "@/lib/agent/chat-onboarding/chat-onboarding-machine";
import type {
  ChatOnboardingChip,
  ChatOnboardingChipId,
  ChatOnboardingConnectAction,
} from "@/lib/agent/chat-onboarding/chat-onboarding-script";
import { cn } from "@/lib/utils";

/** Structurally a subset of the workspace's `AgentMessage`. */
export type ChatOnboardingBubbleMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  timestamp: string;
  /** When the turn was first shown (epoch ms), for the centered time separators. */
  sentAtMs?: number;
  status: "streaming" | "done";
  ephemeral: true;
  renderAsPlainAssistantMessage: true;
};

/**
 * Where onboarding turns sit among real messages. A turn is anchored to the
 * last real message when it was created, so it renders right after that one:
 * before the NEXT message, or at the end when its anchor is the last message.
 * A turn whose anchor is not on screen (another conversation) also goes last.
 */
export type ChatOnboardingSlot =
  | { kind: "top" }
  | { kind: "before"; messageId: string; visibleMessageIds: readonly string[] }
  | { kind: "end"; visibleMessageIds: readonly string[] };

export function turnsForSlot(
  turns: readonly ChatOnboardingTurn[],
  slot: ChatOnboardingSlot,
): ChatOnboardingTurn[] {
  if (slot.kind === "top") return turns.filter((turn) => turn.anchor === null);
  const ids = slot.visibleMessageIds;
  if (slot.kind === "before") {
    const previous = ids[ids.indexOf(slot.messageId) - 1];
    return previous === undefined ? [] : turns.filter((turn) => turn.anchor === previous);
  }
  const last = ids.at(-1);
  return turns.filter(
    (turn) => turn.anchor !== null && (turn.anchor === last || !ids.includes(turn.anchor)),
  );
}

/** Mirrors the bubble hook's base rate (620 chars/s) for pacing chips and turns. */
export function estimateTypingMs(text: string): number {
  return Math.min(1600, Math.round((text.length / 620) * 1000));
}

/** Consecutive new assistant turns type one after another, not over each other. */
export function turnRevealDelays(
  turns: readonly ChatOnboardingTurn[],
  shown: ReadonlyMap<string, string>,
  reducedMotion: boolean,
): number[] {
  const delays: number[] = [];
  let elapsed = 0;
  for (const turn of turns) {
    const typed = !reducedMotion && turn.role === "assistant" && !shown.has(turn.id);
    delays.push(typed ? elapsed : 0);
    if (typed) elapsed += estimateTypingMs(turn.text) + 120;
  }
  return delays;
}

function formatTimeLabel(): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(),
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const CHIP_CLASS =
  "inline-flex min-h-11 max-w-full items-center rounded-2xl border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] px-4 py-2.5 text-left text-sm font-medium leading-5 text-foreground shadow-[var(--app-glass-shadow)] transition-colors duration-150 hover:bg-[color:var(--app-shell-surface-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60 active:opacity-90 disabled:pointer-events-none disabled:opacity-60";
const QUIET_CHIP_CLASS =
  "inline-flex min-h-11 items-center rounded-2xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60 disabled:pointer-events-none disabled:opacity-60";

export function ChatOnboardingChips({
  chips,
  label,
  disabled,
  autoFocus,
  onChip,
}: {
  chips: readonly ChatOnboardingChip[];
  label: string;
  disabled: boolean;
  autoFocus: boolean;
  onChip: (chipId: ChatOnboardingChipId) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    // Only recover focus the previous chip group dropped when it unmounted;
    // never pull focus out of the composer or anywhere else.
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (autoFocus && (!active || active === document.body)) refs.current[0]?.focus();
  }, [autoFocus]);

  // Arrow keys move between chips; Tab still leaves the group as usual.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = refs.current.findIndex((node) => node === document.activeElement);
    if (index < 0) return;
    const last = chips.length - 1;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? Math.min(last, index + 1)
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
  };

  return (
    <div
      role="group"
      aria-label={label}
      data-testid="chat-onboarding-chips"
      onKeyDown={onKeyDown}
      className="mt-2 flex flex-wrap gap-2 px-1"
    >
      {chips.map((chip, index) => (
        <button
          key={chip.id}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          disabled={disabled}
          data-chip-id={chip.id}
          onClick={() => onChip(chip.id)}
          className={chip.id === "skip" || chip.id === "dont_save" ? QUIET_CHIP_CLASS : CHIP_CLASS}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

function ConnectActionButton({
  action,
  onConnect,
  gmailConnected,
}: {
  action: ChatOnboardingConnectAction;
  onConnect: (action: ChatOnboardingConnectAction, trigger: HTMLButtonElement) => void;
  gmailConnected: boolean;
}) {
  const brand = action.kind === "connector" ? action.provider : null;
  if (brand === "gmail" && gmailConnected) {
    return <div role="status" className="mt-1 flex min-h-11 items-center gap-2.5 px-1 text-sm text-muted-foreground">
      <ConnectorBrandMark brand="gmail" size="sm" className="size-4" />
      <span>Gmail connected</span>
      <CheckCircle2 className="size-4 text-[color:var(--app-accent-deep)]" aria-hidden="true" />
    </div>;
  }
  return (
    <div className="mt-1 px-1">
      <button
        type="button"
        data-testid="chat-onboarding-connect"
        data-connect-kind={action.kind}
        data-connect-target={action.kind === "connector" ? action.provider : action.href}
        onClick={(event) => onConnect(action, event.currentTarget)}
        className={cn(CHIP_CLASS, "gap-2.5 pr-3")}
      >
        {brand ? <ConnectorBrandMark brand={brand} size="sm" className="size-4" /> : null}
        <span>{action.label}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--app-accent-deep)]" aria-hidden="true" />
      </button>
    </div>
  );
}

function OnboardingTurnView({
  turn,
  animate,
  delayMs,
  timestamp,
  shownAtMs,
  chipsLive,
  busy,
  autoFocusChips,
  renderBubble,
  onShown,
  onChip,
  onConnect,
  gmailConnected,
}: {
  turn: ChatOnboardingTurn;
  animate: boolean;
  delayMs: number;
  timestamp: string | undefined;
  shownAtMs: number | undefined;
  chipsLive: boolean;
  busy: boolean;
  autoFocusChips: boolean;
  renderBubble: (message: ChatOnboardingBubbleMessage) => ReactNode;
  onShown: (turnId: string, timeLabel: string, shownAtMs?: number) => void;
  onChip: (chipId: ChatOnboardingChipId) => void;
  onConnect: (action: ChatOnboardingConnectAction, trigger: HTMLButtonElement) => void;
  gmailConnected: boolean;
}) {
  const typed = animate && turn.role === "assistant";
  const [phase, setPhase] = useState<"waiting" | "streaming" | "done">(
    typed ? (delayMs > 0 ? "waiting" : "streaming") : "done",
  );
  const [extrasReady, setExtrasReady] = useState(!typed);
  const [shownAt] = useState(() => timestamp ?? formatTimeLabel());
  // A turn restamped on remount keeps its first time; a first showing is now.
  const [firstShownAtMs] = useState(() => shownAtMs ?? (timestamp ? undefined : Date.now()));

  useEffect(() => {
    if (phase === "waiting") {
      const timer = window.setTimeout(() => setPhase("streaming"), delayMs);
      return () => window.clearTimeout(timer);
    }
    if (phase === "streaming") {
      // The bubble's hook keeps typing after `done`; this only ends the
      // live-region/streaming posture once the first frame has painted.
      const frame = window.requestAnimationFrame(() => setPhase("done"));
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [phase, delayMs]);

  useEffect(() => {
    if (phase === "waiting") return;
    onShown(turn.id, shownAt, firstShownAtMs);
    if (extrasReady) return;
    const timer = window.setTimeout(() => setExtrasReady(true), estimateTypingMs(turn.text));
    return () => window.clearTimeout(timer);
  }, [phase, extrasReady, onShown, turn.id, turn.text, shownAt, firstShownAtMs]);

  if (phase === "waiting") return null;
  return (
    <div data-testid="chat-onboarding-turn" data-turn-role={turn.role}>
      {renderBubble({
        id: turn.id,
        role: turn.role,
        text: turn.text,
        timestamp: shownAt,
        sentAtMs: firstShownAtMs,
        status: phase === "streaming" ? "streaming" : "done",
        ephemeral: true,
        renderAsPlainAssistantMessage: true,
      })}
      {extrasReady && turn.action ? (
        <ConnectActionButton action={turn.action} onConnect={onConnect} gmailConnected={gmailConnected} />
      ) : null}
      {extrasReady && chipsLive && turn.chips?.length ? (
        <ChatOnboardingChips
          chips={turn.chips}
          label="Reply options"
          disabled={busy}
          autoFocus={autoFocusChips}
          onChip={onChip}
        />
      ) : null}
    </div>
  );
}

export function ChatOnboardingTurns({
  controller,
  slot,
  renderBubble,
  onConnect,
  gmailConnected = false,
}: {
  controller: ChatOnboardingController;
  slot: ChatOnboardingSlot;
  renderBubble: (message: ChatOnboardingBubbleMessage) => ReactNode;
  onConnect: (action: ChatOnboardingConnectAction, trigger: HTMLButtonElement) => void;
  gmailConnected?: boolean;
}) {
  const turns = turnsForSlot(controller.turns, slot);
  // Keyboard continuity: after a chip is chosen, focus moves to the next set.
  const [chipChosen, setChipChosen] = useState(false);
  const [reducedMotion] = useState(prefersReducedMotion);
  if (!turns.length) return null;

  const delays = turnRevealDelays(turns, controller.shownTurns, reducedMotion);
  const views = turns.map((turn, index) => {
    const animate = !reducedMotion && !controller.shownTurns.has(turn.id);
    const delayMs = delays[index] ?? 0;
    const chipsLive = controller.activeChipTurnId === turn.id;
    return (
      <OnboardingTurnView
        key={turn.id}
        turn={turn}
        animate={animate}
        delayMs={delayMs}
        timestamp={controller.shownTurns.get(turn.id)}
        shownAtMs={controller.shownTurnTimes.get(turn.id)}
        chipsLive={chipsLive}
        busy={controller.busy}
        autoFocusChips={chipsLive && chipChosen}
        renderBubble={renderBubble}
        onShown={controller.markShown}
        onChip={(chipId) => {
          setChipChosen(true);
          controller.onChip(chipId);
        }}
        onConnect={onConnect}
        gmailConnected={gmailConnected}
      />
    );
  });
  return <Fragment>{views}</Fragment>;
}

/** A light, dismissible tip for the first few days. Tapping it fills the composer. */
export function ChatOnboardingDailyTip({
  tip,
  onUse,
  onDismiss,
}: {
  tip: string;
  onUse: (prompt: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="chat-onboarding-daily-tip"
      className="mx-auto flex w-full max-w-2xl items-center gap-1 px-1 text-sm text-muted-foreground"
    >
      <button
        type="button"
        onClick={() => onUse(tip)}
        className="min-h-11 min-w-0 flex-1 rounded-xl px-2 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
      >
        <span className="font-medium text-foreground">Tip of the day:</span>{" "}
        <span className={cn("break-words")}>try asking “{tip}”</span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss tip"
        className="grid size-11 shrink-0 place-items-center rounded-xl transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
