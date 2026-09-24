"use client";

/**
 * The docked conversation panel above the voice pill.
 *
 * Stacks, top to bottom: the transcript, confirmed entity cards, a candidate
 * picker, an open pending action card, the last tool result, and any error — the
 * most actionable thing nearest the thumb. Everything on it is derived from
 * typed frames in the session state; a "Done" here needs `tool.result ok:true`
 * or `pending_action.resolved executed`, never a transcript line.
 *
 * The app screen stays the result surface. The panel scrolls inside itself
 * (max-h min(52dvh, 420px)) and never covers the page with a backdrop.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";

import { morphyToast } from "@/lib/morphy-ux/morphy";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import {
  SOS_PUBLISH_PURPOSE,
  SOS_PUBLISH_STEP_KIND,
  type ToolResultPublic,
} from "@/lib/one-voice/protocol";
import { panelHasClearableHistory } from "@/lib/one-voice/session-reducer";
import type {
  ClientStepView,
  ToolTimelineItem,
  VoiceSessionController,
  VoiceSessionState,
} from "@/lib/one-voice/session-types";
import { cn } from "@/lib/utils";

import { CandidatePicker } from "./candidate-picker";
import { EntityCard } from "./entity-card";
import { PendingActionCard } from "./pending-action-card";
import { ToolResultCard } from "./tool-result-card";
import { VoiceErrorCard, isMicPermissionError } from "./voice-error-card";
import { VoiceTranscript } from "./voice-transcript";

export type OneVoicePanelProps = {
  state: VoiceSessionState;
  controller: VoiceSessionController;
  /** Native only: opens the OS microphone settings. */
  onOpenSettings?: () => void;
  onDismissError?: () => void;
  className?: string;
};

const MAX_LOOSE_ENTITIES = 3;
// A 44px-tall text control, matching the dock's touch-target floor.
const CLEAR_ACTION_BUTTON =
  "flex h-11 min-w-11 shrink-0 touch-manipulation items-center justify-center rounded-full px-3 text-[13px] font-medium leading-[18px] text-[color:var(--app-secondary-label)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]";
const PANEL_HEADER =
  "sticky top-0 z-10 flex min-h-12 items-center justify-between gap-2 bg-[color:var(--app-card-surface-default-solid)] px-4 sm:px-5";
const PANEL_CONTENT = "flex flex-col gap-3 px-4 pb-5 pt-2 sm:px-5";
const HANDOFF_STATUSES = new Set<string>([
  "confirmation_required",
  "tap_required",
  "card_not_shown",
  // The device step, not a card, owns the interval until the relay settles
  // the final tool.result for this device's Location switch.
  "location_updates_pending",
]);
const DISAMBIGUATION_STATUSES = new Set<string>([
  "multiple",
  "truncated",
  "single_likely",
  "low_confidence",
]);

/** Results whose UI is another card (the pending action, the picker) render nowhere else. */
export function isHandoffResult(
  result: ToolResultPublic,
  state: Pick<VoiceSessionState, "candidatePicker">,
): boolean {
  const status = String(result.status || "").trim();
  if (HANDOFF_STATUSES.has(status) || result.needs === "confirmation")
    return true;
  if (
    state.candidatePicker &&
    (result.needs === "disambiguation" || DISAMBIGUATION_STATUSES.has(status))
  )
    return true;
  return false;
}

function sameResult(
  a: ToolResultPublic | null,
  b: ToolResultPublic | null,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (String(a.status || "") !== String(b.status || "")) return false;
  const factsA = Array.isArray(a.spoken_facts) ? a.spoken_facts.join("\n") : "";
  const factsB = Array.isArray(b.spoken_facts) ? b.spoken_facts.join("\n") : "";
  return factsA === factsB;
}

function findTimelineItem(
  timeline: ToolTimelineItem[],
  result: ToolResultPublic,
): ToolTimelineItem | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item && item.result === result) return item;
  }
  return null;
}

export type PanelResultSlot = {
  result: ToolResultPublic;
  tool: string;
  ok: boolean | undefined;
} | null;

/** Which tool result the panel shows, if any (the resolved receipt wins over a duplicate frame). */
export function selectPanelResult(state: VoiceSessionState): PanelResultSlot {
  const pending = state.pendingAction;
  const resolved = pending && pending.resolvedStatus !== null ? pending : null;
  const last = state.lastResult;
  if (
    last &&
    !sameResult(resolved?.resolvedResult ?? null, last) &&
    !isHandoffResult(last, state)
  ) {
    const item = findTimelineItem(state.toolTimeline, last);
    return {
      result: last,
      tool: item?.tool ?? "",
      ok: item ? item.ok === true : undefined,
    };
  }
  if (resolved?.resolvedResult) {
    return {
      result: resolved.resolvedResult,
      tool: resolved.tool,
      ok: resolved.resolvedStatus === "executed",
    };
  }
  return null;
}

