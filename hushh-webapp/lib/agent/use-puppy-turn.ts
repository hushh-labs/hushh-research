"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/lib/firebase";
import { useVault } from "@/lib/vault/vault-context";
import { refreshPuppyLink } from "@/lib/services/puppy-one-service";
import {
  ApiService,
  PUPPY_INFERENCE_DEADLINE_MS,
  PUPPY_TURN_DEADLINE_MS,
} from "@/lib/services/api-service";
import {
  puppyFailureIsRetryable,
  puppyFailureMessage,
  type PuppyTurnPhase,
  type PuppyTurnStage,
} from "@/lib/agent/puppy-turn-copy";
import { whileNotAborted } from "@/lib/agent/puppy-abort";

export type PuppyChatTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Reasoning the local model streamed, when the device forwarded any. */
  thinking?: string;
  /** How long it reasoned before the answer began; null while still reasoning. */
  thoughtMs?: number | null;
  /** The model this turn's response reported, never a guess from a heartbeat. */
  model?: string;
  /** On a user turn whose answer failed: what to say and whether to offer a retry. */
  failure?: { message: string; retryable: boolean };
  /** On an assistant turn: the id of the question it answers. */
  replyTo?: string;
};

export type PuppyChatModel = { model: string; catalogVersion: string } | null;

type TurnTarget = { hushhId: string; deviceId: string };

let turnSerial = 0;
const nextTurnIds = () => {
  turnSerial += 1;
  const stamp = `${Date.now()}-${turnSerial}`;
  return { user: `u-${stamp}`, assistant: `a-${stamp}` };
};

/**
 * What the model sees as earlier conversation: only complete exchanges. A
 * question that failed or was stopped leaves together with any partial answer
 * it got, so the model never reads an answer without its question, or two
 * answers in a row.
 */
export function puppyModelHistory(turns: readonly PuppyChatTurn[]): Array<{ role: "user" | "assistant"; content: string }> {
  const replies = new Map(turns.filter((turn) => turn.role === "assistant" && turn.replyTo).map((turn) => [turn.replyTo, turn]));
  return turns.flatMap((turn) => {
    if (turn.role !== "user" || turn.failure) return [];
    const reply = replies.get(turn.id);
    if (!reply?.text) return [];
    return [{ role: "user" as const, content: turn.text }, { role: "assistant" as const, content: reply.text }];
  });
}

/** The transcript without one question and its answer, wherever they sit. */
function withoutExchange(turns: readonly PuppyChatTurn[], questionId: string): PuppyChatTurn[] {
  return turns.filter((turn) => turn.id !== questionId && turn.replyTo !== questionId);
}

/**
 * Select the target from fresh owner-scoped reads at send time. The sidebar
 * poll may still be loading, or may belong to an earlier signed-in owner.
 */
async function confirmPuppyTarget(signal: AbortSignal, onConnecting: () => void): Promise<TurnTarget> {
  const status = await ApiService.getPersonalAgentStatus({ signal });
  signal.throwIfAborted();
  if (status.hostingMode !== "byoc") throw new Error("PUPPY_REQUIRES_BYOC_POD");
  if (status.state !== "active" || !status.hushhId) throw new Error("PRIVATE_AGENT_UNAVAILABLE");
  onConnecting();
  window.performance.mark("puppy.turn.hosting-confirmed");
  const link = await refreshPuppyLink();
  signal.throwIfAborted();
  if (!link.device?.id || (link.state !== "live" && link.state !== "quiet")) throw new Error("PUPPY_OFFLINE");
  window.performance.mark("puppy.turn.device-confirmed");
  return { hushhId: status.hushhId, deviceId: link.device.id };
}

