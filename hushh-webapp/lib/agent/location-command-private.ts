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
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";
import {
  getKaiActionById,
  type KaiActionDefinition,
} from "@/lib/kai/actions/kai-action-gateway";
import type {
  CommandCheckpoint,
  CommandGate,
  CommandPorts,
  CommandPresentation,
  LocationCommandPlan,
  LocationCommandStep,
} from "./location-command-runtime";

export type PrivateCommandDeps = {
  ports: Pick<
    CommandPorts,
    "execute" | "navigate" | "context" | "present" | "authority"
  >;
  /** The pod's own assessment of the spoken request (prepare grant, then `/commands/assess`). */
  assess(input: Record<string, unknown>): Promise<unknown>;
  observations(): unknown[];
  transcript(): string;
};

type Proposed = {
  plan?: LocationCommandPlan;
  checkpoint: CommandCheckpoint;
  recovery_required?: boolean;
};
type CommandSession = {
  generation: number;
  signal: AbortSignal;
  owner: NonNullable<ReturnType<CommandPorts["authority"]>>;
};
type PrivateRun = {
  commandId: string;
  revision: number;
  plan: LocationCommandPlan;
  nextStep: number;
  awaitingGesture: boolean;
  session: CommandSession;
  durable: boolean;
};
export type StepDecision =
  | { kind: "direct" }
  | { kind: "confirm" }
  | { kind: "screen"; route: string | null };

const FINISH_ON_SCREEN =
  "Finish this on the Location screen. Your agent prepared it, and you confirm it there.";
const NOT_FINISHED =
  "That step did not finish. Review it on the Location screen.";
const OUTCOME_UNCERTAIN =
  "This action may already have happened. Check its result before continuing.";
const CODES: Readonly<Record<string, string>> = {
  POD_DIRECT_NOT_READY: "Your private pod connection is not ready yet.",
  COMMAND_SEMANTIC_REQUIRED:
    "Your agent could not understand that request. Try saying it another way.",
  COMMAND_CAPABILITY_MISMATCH:
    "Location changed while your agent was planning. Try again.",
  COMMAND_ASSESSMENT_INVALID:
    "Your agent could not prepare a valid Location plan. Try again.",
  POD_APP_ROUTE_REFUSED:
    "Location commands are not available on your agent yet.",
  COMMAND_OUTCOME_UNCERTAIN: OUTCOME_UNCERTAIN,
  COMMAND_PLAN_CHANGED:
    "The screen or available actions changed. Review a new plan before continuing.",
  COMMAND_CLIENT_UPDATE_REQUIRED:
    "Refresh or update the app, then unlock to continue your command.",
};

