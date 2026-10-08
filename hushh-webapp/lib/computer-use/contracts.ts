/** Private, in-memory view of an admitted browser task. No hub transcript payloads. */
export type ComputerUseBinding = Readonly<{
  ownerId: string;
  podId: string;
  incarnation: string;
  taskId: string;
  environment: "development";
}>;

export type ComputerUsePhase =
  | "unavailable" | "running" | "needs_owner"
  | "outcome_uncertain" | "completed" | "cancelled";

export type ComputerUseSnapshot = Readonly<{
  binding: ComputerUseBinding;
  phase: ComputerUsePhase;
  capability: "ready" | "unavailable";
  controlOwner: "agent" | "owner" | "stopped" | "uncertain";
  controlEpoch: number;
  nextSequence: number;
  revision: number;
  review?: ComputerUseReview;
  approvedOrigins?: readonly string[];
  rememberedSessionsAvailable?: boolean;
}>;

export type ComputerUseReview = Readonly<{
  id: string;
  purpose: "model_process" | "disclose" | "session_remember" | "session_restore";
  model?: string;
  taskGoal?: string;
  origins: string[];
  destination?: string;
  details: Array<{ label: string; value: string }>;
}>;

export type ComputerUseFrame = Readonly<{
  binding: ComputerUseBinding;
  controlEpoch: number;
  sequence: number;
  width: number;
  height: number;
  png: Uint8Array;
}>;

export type ManualBrowserInput =
  | { operation: "click"; x: number; y: number }
  | { operation: "drag"; x: number; y: number; destination_x: number; destination_y: number }
  | { operation: "type"; x: number; y: number; text: string; clear_before_typing: false; focus_existing?: true }
  | { operation: "keys"; keys: string[] }
  | { operation: "scroll"; direction: "up" | "down" | "left" | "right"; magnitude: number };

export type ComputerUseSessionOperation = "remember" | "restore" | "forget";
export type ComputerUseSessionReceipt =
  | { state: "review_required" | "remembered" | "restored" | "not_found" }
  | { state: "forgotten"; fenced: boolean; persisted: boolean; deletionRequested: boolean };

/** The adapter uses existing signed direct admission. This port never chooses an endpoint. */
export interface ComputerUseTransport {
  read(binding: ComputerUseBinding, signal: AbortSignal): Promise<ComputerUseSnapshot>;
  control(
    binding: ComputerUseBinding,
    action: "takeover" | "resume" | "cancel",
    controlEpoch: number,
    signal: AbortSignal,
  ): Promise<ComputerUseSnapshot>;
  input(
    binding: ComputerUseBinding,
    action: ManualBrowserInput & { sequence: number; control_epoch: number },
    signal: AbortSignal,
  ): Promise<ComputerUseSnapshot>;
  review(binding: ComputerUseBinding, reviewId: string, signal: AbortSignal): Promise<ComputerUseSnapshot>;
  session(binding: ComputerUseBinding, operation: ComputerUseSessionOperation, origin: string,
    accountId: string, signal: AbortSignal): Promise<ComputerUseSessionReceipt>;
  /** Preview observations must not count as task activity or extend the idle lease. */
  watchFrames(
    binding: ComputerUseBinding,
    signal: AbortSignal,
    receive: (frame: ComputerUseFrame) => void,
  ): Promise<void>;
}

export function sameComputerUseBinding(a: ComputerUseBinding, b: ComputerUseBinding): boolean {
  return a.ownerId === b.ownerId && a.podId === b.podId && a.incarnation === b.incarnation
    && a.taskId === b.taskId && a.environment === b.environment;
}

export function isComputerUseTerminal(phase: ComputerUsePhase): boolean {
  return ["unavailable", "completed", "cancelled", "outcome_uncertain"].includes(phase);
}

export function manualBrowserInputAllowed(snapshot: ComputerUseSnapshot | null): boolean {
  return Boolean(snapshot?.capability === "ready" && snapshot.controlOwner === "owner"
    && !isComputerUseTerminal(snapshot.phase));
}
