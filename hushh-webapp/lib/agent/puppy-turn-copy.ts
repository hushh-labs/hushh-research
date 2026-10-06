/**
 * Friendly words for a Puppy One turn, kept apart from the panel so every
 * phase and every refusal is one tested table rather than a ternary chain.
 *
 * Phases follow what the turn is actually doing, in order:
 *   checking    the app confirms your private agent and your Mac are yours
 *   connecting  your agent and your Mac are woken (a cold agent takes ~30 s)
 *   reading     the request is on your Mac; the local model reads the prompt
 *   thinking    the local model is writing its reasoning (only when it sends one)
 *   answering   answer tokens are arriving
 *
 * A failure names the side that actually failed: your private agent, your
 * Mac (or its model), or the connection between them. A code we cannot place
 * gets a neutral sentence, never a guess that blames the Mac.
 */
import { ownerPodTurnErrorMessage } from "@/lib/agent/owner-pod-turn-errors";

export type PuppyTurnStage =
  | "checking"
  | "connecting"
  | "reading"
  | "thinking"
  | "answering"
  | "stopping";

/** How far a failed turn got: still checking, waking the agent and Mac, or on the Mac. */
export type PuppyTurnPhase = "checking" | "waking" | "dispatched";

const MAC_NAME = /\b(?:mac|macbook|imac)\b/i;

/** "your Mac" when the linked device says it is one, else "your computer". */
export function puppyMachineNoun(deviceName: string | null | undefined): string {
  return MAC_NAME.test(deviceName ?? "") ? "your Mac" : "your computer";
}

const capitalized = (phrase: string) => phrase.charAt(0).toUpperCase() + phrase.slice(1);

/** The status line for a turn that has no answer text yet. */
export function puppyStageLabel(
  stage: PuppyTurnStage,
  elapsedSeconds: number,
  machine = "your computer",
): string {
  switch (stage) {
    case "checking":
      return "Getting ready…";
    case "connecting":
      if (elapsedSeconds < 3) return "Connecting…";
      if (elapsedSeconds < 20) return `Waking your agent and ${machine}…`;
      return "Still waking up. The first message after a break takes longer.";
    case "reading":
      if (elapsedSeconds < 45) return "Reading your message…";
      return `Still reading. Long chats take ${machine} a little longer.`;
    case "thinking":
      return "Thinking…";
    case "answering":
      return "Answering…";
    case "stopping":
      return "Stopping…";
  }
}

/** Whether the status line shows a running seconds counter beside its label. */
export function puppyStageShowsElapsed(stage: PuppyTurnStage): boolean {
  return stage === "connecting" || stage === "reading";
}

/** "Thought for 8s" once the answer starts; "Thought for a moment" under a second. */
export function puppyThoughtLabel(milliseconds: number | null): string {
  if (milliseconds === null) return "Thinking…";
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 1 ? "Thought for a moment" : `Thought for ${seconds}s`;
}

/** Refusals from your Mac or the model on it. */
function machineRefusals(machine: string): Record<string, string> {
  const Machine = capitalized(machine);
  const busy = `${Machine} is still on another answer. Try again in a moment.`;
  const stale = `The models on ${machine} changed. Pick a model again, then resend.`;
  const missing = `That model isn't on ${machine} anymore. Pick another one.`;
  const slow = timeoutMessage("dispatched", machine);
  return {
    PUPPY_CANCEL_UNCONFIRMED: `Couldn't confirm the stop. ${Machine} may still be finishing this one.`,
    PUPPY_OFFLINE: `${Machine} isn't reachable. Open Puppy on it and try again.`,
    PUPPY_BUSY: busy,
    LOCAL_MODEL_OVERLOADED: busy,
    PUPPY_CATALOG_STALE: stale,
    STALE_MODEL_CATALOG: stale,
    PUPPY_MODEL_UNAVAILABLE: missing,
    PUPPY_MODEL_SELECTION_INVALID: missing,
    MODEL_UNAVAILABLE: missing,
    PUPPY_TIMEOUT: slow,
    POD_TURN_TIMEOUT: slow,
    PUPPY_EMPTY_RESPONSE: `${Machine} finished without an answer. Try again, or pick another model.`,
    PUPPY_REVOKED: "This computer's access was removed. Link it again to keep chatting.",
  };
}

const AGENT_DID_NOT_TAKE = "Your private agent couldn't take this message. Try again in a moment.";
const AGENT_REFUSED = "Your private agent didn't accept this request. Unlock it again, then try again.";
const AGENT_UNREADABLE = "Your private agent sent back something the app couldn't read. Try again.";

