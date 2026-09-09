import type {
  IntentResolution,
  LocalIntentCandidate,
  OneVoiceIntentContext,
} from "./local-intent-resolver";
import { getKaiActionById } from "./kai-action-gateway";
import { emitLocalRuntimeEvent } from "./local-runtime-observability";

export type IntentRankerInput = {
  utterance: string;
  context: OneVoiceIntentContext;
  candidates: readonly LocalIntentCandidate[];
};

export type IntentRankerResult = {
  actionId: string;
  confidence: number;
  margin: number;
};

export interface OneVoiceIntentRanker {
  rank(input: IntentRankerInput): Promise<IntentRankerResult | null>;
  dispose?: () => void;
}

type RankerWorkerMessage =
  | { type: "ready" }
  | { type: "ranked"; requestId: string; result: IntentRankerResult | null }
  | { type: "error"; requestId?: string; code: string };

type RankerWorkerLike = {
  onmessage: ((event: MessageEvent<RankerWorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
};

export class OnnxIntentRanker implements OneVoiceIntentRanker {
  private worker: RankerWorkerLike | null = null;
  private ready: Promise<void> | null = null;
  private requestSequence = 0;
  private pending = new Map<
    string,
    { resolve: (result: IntentRankerResult | null) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly modelBytes: ArrayBuffer,
    private readonly preprocessingVersion: string,
    workerFactory: () => RankerWorkerLike = () =>
      new Worker(new URL("./local-intent-ranker.worker.ts", import.meta.url), {
        type: "module",
      }) as unknown as RankerWorkerLike,
  ) {
    this.worker = workerFactory();
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = () => this.failAll("local_intent_ranker_worker_failed");
  }

  async rank(input: IntentRankerInput): Promise<IntentRankerResult | null> {
    if (input.candidates.length === 0) return null;
    const startedAt = performance.now();
    emitLocalRuntimeEvent({
      event: "local_inference_started",
      provider: "onnxruntime_web",
    });
    await this.ensureReady();
    const requestId = `rank_${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker?.postMessage({
        type: "rank",
        requestId,
        utterance: input.utterance,
        candidates: input.candidates,
      });
      void this.waitForResult(requestId, startedAt);
    });
  }

  private async waitForResult(
    requestId: string,
    startedAt: number,
  ): Promise<void> {
    // The worker message handler owns the actual resolution. This watchdog is
    // only a bounded failure path so a crashed worker cannot strand a turn.
    await new Promise((settle) => setTimeout(settle, 5_000));
    const waiter = this.pending.get(requestId);
    if (!waiter) return;
    this.pending.delete(requestId);
    const error = new Error("local_intent_ranker_timeout");
    emitLocalRuntimeEvent({
      event: "local_inference_failed",
      provider: "onnxruntime_web",
      reason: error.message,
      elapsedMs: performance.now() - startedAt,
    });
    waiter.reject(error);
  }

  dispose(): void {
    this.failAll("local_intent_ranker_disposed");
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    if (!this.worker) return Promise.reject(new Error("local_intent_ranker_disposed"));
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("local_intent_ranker_timeout")), 5_000);
      const onReady = (event: MessageEvent<RankerWorkerMessage>) => {
        if (event.data.type !== "ready") return;
        clearTimeout(timeout);
        this.worker!.onmessage = (next) => this.handleMessage(next.data);
        resolve();
      };
      this.worker!.onmessage = onReady;
      const bytes = this.modelBytes.slice(0);
      this.worker!.postMessage(
        { type: "load", modelBytes: bytes, preprocessingVersion: this.preprocessingVersion },
        [bytes],
      );
    });
    return this.ready;
  }

  private handleMessage(message: RankerWorkerMessage): void {
    if (message.type === "ready") return;
    if (message.type !== "ranked" && message.type !== "error") return;
    const requestId = message.requestId;
    if (!requestId) return;
    const waiter = this.pending.get(requestId);
    if (!waiter) return;
    this.pending.delete(requestId);
    if (message.type === "ranked") {
      emitLocalRuntimeEvent({
        event: "local_inference_completed",
        provider: "onnxruntime_web",
      });
      waiter.resolve(message.result);
    } else {
      emitLocalRuntimeEvent({
        event: "local_inference_failed",
        provider: "onnxruntime_web",
        reason: message.code,
      });
      waiter.reject(new Error(message.code));
    }
  }

  private failAll(code: string): void {
    for (const waiter of this.pending.values()) waiter.reject(new Error(code));
    this.pending.clear();
  }
}

export function rankerResultToResolution(
  result: IntentRankerResult,
  candidates: readonly LocalIntentCandidate[],
  context: OneVoiceIntentContext,
): IntentResolution | null {
  const candidate = candidates.find((entry) => entry.actionId === result.actionId);
  if (
    !candidate ||
    !Number.isFinite(result.confidence) ||
    !Number.isFinite(result.margin) ||
    result.confidence < 0 ||
    result.confidence > 1 ||
    result.margin < 0
  ) {
    return null;
  }
  const action = getKaiActionById(candidate.actionId);
  if (!action) return null;
  const missingSlots = action.goal.required_inputs
    .filter((input) => input.required !== false)
    .map((input) => input.slot || input.name)
    .filter((slot) => candidate.slots[slot] === undefined)
    .slice(0, 1);
  return {
    disposition: missingSlots.length > 0 ? "clarify" : "action",
    agentNamespace: candidate.agentNamespace,
    actionId: candidate.actionId,
    slots: candidate.slots,
    confidence: result.confidence,
    contextRevision: context.contextRevision,
    catalogVersion: context.catalogVersion,
    ...(missingSlots.length > 0 ? { missingSlots } : {}),
  };
}
