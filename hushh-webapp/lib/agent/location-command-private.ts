"use client";

/**
 * Location commands for a person whose agent runs privately.
 *
 * For a Shared owner the hub validates the command's plan, checkpoints it and
 * authorizes each step, so the hub receives the semantic plan and the screen it
 * came from. For anyone else that is their content reaching the hub. Here:
 *
 * 1. The agent understands the request (`/commands/assess`, unchanged) and then
 *    validates and checkpoints the plan itself
 *    (consent-protocol/api/routes/one/pod_command_proposals.py).
 * 2. Each step runs through the same app action a button tap runs, so the hub
 *    receives only that typed effect (action, slots), never the query, the
 *    transcript, the screen or the plan.
 * 3. A step the app cannot finish on its own (one that needs a hub receipt, a
 *    resolved person, circle or place, a permission, or a review screen) opens its
 *    review screen, where the person finishes it with their own tap.
 *
 * A step whose action asks for confirmation waits for a trusted tap before it runs.
 */
import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import { ApiService } from "@/lib/services/api-service";
import { getKaiActionById, type KaiActionDefinition } from "@/lib/voice/kai-action-gateway";
import type {
  CommandCheckpoint,
  CommandGate,
  CommandPorts,
  CommandPresentation,
  LocationCommandPlan,
  LocationCommandStep,
} from "./location-command-runtime";

export type PrivateCommandDeps = {
  ports: Pick<CommandPorts, "execute" | "navigate" | "context" | "present">;
  /** The pod's own assessment of the spoken request (prepare grant, then `/commands/assess`). */
  assess(input: Record<string, unknown>): Promise<unknown>;
  observations(): unknown[];
  transcript(): string;
};

type Proposed = { plan?: LocationCommandPlan; checkpoint: CommandCheckpoint; recovery_required?: boolean };
type PrivateRun = {
  commandId: string;
  revision: number;
  plan: LocationCommandPlan;
  nextStep: number;
  awaitingGesture: boolean;
};
export type StepDecision =
  | { kind: "direct" }
  | { kind: "confirm" }
  | { kind: "screen"; route: string | null };

const FINISH_ON_SCREEN = "Finish this on the Location screen. Your agent prepared it, and you confirm it there.";
const NOT_FINISHED = "That step did not finish. Review it on the Location screen.";
const CODES: Readonly<Record<string, string>> = {
  COMMAND_SEMANTIC_REQUIRED: "Your agent could not understand that request. Try saying it another way.",
  COMMAND_CAPABILITY_MISMATCH: "Location changed while your agent was planning. Try again.",
  COMMAND_ASSESSMENT_INVALID: "Your agent could not prepare a valid Location plan. Try again.",
  POD_APP_ROUTE_REFUSED: "Location commands are not available on your agent yet.",
};

export class PrivateCommandError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/** How a step may run without the hub's directive ledger. */
export function decideStep(step: LocationCommandStep, action: KaiActionDefinition | null): StepDecision {
  if (!("action_id" in step) || !action) return { kind: "screen", route: action?.command?.review_route ?? null };
  const command = action.command;
  const needsHub = Boolean(
    command?.client_receipt || command?.backend_binding || command?.resource_inputs ||
      command?.permission || command?.review_only,
  );
  const unresolved = Boolean(step.dependencies?.length || step.references?.length);
  if (needsHub || unresolved || action.execution_policy === "manual_only") {
    return { kind: "screen", route: command?.review_route ?? null };
  }
  return action.execution_policy === "confirm_required" ||
    action.activation_policy === "trusted_activation_required"
    ? { kind: "confirm" }
    : { kind: "direct" };
}

export class PrivateLocationCommand {
  private run: PrivateRun | null = null;
  private abort = new AbortController();

  constructor(private readonly deps: PrivateCommandDeps) {}

  get active(): boolean {
    return this.run !== null;
  }

  private show(value: CommandPresentation): void {
    this.deps.ports.present({ transcript: this.deps.transcript(), ...value });
  }

