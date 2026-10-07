import {
  type ComputerUseBinding, type ComputerUseFrame, type ComputerUseSessionOperation, type ComputerUseSessionReceipt, type ComputerUseSnapshot,
  type ComputerUseTransport, type ManualBrowserInput, isComputerUseTerminal,
  manualBrowserInputAllowed, sameComputerUseBinding,
} from "./contracts";

export type ComputerUseViewState = Readonly<{
  snapshot: ComputerUseSnapshot | null;
  pending: boolean;
  controlling: boolean;
  verified: boolean;
}>;

/** Transient view state only. The pod owns the task, control epoch and action ledger. */
export class ComputerUseTaskController {
  private state: ComputerUseViewState = { snapshot: null, pending: false, controlling: false, verified: false };
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private disposed = false;
  private inputs: Array<{ action: ManualBrowserInput; epoch: number; resolve: () => void; reject: (error: Error) => void }> = [];
  private flushing = false;

  constructor(readonly binding: ComputerUseBinding, readonly transport: ComputerUseTransport) {}

  getSnapshot = (): ComputerUseViewState => this.state;
  connect(): void { this.disposed = false; }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: ComputerUseViewState): void {
    if (this.disposed) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  private accept(snapshot: ComputerUseSnapshot): void {
    const previous = this.state.snapshot;
    if (!sameComputerUseBinding(this.binding, snapshot.binding)
      || !Number.isSafeInteger(snapshot.controlEpoch) || snapshot.controlEpoch < 1
      || !Number.isSafeInteger(snapshot.nextSequence) || snapshot.nextSequence < 1
      || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || (previous && (snapshot.controlEpoch < previous.controlEpoch
        || snapshot.nextSequence < previous.nextSequence || snapshot.revision < previous.revision))) {
      throw new Error("BROWSER_TASK_RESPONSE_REFUSED");
    }
    this.publish({ ...this.state, snapshot, pending: true, verified: true });
  }

  private async perform(run: (signal: AbortSignal) => Promise<ComputerUseSnapshot>, controlling = false): Promise<void> {
    if (this.disposed || this.request) throw new Error("BROWSER_CONTROL_BUSY");
    const request = new AbortController();
    this.request = request;
    this.publish({ ...this.state, pending: true, controlling });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          request.abort();
          reject(new Error("BROWSER_RESPONSE_TIMEOUT"));
        }, 45_000);
      });
      const result = await Promise.race([run(request.signal), deadline]);
      if (this.disposed || this.request !== request || request.signal.aborted) {
        throw new Error("BROWSER_REQUEST_ENDED");
      }
      this.accept(result);
    } catch {
      // A lost response cannot establish ownership or justify replay. Read the
      // authoritative status again before accepting another manual action.
      if (this.request === request) this.publish({ ...this.state, verified: false });
      throw new Error("BROWSER_TASK_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
      if (this.request === request) {
        this.request = null;
        this.publish({ ...this.state, pending: false, controlling: false });
        void this.flushInputs();
      }
    }
  }

  refresh = (): Promise<void> => this.perform((signal) => this.transport.read(this.binding, signal));

  control = (action: "takeover" | "resume" | "cancel"): Promise<void> => {
    const { snapshot, verified } = this.state;
    if (!snapshot || !verified || isComputerUseTerminal(snapshot.phase)
      || snapshot.capability !== "ready"
      || (action === "takeover" && snapshot.controlOwner !== "agent")
      || (action === "resume" && snapshot.controlOwner !== "owner")) {
      return Promise.reject(new Error("BROWSER_CONTROL_REFUSED"));
    }
    if (action === "cancel") {
      // Cancellation fences immediately instead of waiting behind a slow input.
      this.request?.abort();
      this.request = null;
      this.clearInputs();
    }
    return this.perform(async (signal) => {
      const receipt = await this.transport.control(this.binding, action, snapshot.controlEpoch, signal);
      const mode = action === "takeover" ? "owner" : action === "resume" ? "agent" : "stopped";
      if (receipt.controlOwner !== mode
        || (action !== "cancel" && receipt.controlEpoch <= snapshot.controlEpoch)
        || (action === "cancel" && (receipt.phase !== "cancelled" || receipt.revision <= snapshot.revision))) {
        throw new Error("BROWSER_CONTROL_UNCONFIRMED");
      }
      return receipt;
    }, true);
  };

  input = (action: ManualBrowserInput): Promise<void> => {
    const { snapshot, verified } = this.state;
    if (!snapshot || !verified || this.state.controlling || !manualBrowserInputAllowed(snapshot)) {
      return Promise.reject(new Error("BROWSER_OWNER_CONTROL_REQUIRED"));
    }
    if (this.inputs.length >= 16 || (action.operation === "type" && action.text.length > 4096)) {
      return Promise.reject(new Error("BROWSER_INPUT_BUSY"));
    }
    return new Promise((resolve, reject) => {
      this.inputs.push({ action, epoch: snapshot.controlEpoch, resolve, reject });
      void this.flushInputs();
    });
  };

  review = (reviewId: string): Promise<void> => {
    const { snapshot, verified } = this.state;
    if (!snapshot?.review || snapshot.review.id !== reviewId || !verified || this.request) {
      return Promise.reject(new Error("BROWSER_REVIEW_REFUSED"));
    }
    return this.perform((signal) => this.transport.review(this.binding, reviewId, signal), true);
  };

  session = async (operation: ComputerUseSessionOperation, origin: string, accountId: string): Promise<ComputerUseSessionReceipt> => {
    const { snapshot, verified } = this.state;
    if (!snapshot || !verified || !manualBrowserInputAllowed(snapshot) || snapshot.review || this.request
      || !snapshot.rememberedSessionsAvailable || !snapshot.approvedOrigins?.includes(origin)
      || !accountId || accountId.length > 256) throw new Error("BROWSER_SESSION_REFUSED");
    let receipt: ComputerUseSessionReceipt | undefined;
    await this.perform(async (signal) => {
      receipt = await this.transport.session(this.binding, operation, origin, accountId, signal);
      return this.transport.read(this.binding, signal);
    }, true);
    if (!receipt) throw new Error("BROWSER_SESSION_UNCONFIRMED");
    return receipt;
  };

  private clearInputs(): void {
    const queued = this.inputs;
    this.inputs = [];
    for (const input of queued) input.reject(new Error("BROWSER_OWNER_CONTROL_REQUIRED"));
  }

  private async flushInputs(): Promise<void> {
    if (this.flushing || this.request || this.disposed) return;
    this.flushing = true;
    try {
      while (this.inputs.length && !this.request && !this.disposed) {
        const input = this.inputs.shift();
        if (!input) break;
        const { snapshot, verified } = this.state;
        if (!snapshot || !verified || !manualBrowserInputAllowed(snapshot) || snapshot.controlEpoch !== input.epoch) {
          input.reject(new Error("BROWSER_OWNER_CONTROL_REQUIRED"));
          this.clearInputs();
          break;
        }
        try {
          await this.perform(async (signal) => {
            const receipt = await this.transport.input(this.binding, {
              ...input.action, sequence: snapshot.nextSequence, control_epoch: snapshot.controlEpoch,
            }, signal);
            if (receipt.nextSequence <= snapshot.nextSequence) {
              throw new Error("BROWSER_INPUT_UNCONFIRMED");
            }
            return receipt;
          });
          if (this.state.snapshot?.phase === "outcome_uncertain") throw new Error("BROWSER_OUTCOME_UNCERTAIN");
          input.resolve();
        } catch {
          input.reject(new Error("BROWSER_TASK_UNAVAILABLE"));
          this.clearInputs();
          break;
        }
      }
    } finally { this.flushing = false; }
  }

  acceptsFrame(frame: ComputerUseFrame): boolean {
    const { snapshot, verified } = this.state;
    return Boolean(snapshot && verified && snapshot.capability === "ready"
      && !isComputerUseTerminal(snapshot.phase)
      && sameComputerUseBinding(this.binding, frame.binding)
      && frame.controlEpoch === snapshot.controlEpoch
      && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0
      && Number.isSafeInteger(frame.width) && frame.width >= 320 && frame.width <= 1920
      && Number.isSafeInteger(frame.height) && frame.height >= 240 && frame.height <= 1080
      && frame.png.byteLength >= 8 && frame.png.byteLength <= 4 * 1024 * 1024
      && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => frame.png[i] === value));
  }

  dispose(): void {
    this.disposed = true;
    this.request?.abort();
    this.request = null;
    this.clearInputs();
    this.listeners.clear();
    this.state = { snapshot: null, pending: false, controlling: false, verified: false };
  }
}