/**
 * The device is publishing a Save My Soul position for the relay: the
 * `publish_location_envelopes` step with purpose `sos` is still outstanding.
 * Shown from any route (the bridge that runs it is mounted app-wide), so a
 * person who confirmed the card on Home sees that the position is on its way.
 */
export function isSosPublishStep(step: ClientStepView | null): boolean {
  if (!step || step.kind !== SOS_PUBLISH_STEP_KIND) return false;
  const payload = step.payload;
  return payload.purpose === SOS_PUBLISH_PURPOSE || payload.sos === true;
}

/** True when there is anything worth opening the panel for. */
export function panelHasContent(state: VoiceSessionState): boolean {
  return (
    // A cleared view is still a view: keep the panel and its empty state so
    // the dock toggle remains available even after earlier messages vanish.
    state.historyCleared ||
    state.transcript.some((item) => item.text.trim().length > 0) ||
    state.entities.length > 0 ||
    state.candidatePicker !== null ||
    state.pendingAction?.resolvedStatus === null ||
    isSosPublishStep(state.clientStep) ||
    selectPanelResult(state) !== null ||
    state.error !== null
  );
}

export function OneVoicePanel({
  state,
  controller,
  onOpenSettings,
  onDismissError,
  className,
}: OneVoicePanelProps) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Local view state only. It never touches the pending-action contract: a
  // clear consumes no receipt and resolves no server decision.
  const [askingClear, setAskingClear] = useState(false);
  const clearButtonRef = useRef<HTMLButtonElement | null>(null);
  const clearConfirmRef = useRef<HTMLButtonElement | null>(null);
  const conversationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  // Focus must not be dropped on the document when the clear utility swaps for the
  // confirmation and back, or a keyboard or screen-reader user loses their
  // place mid-decision. Only moved in response to the person's own click.
  const [focusTarget, setFocusTarget] = useState<
    "none" | "confirm" | "clear" | "conversation"
  >("none");
  const picker = state.candidatePicker;
  const pending = state.pendingAction;
  // A confirmation is actionable only until its matching terminal receipt
  // resolves. Save My Soul is the exception: its resolved card carries the
  // device-delivery state while its location publish step is in flight.
  const openPending = pending?.resolvedStatus === null ? pending : null;
  const visiblePending =
    openPending ??
    (pending?.tool === "trigger_save_my_soul" ? pending : null);
  const resultSlot = selectPanelResult(state);
  const sosPublishing = isSosPublishStep(state.clientStep);
  const error = state.error;

  useEffect(() => {
    setPickedId(null);
  }, [picker]);

  const canClearHistory = panelHasClearableHistory(state);

  useEffect(() => {
    if (focusTarget === "confirm") clearConfirmRef.current?.focus();
    if (focusTarget === "clear") clearButtonRef.current?.focus();
    if (focusTarget === "conversation") conversationHeadingRef.current?.focus();
    if (focusTarget !== "none") setFocusTarget("none");
  }, [focusTarget]);

  const pendingEntityKeys = new Set(
    (openPending?.entities ?? []).map(
      (entity) => `${entity.kind}:${entity.user_id ?? entity.circle_id ?? ""}`,
    ),
  );
  const looseEntities =
    picker || !openPending
      ? state.entities
          .filter(
            (entity) =>
              !pendingEntityKeys.has(
                `${entity.kind}:${entity.user_id ?? entity.circle_id ?? ""}`,
              ),
          )
          .slice(0, MAX_LOOSE_ENTITIES)
      : [];
  // The empty conversation copy is useful only when there is no live card to
  // act on. A pending decision, progress, recovery error, or result remains
  // the panel's actual content after history has been cleared.
  const hasRenderedLiveContent =
    looseEntities.length > 0 ||
    picker !== null ||
    visiblePending !== null ||
    sosPublishing ||
    resultSlot !== null ||
    error !== null;

  const busy = confirming || state.phase === "executing";
  const confirm = async () => {
    setConfirming(true);
    try {
      await controller.confirmPending();
    } catch {
      // The provider reports the failure through the session state.
    } finally {
      setConfirming(false);
    }
  };
  // An informational error (the relay kept running) needs no retry; a stopped
  // session does.
  const canRetry =
    error !== null && (state.phase === "idle" || state.phase === "error");
  const retry = canRetry
    ? () => void controller.start({ source: "retry" })
    : undefined;

  return (
    <div
      role="region"
      aria-label="One conversation"
      data-testid="one-voice-panel"
      className={cn(
        "bottom-chrome-surface one-voice-panel-enter pointer-events-auto flex max-h-[min(52dvh,420px)] w-full flex-col overflow-y-auto overscroll-contain rounded-[24px]",
        className,
      )}
    >
      <div data-testid="one-voice-panel-header" className={PANEL_HEADER}>
        <h2
          ref={conversationHeadingRef}
          data-testid="one-voice-panel-title"
          tabIndex={-1}
          className="rounded-md text-sm font-semibold leading-5 text-[color:var(--app-label)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
        >
          Conversation
        </h2>
        {!askingClear && canClearHistory ? (
          <button
            type="button"
            data-testid="one-voice-clear-history"
            aria-label="Clear chat view"
            title="Clear chat view"
            ref={clearButtonRef}
            onClick={() => {
              setAskingClear(true);
              setFocusTarget("confirm");
            }}
            className={CLEAR_ACTION_BUTTON}
          >
            Clear view
          </button>
        ) : null}
      </div>

      <div data-testid="one-voice-panel-content" className={PANEL_CONTENT}>
        {askingClear ? (
          <div
            role="alertdialog"
            aria-label="Clear chat view?"
            data-testid="one-voice-clear-confirm"
            className="flex flex-col gap-2 rounded-[var(--app-card-radius-standard,24px)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] p-3"
          >
            <p className="text-[13px] font-semibold text-[color:var(--app-label)]">
              Clear chat view?
            </p>
            <p className="text-[12px] text-[color:var(--app-secondary-label)]">
              Removes earlier messages from this view. Voice stays active, and One
              can still use earlier conversation context.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="one-voice-clear-cancel"
                onClick={() => {
                  setAskingClear(false);
                  setFocusTarget("clear");
                }}
                className={CLEAR_ACTION_BUTTON}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="one-voice-clear-confirm-action"
                ref={clearConfirmRef}
                onClick={() => {
                  setAskingClear(false);
                  setFocusTarget("conversation");
                  controller.clearView();
                  morphyToast.success("Chat view cleared");
                }}
                className={CLEAR_ACTION_BUTTON}
              >
                Clear view
              </button>
            </div>
          </div>
        ) : (
          <>
            <VoiceTranscript
              items={state.transcript}
              showEmptyState={!hasRenderedLiveContent}
            />

            {looseEntities.length > 0 ? (
              <div
                className="flex flex-col gap-1.5"
                data-testid="one-voice-panel-entities"
              >
                {looseEntities.map((entity, index) => (
                  <EntityCard
                    key={`${entity.kind}:${entity.user_id ?? entity.circle_id ?? index}`}
                    card={entity}
                  />
                ))}
              </div>
            ) : null}

            {picker ? (
              <CandidatePicker
                picker={picker}
                selectedId={pickedId}
                onPick={(id) => {
                  setPickedId(id);
                  controller.chooseCandidate(id);
                }}
                onNone={() => {
                  setPickedId(null);
                  controller.chooseCandidate(null);
                }}
              />
            ) : null}

            {visiblePending ? (
              <PendingActionCard
                action={visiblePending}
                busy={busy}
                onConfirm={() => void confirm()}
                onCancel={() => controller.cancelPending()}
              />
            ) : null}

            {sosPublishing ? (
              <div
                data-testid="one-voice-sos-publishing"
                role="status"
                aria-live="polite"
                className={cn(
                  "flex min-h-11 items-center gap-2.5 rounded-[var(--app-card-radius-standard,24px)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-2.5",
                )}
              >
                <Loader2
                  className={cn(
                    "h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none",
                    roleClasses("action").glyph,
                  )}
                  aria-hidden
                />
                <span className="text-[13px] font-medium text-[color:var(--app-label)]">
                  Sending your position…
                </span>
              </div>
            ) : null}

            {resultSlot ? (
              <ToolResultCard
                result={resultSlot.result}
                tool={resultSlot.tool}
                ok={resultSlot.ok}
              />
            ) : null}

            {error ? (
              <VoiceErrorCard
                error={error}
                onRetry={retry}
                onOpenSettings={
                  isMicPermissionError(error.code) ? onOpenSettings : undefined
                }
                onDismiss={onDismissError}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
