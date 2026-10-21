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
  private inputWait: AbortController | null = null;

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
      || (previous?.viewport && !snapshot.viewport)
      || (previous?.viewport && snapshot.viewport && snapshot.controlEpoch === previous.controlEpoch
        && (snapshot.viewport.width !== previous.viewport.width || snapshot.viewport.height !== previous.viewport.height))
      || (previous && (snapshot.controlEpoch < previous.controlEpoch
        || snapshot.nextSequence < previous.nextSequence || snapshot.revision < previous.revision))) {
      throw new Error("BROWSER_TASK_RESPONSE_REFUSED");
    }
    if (snapshot.review) {
      // Queued coordinates/text preceded this website review. Confirmation
      // must not silently deliver them against the resulting page.
      const queued = this.inputs;
      this.inputs = [];
      for (const input of queued) input.reject(new Error("BROWSER_REVIEW_PENDING"));
    }
    this.publish({ ...this.state, snapshot, verified: true });
  }

  private async perform(run: (signal: AbortSignal) => Promise<ComputerUseSnapshot>, controlling = false, observation = false): Promise<void> {
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
      // Concurrent status/review reads can complete out of order. Discard only
      // an older observation for the same binding; effect receipts stay strict.
      if (!(observation && sameComputerUseBinding(this.binding, result.binding)
        && this.state.snapshot && result.revision < this.state.snapshot.revision)) this.accept(result);
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

  refresh = (): Promise<void> => this.perform((signal) => this.transport.read(this.binding, signal), false, true);

  saveDownload = (id: string): Promise<void> => {
    const offer = this.state.snapshot?.downloads?.find(item => item.id === id);
    const save = this.transport.saveDownload;
    if (!this.state.verified || !offer || !save) return Promise.reject(new Error("BROWSER_DOWNLOAD_REFUSED"));
    return this.perform(async signal => {
      const receipt = await save(this.binding, id, offer.name, "root", signal);
      if (receipt.sha256 !== offer.sha256 || receipt.bytes !== offer.size) throw new Error("BROWSER_DOWNLOAD_REFUSED");
      return this.transport.read(this.binding, signal);
    });
  };

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
      let receipt: ComputerUseSnapshot;
      try {
        receipt = await this.transport.control(this.binding, action, snapshot.controlEpoch, signal);
      } catch (error) {
        if (action !== "cancel" || signal.aborted) throw error;
        // A resize can advance the epoch before its response arrives. Reconcile
        // once using authenticated task status; never repeat takeover/handback.
        const current = await this.transport.read(this.binding, signal);
        if (!sameComputerUseBinding(this.binding, current.binding)) throw error;
        if (current.phase === "cancelled" && current.controlOwner === "stopped") receipt = current;
        else if (!isComputerUseTerminal(current.phase) && current.controlEpoch > snapshot.controlEpoch) {
          receipt = await this.transport.control(this.binding, action, current.controlEpoch, signal);
        } else throw error;
      }
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
    if (!snapshot || !verified || snapshot.review || this.state.controlling || !manualBrowserInputAllowed(snapshot)) {
      return Promise.reject(new Error("BROWSER_OWNER_CONTROL_REQUIRED"));
    }
    if (this.inputs.length >= 16 || (action.operation === "type" && action.text.length > 4096)) {
      return Promise.reject(new Error("BROWSER_INPUT_BUSY"));
    }
    if (action.operation === "resize" && (!snapshot.viewport || snapshot.review || this.request
      || !Number.isSafeInteger(action.width) || action.width < 320 || action.width > 1920
      || !Number.isSafeInteger(action.height) || action.height < 240 || action.height > 1080)) {
      return Promise.reject(new Error("BROWSER_VIEWPORT_REFUSED"));
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
    this.inputWait?.abort();
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
            if (!receipt.inputPending && receipt.nextSequence <= snapshot.nextSequence) {
              throw new Error("BROWSER_INPUT_UNCONFIRMED");
            }
            if (!receipt.inputPending && input.action.operation === "resize" && (receipt.controlOwner !== "owner"
              || receipt.controlEpoch <= snapshot.controlEpoch
              || receipt.viewport?.width !== input.action.width || receipt.viewport?.height !== input.action.height)) {
              throw new Error("BROWSER_VIEWPORT_UNCONFIRMED");
            }
            return receipt;
          }, input.action.operation === "resize");
          if (this.state.snapshot?.inputPending) await this.waitForInput(snapshot.nextSequence);
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

  private async waitForInput(sequence: number): Promise<void> {
    const waiting = new AbortController();
    this.inputWait = waiting;
    const deadline = Date.now() + 340_000;
    try {
      while (!this.disposed && !waiting.signal.aborted && Date.now() < deadline) {
        const current = this.state.snapshot;
        if (!this.state.verified || !current || isComputerUseTerminal(current.phase)) {
          throw new Error("BROWSER_INPUT_UNCONFIRMED");
        }
        if (!current.inputPending) {
          if (current.nextSequence <= sequence) throw new Error("BROWSER_INPUT_UNCONFIRMED");
          return;
        }
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); waiting.signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, 250);
          waiting.signal.addEventListener("abort", finish, { once: true });
          if (waiting.signal.aborted) finish();
        });
        if (waiting.signal.aborted || this.disposed) break;
        const receipt = await this.transport.read(this.binding, waiting.signal);
        // An independent review response can win this read. Ignore an older
        // same-task observation, while retaining all binding checks in accept.
        if (sameComputerUseBinding(this.binding, receipt.binding)
          && this.state.snapshot && receipt.revision < this.state.snapshot.revision) continue;
        this.accept(receipt);
      }
      throw new Error("BROWSER_INPUT_UNCONFIRMED");
    } finally {
      waiting.abort();
      if (this.inputWait === waiting) this.inputWait = null;
    }
  }

  acceptsFrame(frame: ComputerUseFrame): boolean {
    const { snapshot, verified } = this.state;
    return Boolean(snapshot && verified && !this.state.controlling && snapshot.capability === "ready"
      && !isComputerUseTerminal(snapshot.phase)
      && sameComputerUseBinding(this.binding, frame.binding)
      && frame.controlEpoch === snapshot.controlEpoch
      && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0
      && Number.isSafeInteger(frame.width) && frame.width >= 320 && frame.width <= 1920
      && Number.isSafeInteger(frame.height) && frame.height >= 240 && frame.height <= 1080
      && (!snapshot.viewport || (frame.width === snapshot.viewport.width && frame.height === snapshot.viewport.height))
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