/** Refusals from your private agent, or the link between this app and it. */
const AGENT_REFUSALS: Readonly<Record<string, string>> = {
  PRIVATE_AGENT_UNLOCK_REQUIRED: "Unlock your private agent to chat with Puppy.",
  PRIVATE_AGENT_UNAVAILABLE: "Your private agent isn't running right now. Open Hosting in Settings to check it.",
  PUPPY_REQUIRES_BYOC_POD: "Puppy needs your own private agent and a linked computer. Shared agents don't run Puppy.",
  PUPPY_DIRECT_BYOC_REQUIRED: "Puppy needs your own private agent and a linked computer. Shared agents don't run Puppy.",
  AGENT_UNREACHABLE: "Your private agent didn't respond. Try again in a moment.",
  AGENT_NOT_YOURS: AGENT_REFUSED,
  PUPPY_ACCESS_REFUSED: AGENT_REFUSED,
  POD_DIRECT_UNAVAILABLE: AGENT_DID_NOT_TAKE,
  POD_OWNER_CHANGED: "You switched accounts while Puppy was answering. Open the chat again to continue.",
  PUPPY_STREAM_INTERRUPTED: "The connection to your private agent dropped before the answer finished. Try again.",
  PUPPY_STREAM_INVALID: AGENT_UNREADABLE,
  PUPPY_STREAM_TOO_LARGE: AGENT_UNREADABLE,
  PUPPY_STREAM_FAILED: AGENT_UNREADABLE,
};

/** Refusals from Hussh itself, which asks the Mac to wake on the agent's behalf. */
function hubRefusals(machine: string): Record<string, string> {
  return {
    PUPPY_ACTIVATION_UNAVAILABLE: `Hussh couldn't ask ${machine} to wake up. Try again in a moment.`,
    PUPPY_ACTIVATION_REQUIRES_UNLOCK: "Unlock your private agent to chat with Puppy.",
  };
}

const NEUTRAL = "Puppy couldn't finish this answer. Nothing was sent anywhere else.";

/** The browser's own text for a request that never got a response (Chrome, Safari, Firefox). */
const BROWSER_NETWORK_FAILURES = new Set(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]);
const NETWORK_FAILURE = "Couldn't reach your private agent. Check your internet connection, then try again.";

function timeoutMessage(phase: PuppyTurnPhase, machine: string): string {
  if (phase === "dispatched") return `${capitalized(machine)} took too long to answer. Check that it's awake, then try again.`;
  if (phase === "waking") return `Your private agent and ${machine} took too long to wake up. Try again in a minute.`;
  return "Hussh took too long to check your private agent. Try again in a moment.";
}

/** Plain words for a failed turn, naming the side that failed. Never claims a fallback: none happens. */
export function puppyFailureMessage(
  reason: string,
  outcome: { timedOut: boolean; cancelled: boolean; phase?: PuppyTurnPhase },
  machine = "your computer",
): string {
  if (outcome.cancelled) return "Stopped.";
  if (outcome.timedOut) return timeoutMessage(outcome.phase ?? "dispatched", machine);
  if (BROWSER_NETWORK_FAILURES.has(reason.trim())) return NETWORK_FAILURE;
  const split = reason.indexOf(":");
  const head = split > 0 ? reason.slice(0, split) : reason;
  const inner = split > 0 ? reason.slice(split + 1) : "";
  const machineSide = machineRefusals(machine);
  return (
    machineSide[reason] ??
    machineSide[inner] ??
    hubRefusals(machine)[head] ??
    // The direct path wraps the connection step's own typed code; One's chat
    // already has owner-safe words for those, so both surfaces say the same.
    (inner ? ownerPodTurnErrorMessage(inner) : null) ??
    AGENT_REFUSALS[reason] ??
    AGENT_REFUSALS[head] ??
    ownerPodTurnErrorMessage(reason) ??
    NEUTRAL
  );
}

/** Why the model list could not be read fresh. */
export type PuppyCatalogProblem = "waking" | "not-shared" | "machine" | "hub" | "agent";

const MACHINE_CATALOG_CODES = new Set(["PUPPY_OFFLINE", "LOCAL_MODEL_OVERLOADED", "PUPPY_REVOKED"]);

/** Place a failed model-list read on the side that failed. */
export function puppyCatalogProblem(cause: unknown, timedOut: boolean, agentAnswered = false): PuppyCatalogProblem {
  // Past the deadline the slow side is the agent only until it answers; after
  // that the wait is the machine publishing its list.
  if (timedOut) return agentAnswered ? "not-shared" : "waking";
  const reason = cause instanceof Error ? cause.message : "";
  if (MACHINE_CATALOG_CODES.has(reason)) return "machine";
  if (reason.startsWith("PUPPY_ACTIVATION_")) return "hub";
  return "agent";
}

/** Plain words for the model list, with or without a list remembered from earlier. */
export function puppyCatalogMessage(problem: PuppyCatalogProblem, machine: string, remembered: boolean): string {
  const Machine = capitalized(machine);
  const lead: Record<PuppyCatalogProblem, string> = {
    waking: remembered ? "Your agent is still waking up." : "Waking your agent… This can take a minute after a break.",
    "not-shared": remembered ? `${Machine} hasn't shared a fresh list yet.` : `${Machine} hasn't shared its models yet. Send a message to wake it.`,
    machine: `${Machine} isn't answering right now.`,
    hub: `Hussh couldn't ask ${machine} for its list.`,
    agent: "Couldn't reach your private agent for the list.",
  };
  if (remembered) return `${lead[problem]} These are the models ${machine} had last time.`;
  return problem === "waking" || problem === "not-shared" ? lead[problem] : `${lead[problem]} Try again in a moment.`;
}

/** Whether "Try again" makes sense: not after the owner chose to stop. */
export function puppyFailureIsRetryable(reason: string, cancelled: boolean): boolean {
  return !cancelled && reason !== "PUPPY_REVOKED" && reason !== "PUPPY_REQUIRES_BYOC_POD";
}