export class PrivateCommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/** How a step may run without the hub's directive ledger. */
export function decideStep(
  step: LocationCommandStep,
  action: KaiActionDefinition | null,
): StepDecision {
  if (!("action_id" in step) || !action)
    return { kind: "screen", route: action?.command?.review_route ?? null };
  const command = action.command;
  const needsHub = Boolean(
    command?.client_receipt ||
    command?.backend_binding ||
    command?.resource_inputs ||
    command?.permission ||
    command?.review_only,
  );
  const unresolved = Boolean(
    step.dependencies?.length || step.references?.length,
  );
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
  private generation = 0;
  private session: CommandSession | null = null;

  constructor(private readonly deps: PrivateCommandDeps) {}

  get active(): boolean {
    return this.run !== null;
  }

  pause(): void {
    this.generation++;
    this.abort.abort();
    this.session = null;
    this.run = null;
  }

  private begin(): CommandSession {
    this.pause();
    const owner = this.deps.ports.authority();
    if (!owner) throw new Error("Unlock to recover this command.");
    this.abort = new AbortController();
    return (this.session = {
      generation: this.generation,
      signal: this.abort.signal,
      owner,
    });
  }

  private check(session: CommandSession): void {
    if (session.generation !== this.generation || session.signal.aborted)
      throw new DOMException(
        "Command detached. Read its saved checkpoint to continue.",
        "AbortError",
      );
    const current = this.deps.ports.authority();
    if (
      current?.userId !== session.owner.userId ||
      current.vaultKey !== session.owner.vaultKey
    )
      throw new Error("Your account or vault changed. Unlock to continue.");
  }

  private async supportsRecovery(session: CommandSession): Promise<boolean> {
    const value = await this.request<{
      identity?: { type?: string };
      transport?: { streaming?: boolean };
      podCommandCheckpointVersion?: number;
    }>("agent-chat/capabilities", undefined, "GET", session);
    if (
      value?.identity?.type !== "google-adk" ||
      value.transport?.streaming !== true ||
      (value.podCommandCheckpointVersion !== undefined &&
        value.podCommandCheckpointVersion !== 1)
    )
      throw new Error(
        "Your agent's command capabilities could not be verified.",
      );
    return value.podCommandCheckpointVersion === 1;
  }

  private show(value: CommandPresentation): void {
    this.deps.ports.present({ transcript: this.deps.transcript(), ...value });
  }

  private async request<T>(
    route: string,
    body?: unknown,
    method = "POST",
    session = this.session,
  ): Promise<T> {
    if (!session) throw new Error("Unlock to recover this command.");
    this.check(session);
    const headers = await oneChatKeyHeaders(session.owner.vaultKey);
    this.check(session);
    const response = await ApiService.ownerPodRequest(route, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: session.signal,
    });
    this.check(session);
    if (!response.ok) {
      // Never echo server text: a fixed sentence keyed by a typed code.
      const detail = (await response.json().catch(() => ({})))?.detail;
      this.check(session);
      const code =
        typeof detail?.code === "string" ? detail.code : "COMMAND_UNAVAILABLE";
      const message =
        CODES[code] ??
        (response.status === 404
          ? "This command is unavailable. Check whether its action already happened before starting again."
          : "Your agent could not continue this command. Try again.");
      throw new PrivateCommandError(message, response.status, code);
    }
    const result = (await response.json()) as T;
    this.check(session);
    return result;
  }

  async submit(input: {
    requestId: string;
    typedAction?: LocationCommandStep;
  }): Promise<void> {
    const session = this.begin();
    const durable = await this.supportsRecovery(session);
    const context = this.deps.ports.context();
    const contract = durable
      ? { checkpoint_contract: "pod-command-recovery-v1" }
      : {};
    const proposed = await this.request<Proposed>(
      input.typedAction ? "agent-chat/proposals/typed" : "agent-chat/proposals",
      input.typedAction
        ? {
            ...contract,
            request_id: input.requestId,
            action: input.typedAction,
            context,
          }
        : {
            ...contract,
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
      "POST",
      session,
    );
    if (
      durable &&
      proposed.checkpoint.checkpoint_contract !== "pod-command-recovery-v1"
    )
      throw new Error("Your agent's saved command could not be verified.");
    if (proposed.recovery_required || !proposed.plan) {
      if (durable) await this.recover();
      else
        this.show({
          phase: "result",
          message:
            "Check the original action on its screen. This agent version cannot safely resume it.",
        });
      return;
    }
    this.run = {
      commandId: proposed.checkpoint.command_id,
      revision: proposed.checkpoint.revision,
      plan: proposed.plan,
      nextStep: proposed.checkpoint.next_step,
      awaitingGesture: false,
      session,
      durable,
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

  async recover(): Promise<void> {
    if (this.run) return;
    const session = this.begin();
    if (!(await this.supportsRecovery(session))) return;
    const { commands } = await this.request<{ commands: CommandCheckpoint[] }>(
      "agent-chat/proposals",
      undefined,
      "GET",
      session,
    );
    if (commands.length)
      this.show({
        phase: "recovery",
        recoverable: commands,
        message:
          "Review your saved command before continuing. An unconfirmed action will not be repeated.",
      });
  }

  async resume(checkpoint: CommandCheckpoint): Promise<void> {
    const session = this.begin();
    const saved = await this.request<Proposed>(
      `agent-chat/proposals/${encodeURIComponent(checkpoint.command_id)}`,
      undefined,
      "GET",
      session,
    );
    if (saved.checkpoint.checkpoint_contract !== "pod-command-recovery-v1") {
      this.show({
        phase: "result",
        message:
          "Check the original action on its screen. This agent version cannot safely resume it.",
      });
      return;
    }
    if (saved.checkpoint.status === "dispatching") {
      this.show({ phase: "result", message: OUTCOME_UNCERTAIN });
      return;
    }
    if (saved.checkpoint.status !== "ready" || !saved.plan) {
      this.show({
        phase: "result",
        message: "This command has finished or needs review on its screen.",
      });
      return;
    }
    if (saved.plan.gate) {
      this.show({
        phase: "gate",
        message: saved.plan.gate.message,
        gate: { ...saved.plan.gate, waitForUser: false },
      });
      return;
    }
    this.run = {
      commandId: saved.checkpoint.command_id,
      revision: saved.checkpoint.revision,
      plan: saved.plan,
      nextStep: saved.checkpoint.next_step,
      awaitingGesture: true,
      session,
      durable: true,
    };
    this.show({
      phase: "gate",
      message: "Review the current screen, then tap Continue to resume.",
      gate: {
        kind: "confirmation",
        message: "Continue your saved command",
        waitForUser: true,
      },
    });
  }

  private async settle(
    run: PrivateRun,
    step: number,
    status: "succeeded" | "review_required",
  ) {
    const settled = await this.request<{ checkpoint: CommandCheckpoint }>(
      `agent-chat/proposals/${encodeURIComponent(run.commandId)}/settle`,
      { revision: run.revision, step, status },
      "POST",
      run.session,
    );
    run.revision = settled.checkpoint.revision;
    return settled.checkpoint;
  }

  private async advance(confirmed: boolean): Promise<void> {
    const run = this.run;
    if (!run) return;
    let allowed = confirmed;
    for (let index = run.nextStep; index < run.plan.steps.length; index += 1) {
      this.check(run.session);
      const step = run.plan.steps[index];
      if (!step) break;
      const action =
        "action_id" in step ? (getKaiActionById(step.action_id) ?? null) : null;
      const decision = decideStep(step, action);
      if (decision.kind === "screen") {
        if (decision.route) await this.deps.ports.navigate(decision.route);
        this.check(run.session);
        await this.settle(run, index, "review_required");
        this.run = null;
        this.show({ phase: "result", message: FINISH_ON_SCREEN });
        return;
      }
      if (decision.kind === "confirm" && !allowed) {
        run.awaitingGesture = true;
        run.nextStep = index;
        const message = `${action?.label ?? "Run this Location action"}. Tap Continue to confirm.`;
        this.show({
          phase: "gate",
          message,
          gate: { kind: "confirmation", message, waitForUser: true },
        });
        return;
      }
      allowed = false;
      const operationId = `pod:${run.commandId}:${index}`;
      if (run.durable) {
        const claimed = await this.request<{
          checkpoint: CommandCheckpoint;
          operationId: string;
        }>(
          `agent-chat/proposals/${encodeURIComponent(run.commandId)}/dispatch`,
          {
            revision: run.revision,
            step: index,
            context: this.deps.ports.context(),
          },
          "POST",
          run.session,
        );
        if (
          claimed.operationId !== operationId ||
          claimed.checkpoint.status !== "dispatching" ||
          claimed.checkpoint.checkpoint_contract !== "pod-command-recovery-v1"
        )
          throw new Error(CODES.COMMAND_OUTCOME_UNCERTAIN);
        run.revision = claimed.checkpoint.revision;
      }
      this.check(run.session);
      const result: AgentActionRuntimeResult = await this.deps.ports.execute(
        (step as { action_id: string }).action_id,
        step.slots,
        {
          directiveId: `pod_${run.commandId}`,
          operationId,
          confirmedAt: new Date().toISOString(),
        },
        run.session.signal,
      );
      this.check(run.session);
      const ok = result.status === "succeeded" || result.status === "noop";
      await this.settle(run, index, ok ? "succeeded" : "review_required");
      run.nextStep = index + 1;
      if (!ok) {
        this.run = null;
        this.show({
          phase: "result",
          message: result.resultSummary || NOT_FINISHED,
        });
        return;
      }
    }
    this.run = null;
    this.show({ phase: "result", message: "Done." });
  }

  async cancel(): Promise<void> {
    const run = this.run;
    this.pause();
    if (run) {
      const current = this.deps.ports.authority();
      if (current?.userId !== run.session.owner.userId || current.vaultKey !== run.session.owner.vaultKey) return;
      const session = this.begin();
      try {
        await this.request(
          `agent-chat/proposals/${encodeURIComponent(run.commandId)}`,
          undefined,
          "DELETE",
          session,
        );
      } catch {
        this.check(session);
        this.show({
          phase: "result",
          message:
            "Cancellation is unconfirmed. Check the saved command before continuing.",
        });
        return;
      }
    }
    this.show({ phase: "idle", message: "" });
  }

  async cancelCheckpoint(checkpoint: CommandCheckpoint): Promise<void> {
    if (checkpoint.status === "dispatching") {
      this.show({ phase: "result", message: OUTCOME_UNCERTAIN });
      return;
    }
    const session = this.begin();
    await this.request(
      `agent-chat/proposals/${encodeURIComponent(checkpoint.command_id)}`,
      undefined,
      "DELETE",
      session,
    );
    this.show({ phase: "idle", message: "" });
  }
}