function classifyFailure(cause: unknown, signal: AbortSignal, phase: PuppyTurnPhase) {
  const cancelled =
    (cause instanceof DOMException || cause instanceof Error) && cause.name === "AbortError";
  const timedOut =
    (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") ||
    (cause instanceof Error && cause.name === "TimeoutError");
  const reason = cause instanceof Error ? cause.message : "PRIVATE_AGENT_UNAVAILABLE";
  return { reason, timedOut, cancelled, phase };
}

/** Batch streamed text and thinking into one paint per animation frame. */
function createPainter(assistantId: string, setTurns: (update: (prior: PuppyChatTurn[]) => PuppyChatTurn[]) => void) {
  const live = { text: "", thinking: "", thoughtMs: undefined as number | null | undefined };
  let frame: number | null = null;
  const paint = () => {
    frame = null;
    setTurns((prior) => prior.map((turn) => turn.id === assistantId
      ? { ...turn, text: live.text, thinking: live.thinking || undefined, thoughtMs: live.thoughtMs }
      : turn));
  };
  return {
    live,
    schedule: () => { if (frame === null) frame = window.requestAnimationFrame(paint); },
    flush: () => { if (frame !== null) window.cancelAnimationFrame(frame); paint(); },
  };
}

type TurnUpdate = (update: (prior: PuppyChatTurn[]) => PuppyChatTurn[]) => void;

/** The stream callbacks for one turn: phase changes, deadline re-arm, painting. */
function streamCallbacks(input: {
  signal: AbortSignal;
  painter: ReturnType<typeof createPainter>;
  enterStage: (stage: PuppyTurnStage) => void;
  onDispatched: () => void;
}) {
  const { signal, painter, enterStage } = input;
  let thinkingStartedAt = 0;
  return {
    onDispatch: () => {
      signal.throwIfAborted();
      input.onDispatched();
      enterStage("reading");
      window.performance.mark("puppy.turn.dispatched");
    },
    onThinking: (text: string) => {
      if (signal.aborted || painter.live.text) return;
      if (!painter.live.thinking) {
        thinkingStartedAt = Date.now();
        painter.live.thoughtMs = null;
        enterStage("thinking");
        window.performance.mark("puppy.turn.first-thinking");
      }
      painter.live.thinking += text;
      painter.schedule();
    },
    onToken: (text: string) => {
      if (signal.aborted) return;
      if (!painter.live.text) {
        if (thinkingStartedAt) painter.live.thoughtMs = Date.now() - thinkingStartedAt;
        enterStage("answering");
        window.performance.mark("puppy.turn.first-token");
      }
      painter.live.text += text;
      painter.schedule();
    },
  };
}

/** Attach the failure to the question and drop an answer that never started. */
function recordFailure(update: TurnUpdate, ids: { user: string; assistant: string }, failure: PuppyChatTurn["failure"], kept: boolean) {
  update((prior) => prior
    .filter((turn) => turn.id !== ids.assistant || kept)
    .map((turn) => turn.id === ids.user ? { ...turn, failure } : turn));
}

/** Everything one turn needs once its question is on screen. */
type TurnRun = {
  controller: AbortController;
  ids: { user: string; assistant: string };
  message: string;
  history: ReturnType<typeof puppyModelHistory>;
  conversationId: string;
  chatModel: PuppyChatModel;
  vaultOwnerToken: string;
  painter: ReturnType<typeof createPainter>;
  enterStage: (stage: PuppyTurnStage) => void;
  update: TurnUpdate;
  /** How far the turn got, so a failure names the side that failed. */
  progress: { phase: PuppyTurnPhase };
  /** The request reached the Mac: swap the preparation deadline for the inference one. */
  onDispatched: () => void;
};

/** Confirm the target, stream the answer, and name the model only when the response reports it. */
async function runPuppyTurn(run: TurnRun): Promise<void> {
  const { controller, painter } = run;
  const target = await whileNotAborted(
    confirmPuppyTarget(controller.signal, () => run.enterStage("connecting")), controller.signal,
  );
  run.progress.phase = "waking";
  const response = await ApiService.streamPuppyPodTurn({
    hushhId: target.hushhId,
    vaultOwnerToken: run.vaultOwnerToken,
    message: run.message,
    conversationId: run.conversationId,
    history: run.history,
    puppyDeviceId: target.deviceId,
    puppyModel: run.chatModel?.model,
    puppyCatalogVersion: run.chatModel?.catalogVersion,
    signal: controller.signal,
    ...streamCallbacks({
      signal: controller.signal, painter, enterStage: run.enterStage,
      onDispatched: () => { run.progress.phase = "dispatched"; run.onDispatched(); },
    }),
  });
  painter.flush();
  if (!painter.live.text) throw new Error("PUPPY_EMPTY_RESPONSE");
  // A heartbeat model is a prior observation, not proof of which model
  // answered this turn. Name a model only when this response reports it.
  if (response.modelReported)
    run.update((turns) => turns.map((turn) => turn.id === run.ids.assistant ? { ...turn, model: response.model } : turn));
  window.performance.mark("puppy.turn.complete");
}

/** The live phase and how long it has lasted, counted only while a turn runs. */
function useTurnStage(busy: boolean) {
  const [stage, setStage] = useState<PuppyTurnStage>("checking");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const enterStage = useCallback((next: PuppyTurnStage) => {
    setStage(next);
    setElapsedSeconds(0);
  }, []);
  return { stage, setStage, elapsedSeconds, enterStage };
}

/**
 * One Puppy conversation's turns and live phase. The pod path is fixed:
 * app -> owner pod -> Puppy relay -> the model on the owner's machine. One
 * keeps orchestration, consent and tools; this hook keeps a memory-only
 * transcript and never substitutes another inference target.
 */
export function usePuppyTurn({
  conversationId,
  chatModel,
  machine,
}: {
  conversationId: string;
  chatModel: PuppyChatModel;
  machine: string;
}) {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [turns, setTurns] = useState<PuppyChatTurn[]>([]);
  const turnsRef = useRef<PuppyChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const { stage, setStage, elapsedSeconds, enterStage } = useTurnStage(busy);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);
  // One synchronous source of truth, so a send reads the transcript it extends.
  const update = useCallback<TurnUpdate>((change) => {
    turnsRef.current = change(turnsRef.current);
    setTurns(turnsRef.current);
  }, []);

  const send = useCallback(async (raw: string, retryOf?: string) => {
    const message = raw.trim();
    if (!message || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    enterStage("checking");
    window.performance.mark("puppy.turn.start");
    const abortAtDeadline = () => controller.abort(new DOMException("Puppy did not answer in time", "TimeoutError"));
    let deadline = window.setTimeout(abortAtDeadline, PUPPY_TURN_DEADLINE_MS);
    const progress: TurnRun["progress"] = { phase: "checking" };
    const ids = nextTurnIds();
    // A retry takes out only its own failed question and any partial answer,
    // then asks again at the end; no other exchange is touched.
    const prior = retryOf ? withoutExchange(turnsRef.current, retryOf) : turnsRef.current;
    update(() => [...prior, { id: ids.user, role: "user", text: message }, { id: ids.assistant, role: "assistant", text: "", replyTo: ids.user }]);
    const painter = createPainter(ids.assistant, update);
    try {
      if (!user?.uid || !vaultOwnerToken) throw new Error("PRIVATE_AGENT_UNLOCK_REQUIRED");
      await runPuppyTurn({
        controller, ids, message, history: puppyModelHistory(prior), conversationId, chatModel,
        vaultOwnerToken, painter, enterStage, update, progress,
        onDispatched: () => {
          window.clearTimeout(deadline);
          deadline = window.setTimeout(abortAtDeadline, PUPPY_INFERENCE_DEADLINE_MS);
        },
      });
    } catch (cause) {
      const { reason, ...outcome } = classifyFailure(cause, controller.signal, progress.phase);
      window.performance.mark("puppy.turn.failed");
      painter.flush();
      recordFailure(update, ids, {
        message: puppyFailureMessage(reason, outcome, machine),
        retryable: puppyFailureIsRetryable(reason, outcome.cancelled),
      }, Boolean(painter.live.text));
    } finally {
      window.clearTimeout(deadline);
      if (requestRef.current === controller) requestRef.current = null;
      setBusy(false);
    }
  }, [chatModel, conversationId, enterStage, machine, update, user?.uid, vaultOwnerToken]);

  const stop = useCallback(() => {
    if (!requestRef.current) return;
    setStage("stopping");
    requestRef.current.abort();
  }, [setStage]);

  return { turns, busy, stage, elapsedSeconds, send, stop };
}