  private async request<T>(route: string, body?: unknown, method = "POST"): Promise<T> {
    const response = await ApiService.ownerPodRequest(route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: this.abort.signal,
    });
    if (!response.ok) {
      // Never echo server text: a fixed sentence keyed by a typed code.
      const detail = (await response.json().catch(() => ({})))?.detail;
      const code = typeof detail?.code === "string" ? detail.code : "COMMAND_UNAVAILABLE";
      const message = CODES[code] ?? (response.status === 404
        ? "This command expired. Say it again to start fresh."
        : "Your agent could not continue this command. Try again.");
      throw new PrivateCommandError(message, response.status, code);
    }
    return (await response.json()) as T;
  }

  async submit(input: { requestId: string; typedAction?: LocationCommandStep }): Promise<void> {
    this.abort = new AbortController();
    const context = this.deps.ports.context();
    const proposed = await this.request<Proposed>(
      input.typedAction ? "agent-chat/proposals/typed" : "agent-chat/proposals",
      input.typedAction
        ? { request_id: input.requestId, action: input.typedAction, context }
        : {
            request_id: input.requestId,
            plan_version: "location.plan.v2",
            semantic: await this.deps.assess({
              query: this.deps.transcript(),
              context,
              plan_version: "location.plan.v2",
              observations: this.deps.observations(),
            }),
            context,
            observations: this.deps.observations(),
          },
    );
    if (proposed.recovery_required || !proposed.plan) {
      this.show({ phase: "result", message: "This request was already started. Say it again to start fresh." });
      return;
    }
    this.run = {
      commandId: proposed.checkpoint.command_id,
      revision: proposed.checkpoint.revision,
      plan: proposed.plan,
      nextStep: proposed.checkpoint.next_step,
      awaitingGesture: false,
    };
    if (proposed.plan.gate) {
      // A missing input or a permission the agent cannot ask for itself.
      const gate: CommandGate = { ...proposed.plan.gate, waitForUser: false };
      this.show({ phase: "gate", message: gate.message, gate });
      return;
    }
    await this.advance(false);
  }

  async continueGate(trustedGesture: boolean): Promise<void> {
    if (!this.run?.awaitingGesture || !trustedGesture) return;
    this.run.awaitingGesture = false;
    await this.advance(true);
  }

  private async settle(run: PrivateRun, step: number, status: "succeeded" | "review_required") {
    const settled = await this.request<{ checkpoint: CommandCheckpoint }>(
      `agent-chat/proposals/${encodeURIComponent(run.commandId)}/settle`,
      { revision: run.revision, step, status },
    );
    run.revision = settled.checkpoint.revision;
    return settled.checkpoint;
  }

  private async advance(confirmed: boolean): Promise<void> {
    const run = this.run;
    if (!run) return;
    let allowed = confirmed;
    for (let index = run.nextStep; index < run.plan.steps.length; index += 1) {
      const step = run.plan.steps[index];
      if (!step) break;
      const action = "action_id" in step ? getKaiActionById(step.action_id) ?? null : null;
      const decision = decideStep(step, action);
      if (decision.kind === "screen") {
        if (decision.route) await this.deps.ports.navigate(decision.route);
        await this.settle(run, index, "review_required");
        this.run = null;
        this.show({ phase: "result", message: FINISH_ON_SCREEN });
        return;
      }
      if (decision.kind === "confirm" && !allowed) {
        run.awaitingGesture = true;
        run.nextStep = index;
        const message = `${action?.label ?? "Run this Location action"}. Tap Continue to confirm.`;
        this.show({ phase: "gate", message, gate: { kind: "confirmation", message, waitForUser: true } });
        return;
      }
      allowed = false;
      const result: AgentActionRuntimeResult = await this.deps.ports.execute(
        (step as { action_id: string }).action_id,
        step.slots,
        {
          directiveId: `pod_${run.commandId}`,
          operationId: `pod:${run.commandId}:${index}`,
          confirmedAt: new Date().toISOString(),
        },
        this.abort.signal,
      );
      const ok = result.status === "succeeded" || result.status === "noop";
      await this.settle(run, index, ok ? "succeeded" : "review_required");
      run.nextStep = index + 1;
      if (!ok) {
        this.run = null;
        this.show({ phase: "result", message: result.resultSummary || NOT_FINISHED });
        return;
      }
    }
    this.run = null;
    this.show({ phase: "result", message: "Done." });
  }

  async cancel(): Promise<void> {
    const run = this.run;
    this.run = null;
    this.abort.abort();
    if (run) {
      this.abort = new AbortController();
      await this.request(`agent-chat/proposals/${encodeURIComponent(run.commandId)}`, undefined, "DELETE")
        .catch(() => undefined);
    }
    this.show({ phase: "idle", message: "" });
  }
}
