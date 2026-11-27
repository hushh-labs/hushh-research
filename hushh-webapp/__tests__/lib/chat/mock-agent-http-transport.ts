import type { HttpAgent } from "@ag-ui/client";

type Subscriber = Record<string, (input: any) => void>;
type AgentTransportFixture = {
  runAgent: (parameters: unknown, config: ConstructorParameters<typeof HttpAgent>[0]) => unknown;
  addMessage: (...args: Parameters<HttpAgent["addMessage"]>) => unknown;
  setMessages: (...args: Parameters<HttpAgent["setMessages"]>) => unknown;
  nativeMode: boolean;
  outcome: "success" | "interrupt";
  emitEvents: ((subscriber: Subscriber) => void) | null;
  aborted: boolean;
  failWith: Error | null;
  endWithoutTerminal: boolean;
  hangAfterBodyEof: boolean;
  readBody: boolean;
};

/** Simulate the AG-UI SDK transport while keeping real owner request processing. */
export function mockAgentHttpTransport(actual: typeof import("@ag-ui/client"), transport: AgentTransportFixture) {
  return class {
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private abortController = new AbortController();
    private releaseAfterEof: (() => void) | null = null;
    private realAgent: InstanceType<typeof actual.HttpAgent> | null;
    constructor(public config: ConstructorParameters<typeof actual.HttpAgent>[0]) {
      this.realAgent = transport.nativeMode ? new actual.HttpAgent(config) : null;
    }
    addMessage(message: Parameters<typeof actual.HttpAgent.prototype.addMessage>[0]) { transport.addMessage(message); this.realAgent?.addMessage(message); }
    use(...middleware: Parameters<typeof actual.HttpAgent.prototype.use>) { this.realAgent?.use(...middleware); return this; }
    setMessages(messages: Parameters<typeof actual.HttpAgent.prototype.setMessages>[0]) { transport.setMessages(messages); this.realAgent?.setMessages(messages); }
    abortRun() {
      transport.aborted = true;
      this.realAgent?.abortRun();
      this.abortController.abort();
      void this.reader?.cancel().catch(() => undefined);
      this.releaseAfterEof?.();
    }
    async runAgent(parameters: unknown, subscriber: Subscriber) {
      this.abortController = new AbortController();
      transport.runAgent(parameters, this.config);
      if (this.realAgent) return this.realAgent.runAgent(parameters as Parameters<typeof actual.HttpAgent.prototype.runAgent>[0], subscriber);
      if (transport.failWith) {
        const error = transport.failWith;
        subscriber.onRunFailed?.({ error });
        throw error;
      }
      if (transport.readBody) {
        const response = await this.config.fetch!("/api/one/agent-chat", { signal: this.abortController.signal });
        this.reader = response.body!.getReader();
        while (!(await this.reader.read()).done) { /* keep reading */ }
        if (transport.hangAfterBodyEof) {
          await new Promise<void>((resolve) => { this.releaseAfterEof = resolve; });
        }
        // The real client reports its own abort to the subscriber, then swallows it.
        if (transport.aborted) {
          subscriber.onRunFailed?.({ error: new DOMException("Aborted", "AbortError") });
          return;
        }
      }
      subscriber.onRunStartedEvent?.({ event: { type: "RUN_STARTED" } });
      if (transport.emitEvents) {
        transport.emitEvents(subscriber);
      }
      if (transport.aborted) return;
      subscriber.onTextMessageContentEvent?.({
        event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" },
      });
      subscriber.onActivitySnapshotEvent?.({
        event: {
          type: "ACTIVITY_SNAPSHOT",
          messageId: "activity-1",
          activityType: "one.scope_discovery.v1",
          content: {
            status: "ok",
            person: {
              displayName: "Alex Morgan",
              profilePath: "/people/1234567890abcdef",
              relationship: "connected",
            },
            requestableScopes: [],
          },
        },
      });
      if (transport.endWithoutTerminal) return;
      if (transport.outcome === "interrupt") {
        subscriber.onRunFinishedEvent?.({
          event: { type: "RUN_FINISHED" },
          outcome: "interrupt",
          interrupts: [{ id: "interrupt-1", toolCallId: "tool-1" }],
        });
        return;
      }
      subscriber.onRunFinishedEvent?.({
        event: { type: "RUN_FINISHED" },
        outcome: transport.outcome,
      });
    }
  };
}
