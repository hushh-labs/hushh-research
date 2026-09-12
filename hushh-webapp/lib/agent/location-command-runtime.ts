"use client";

import { ApiService } from "@/lib/services/api-service";
import {
  encryptData,
  decryptData,
  type EncryptedPayload,
} from "@/lib/vault/encrypt";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import { OneLocationService } from "@/lib/one-location/service";
import {
  canonicalActionBinding,
  prepareLocalOnboardingAction,
} from "@/lib/agent/local-onboarding-actions";

export type LocationCommandPlan = {
  schema_version: "location.plan.v1";
  capability_revision: string;
  context_revision: string;
  mode: "end_to_end" | "needs_user_gate" | "simulate";
  steps: Array<{
    action_id: string;
    slots: Record<string, string | number | boolean>;
  }>;
  gate: CommandGate | null;
  intent_summary?: string | null;
};
export type CommandGate = {
  kind: "input" | "confirmation" | "permission" | "navigation" | "unavailable";
  message: string;
  route?: string | null;
  slot?: string | null;
  choices?: Array<{ id: string; label: string; detail?: string }>;
};
export type CommandCheckpoint = {
  command_id: string;
  revision: number;
  next_step: number;
  step_count: number;
  status:
    | "awaiting_checkpoint"
    | "ready"
    | "completed"
    | "failed"
    | "cancelled"
    | "review_required";
  expires_at: string;
  capsule: EncryptedPayload | null;
};
type Directive = {
  directive_id: string;
  operation_id: string;
  context_revision: string;
};
type Admission = {
  status:
    | "ready"
    | "simulate"
    | "needs_confirmation"
    | "needs_user_gate"
    | "reconcile"
    | "advanced";
  directive?: Directive;
  gate?: CommandGate;
  route?: string;
  review_route?: string;
  checkpoint?: CommandCheckpoint;
};
type Run = {
  checkpoint: CommandCheckpoint;
  plan: LocationCommandPlan;
  binding?: Record<string, unknown>;
  bindingNonce?: string;
  bindingDigest?: string;
  chosenResourceId?: string;
};
export type CommandPresentation = {
  phase: "idle" | "working" | "gate" | "recovery" | "result";
  message: string;
  transcript?: string;
  gate?: CommandGate;
  actionLabel?: string;
  recoverable?: CommandCheckpoint[];
};
export type CommandPorts = {
  authority(): { userId: string; token: string; vaultKey: string } | null;
  context(): Record<string, unknown>;
  execute(
    actionId: string,
    slots: Record<string, unknown>,
    authority: {
      directiveId: string;
      humanConfirmationToken?: string;
      operationId: string;
      preparedBinding?: Record<string, unknown>;
      chosenResourceId?: string;
      confirmedAt?: string;
    },
    signal: AbortSignal,
  ): Promise<AgentActionRuntimeResult>;
  navigate(route: string): Promise<boolean>;
  reconcile?(): Promise<void>;
  present(value: CommandPresentation): void;
};

/** The app owns effects. This controller has no model, phrase router or speech output. */
export class LocationCommandRuntime {
  private run: Run | null = null;
  private generation = 0;
  private admission: Admission | null = null;
  private abort = new AbortController();
  private busy = false;
  private transcript = "";
  private permissionGate = false;
  private grantedPermission = false;
  private preferScreen = false;
  private preparedSummary = "";
  private localGate: CommandGate | null = null;

  constructor(private readonly ports: CommandPorts) {}

  private authority() {
    const authority = this.ports.authority();
    if (!authority)
      throw new Error("Unlock your vault to use Location commands.");
    return authority;
  }

  private async request<T>(
    path: string,
    body?: unknown,
    method = "POST",
  ): Promise<T> {
    const authority = this.authority();
    const response = await ApiService.apiFetch(`/api/one/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${authority.token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (this.ports.authority()?.userId !== authority.userId)
      throw new Error("Your account changed. Unlock to continue.");
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(
        typeof result.detail === "string"
          ? result.detail
          : "The command could not continue. Refresh its checkpoint.",
      );
    }
    return response.json() as Promise<T>;
  }

  private body() {
    if (!this.run) throw new Error("No command is active.");
    return {
      revision: this.run.checkpoint.revision,
      plan: this.run.plan,
      context: this.ports.context(),
      resource_binding_digest: this.run.bindingDigest,
      prefer_screen: this.preferScreen,
    };
  }

  private show(value: CommandPresentation) {
    this.ports.present({ transcript: this.transcript, ...value });
  }

  private check(generation: number) {
    if (generation !== this.generation || !this.ports.authority())
      throw new Error("Command paused.");
  }

  async transcribe(audioBase64: string): Promise<string> {
    const generation = this.generation;
    const result = await this.request<{ transcript: string }>(
      "transcriptions",
      { audio_base64: audioBase64 },
    );
    this.check(generation);
    return result.transcript;
  }

  async submit(
    transcript: string,
    requestId = crypto.randomUUID(),
    accepted?: () => void,
    typedAction?: LocationCommandPlan["steps"][number],
    chosenResourceId?: string,
  ): Promise<void> {
    if (this.busy || this.run)
      throw new Error("Finish or cancel your current command first.");
    this.authority();
    const generation = ++this.generation;
    this.abort = new AbortController();
    this.busy = true;
    this.transcript = transcript.trim();
    this.grantedPermission = false;
    this.permissionGate = false;
    if (!this.transcript) {
      this.busy = false;
      throw new Error("No speech was captured. Please try again.");
    }
    this.show({
      phase: "working",
      message: "Understanding your Location request…",
    });
    try {
      const proposed = await this.request<{
        plan?: LocationCommandPlan;
        checkpoint: CommandCheckpoint;
        recovery_required?: boolean;
      }>(typedAction ? "agent-chat/proposals/typed" : "agent-chat/proposals", {
        request_id: requestId,
        ...(typedAction ? { action: typedAction } : { query: this.transcript }),
        context: this.ports.context(),
      });
      this.check(generation);
      if (proposed.recovery_required || !proposed.plan) {
        this.show({
          phase: "recovery",
          message:
            "This request already has a checkpoint. Resume or cancel it.",
          recoverable: [proposed.checkpoint],
        });
        return;
      }
      this.run = {
        checkpoint: proposed.checkpoint,
        plan: proposed.plan,
        chosenResourceId,
      };
      await this.checkpoint();
      this.check(generation);
      accepted?.(); // Native handoff ownership is acknowledged only after durable encryption.
      await this.advance(generation);
    } finally {
      this.busy = false;
    }
  }

  async submitAction(
    actionId: string,
    slots: Record<string, string>,
    requestId: string,
  ): Promise<void> {
    const action = getKaiActionById(actionId);
    if (!action) throw new Error("This Location action is not registered.");
    const allowed = new Set(
      action.goal?.required_inputs.map((input) => input.slot || input.name) ||
        [],
    );
    const inputs = Object.fromEntries(
      Object.entries(slots).filter(([name]) => allowed.has(name)),
    );
    // A native request is already typed. Its model-independent identity still
    // checkpoints, binds current resources and uses the same visible receipt.
    await this.submit(
      action.label,
      requestId,
      undefined,
      { action_id: actionId, slots: inputs },
      slots.resolvedRecipientId,
    );
  }

  private async digestBinding() {
    if (!this.run?.binding) return;
    this.run.bindingNonce ||= Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    // The random salt stays inside the vault capsule. The authority receives
    // only a commitment, never the coordinates, message or selected records.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${this.run.bindingNonce}:${canonicalActionBinding(this.run.binding)}`,
      ),
    );
    this.run.bindingDigest = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  private async checkpoint(assessmentToken?: string) {
    if (!this.run) return;
    const authority = this.authority();
    await this.digestBinding();
    // Raw transcription and model response are deliberately absent. Only the
    // validated continuation and personal action inputs enter the owner capsule.
    const capsule = await encryptData(
      JSON.stringify({
        schema: "one.command.capsule.v1",
        owner: authority.userId,
        command: this.run.checkpoint.command_id,
        plan: this.run.plan,
        binding: this.run.binding,
        binding_nonce: this.run.bindingNonce,
        binding_step: this.run.checkpoint.next_step,
        chosen_resource_id: this.run.chosenResourceId,
      }),
      authority.vaultKey,
    );
    const result = await this.request<{ checkpoint: CommandCheckpoint }>(
      `action-proposals/${this.run.checkpoint.command_id}/checkpoint`,
      { ...this.body(), capsule, assessment_token: assessmentToken },
      "PUT",
    );
    if (this.run) this.run.checkpoint = result.checkpoint;
  }

  async recover(): Promise<void> {
    if (this.busy || this.run) return;
    this.authority();
    const { commands } = await this.request<{ commands: CommandCheckpoint[] }>(
      "action-proposals",
      undefined,
      "GET",
    );
    if (commands.length)
      this.show({
        phase: "recovery",
        message:
          "You have unfinished Location commands. Resume after reviewing current state.",
        recoverable: commands,
      });
  }

  async resume(checkpoint: CommandCheckpoint): Promise<void> {
    if (this.busy) return;
    const authority = this.authority();
    this.busy = true;
    const generation = ++this.generation;
    this.abort = new AbortController();
    try {
      const fresh = await this.request<{
        checkpoint: CommandCheckpoint;
        outcome?: { state: string };
        capability_revision?: string;
      }>(`action-proposals/${checkpoint.command_id}`, undefined, "GET");
      if (!fresh.checkpoint.capsule)
        throw new Error("This command has finished or expired.");
      const capsule = JSON.parse(
        await decryptData(fresh.checkpoint.capsule, authority.vaultKey),
      );
      this.check(generation);
      if (
        capsule.schema !== "one.command.capsule.v1" ||
        capsule.owner !== authority.userId ||
        capsule.command !== checkpoint.command_id ||
        capsule.plan?.schema_version !== "location.plan.v1"
      ) {
        throw new Error(
          "This checkpoint does not belong to the current vault.",
        );
      }
      this.run = {
        checkpoint: fresh.checkpoint,
        plan: capsule.plan,
        binding:
          capsule.binding_step === fresh.checkpoint.next_step
            ? capsule.binding
            : undefined,
        bindingNonce: capsule.binding_nonce,
        chosenResourceId:
          capsule.binding_step === fresh.checkpoint.next_step
            ? capsule.chosen_resource_id
            : undefined,
      };
      await this.digestBinding();
      if (
        fresh.outcome &&
        ["consumed", "settled"].includes(fresh.outcome.state)
      ) {
        // Reconcile BEFORE reading a resource that a completed operation may
        // have deleted. The ledger remains the authority after restart.
        this.preferScreen = false;
        const outcome = await this.request<Admission>(
          `action-proposals/${checkpoint.command_id}/resume`,
          this.body(),
        );
        this.check(generation);
        if (outcome.status === "reconcile") {
          this.admission = outcome;
          this.show({
            phase: "gate",
            message:
              "This operation may already have happened. Review it; it will not be repeated.",
            gate: {
              kind: "navigation",
              message: "Review the existing operation.",
              route: outcome.review_route,
            },
          });
          return;
        }
        if (outcome.checkpoint) {
          this.run.checkpoint = outcome.checkpoint;
          this.clearBinding();
          await this.ports.reconcile?.();
          this.check(generation);
        }
      }
      if (
        fresh.capability_revision &&
        fresh.capability_revision !== this.run.plan.capability_revision &&
        this.run.checkpoint.status === "ready"
      ) {
        await this.reassess(
          "Revalidate the remaining task against current capabilities and prerequisites.",
          generation,
        );
      }
      await this.advance(generation, true);
    } finally {
      this.busy = false;
    }
  }

  async chooseResource(id: string, trustedGesture: boolean): Promise<void> {
    if (
      !this.run ||
      this.busy ||
      !trustedGesture ||
      !this.localGate?.choices?.some((item) => item.id === id)
    )
      return;
    this.busy = true;
    const generation = this.generation;
    try {
      this.run.chosenResourceId = id;
      this.run.binding = undefined;
      this.run.bindingDigest = undefined;
      this.run.bindingNonce = undefined;
      this.localGate = null;
      await this.checkpoint();
      this.check(generation);
      await this.advance(generation);
    } finally {
      this.busy = false;
    }
  }

  async resolve(input: string): Promise<void> {
    if (this.busy || !this.run || !input.trim()) return;
    this.busy = true;
    const generation = this.generation;
    try {
      await this.reassess(input, generation);
      await this.advance(generation);
    } finally {
      this.busy = false;
    }
  }

  private async reassess(input: string, generation: number): Promise<void> {
    if (!this.run) return;
    const result = await this.request<{
      plan: LocationCommandPlan;
      assessment_token: string;
    }>(`action-proposals/${this.run.checkpoint.command_id}/resolve`, {
      ...this.body(),
      query: JSON.stringify({
        intent_summary: this.run.plan.intent_summary,
        pending_steps: this.run.plan.steps.slice(this.run.checkpoint.next_step),
        clarification: input,
      }),
    });
    this.check(generation);
    this.run.plan = result.plan;
    this.run.binding = undefined;
    this.run.bindingDigest = undefined;
    this.run.bindingNonce = undefined;
    this.run.chosenResourceId = undefined;
    await this.checkpoint(result.assessment_token);
    this.check(generation);
  }

  async continueGate(trustedGesture: boolean): Promise<void> {
    if (this.busy || !this.run || !trustedGesture) return;
    this.busy = true;
    const generation = this.generation;
    try {
      if (this.permissionGate) {
        const permission = await OneLocationService.requestLocationPermission();
        this.check(generation);
        if (
          permission.state !== "granted" ||
          permission.locationServicesEnabled === false
        ) {
          this.show({
            phase: "gate",
            message:
              "Allow Location access in device or browser settings, then Continue.",
            gate: {
              kind: "permission",
              message: "Location access is still required.",
            },
          });
          return;
        }
        this.grantedPermission = true;
        this.permissionGate = false;
        // Permission observations update the owning React surface and its
        // registry through effects. Give that bounded state update a turn.
        await new Promise((resolve) => setTimeout(resolve, 100));
        this.check(generation);
      } else if (this.localGate?.route) {
        await this.ports.navigate(this.localGate.route);
        this.check(generation);
        this.localGate = null;
      } else if (
        this.admission?.status === "needs_confirmation" &&
        this.admission.directive
      ) {
        const confirmation = await this.request<{ receipt: string }>(
          `action-proposals/${this.run.checkpoint.command_id}/confirm`,
          {
            ...this.body(),
            directive_id: this.admission.directive.directive_id,
            directive_context_revision:
              this.admission.directive.context_revision,
            trusted_activation: true,
          },
        );
        this.check(generation);
        await this.execute(generation, confirmation.receipt);
      } else if (this.admission?.gate?.route) {
        const opened = await this.ports.navigate(this.admission.gate.route);
        this.check(generation);
        if (!opened)
          throw new Error(
            "The Location screen is still opening. Try Continue again.",
          );
      } else if (
        this.admission?.status === "reconcile" &&
        this.admission.review_route
      ) {
        await this.ports.navigate(this.admission.review_route);
        this.check(generation);
        this.show({
          phase: "gate",
          message:
            "Review the operation here. Its outcome could not be confirmed; it will not be repeated.",
          gate: {
            kind: "unavailable",
            message:
              "Review the operation, then cancel this unfinished command.",
          },
        });
        return;
      }
      await this.advance(generation);
    } finally {
      this.busy = false;
    }
  }

  private async advance(generation: number, resuming = false): Promise<void> {
    // The bounded plan plus server step identities prevents accidental loops.
    for (let turns = 0; turns < 25 && this.run; turns++) {
      this.check(generation);
      if (this.run.checkpoint.status !== "ready") {
        const completed = this.run.checkpoint.status === "completed";
        this.run = null;
        this.show({
          phase: "result",
          message: completed
            ? "Location command completed."
            : "The command needs review. No step will be repeated.",
        });
        return;
      }
      this.show({ phase: "working", message: "Checking the next step…" });
      const preparingStep = this.run.plan.steps[this.run.checkpoint.next_step];
      const preparingAction =
        preparingStep && getKaiActionById(preparingStep.action_id);
      this.preferScreen = false;
      this.preparedSummary = "";
      if (
        preparingAction &&
        !preparingAction.command?.backend_binding &&
        (preparingAction.execution_target.status !== "wired" ||
          preparingAction.execution_target.path !== "route") &&
        !preparingAction.command?.review_only
      ) {
        // An unprepared owner cannot execute against ambient selection. First
        // mount its authored destination, then ask that same registry owner.
        await this.ports.reconcile?.();
        this.check(generation);
        let preparation = await prepareLocalOnboardingAction(
          preparingStep!.action_id,
          preparingStep!.slots,
          this.run.chosenResourceId,
        );
        if (!preparation && preparingAction.command?.review_route) {
          await this.ports.navigate(preparingAction.command.review_route);
          this.check(generation);
          preparation = await prepareLocalOnboardingAction(
            preparingStep!.action_id,
            preparingStep!.slots,
            this.run.chosenResourceId,
          );
        }
        this.check(generation);
        if (preparation?.status === "blocked") {
          this.admission = null;
          this.permissionGate = preparation.gate === "permission";
          this.localGate = {
            kind: preparation.gate,
            message: preparation.summary,
            route: preparation.route,
            choices: preparation.choices,
          };
          this.show({
            phase: "gate",
            message: preparation.summary,
            gate: this.localGate,
          });
          return;
        }
        if (preparation?.status === "ready") {
          this.preparedSummary = preparation.summary;
          if (
            canonicalActionBinding(this.run.binding) !==
            canonicalActionBinding(preparation.binding)
          ) {
            this.run.binding = preparation.binding;
            this.run.bindingNonce = undefined;
            await this.checkpoint();
            this.check(generation);
          }
        } else this.preferScreen = true;
      }
      this.admission = await this.request<Admission>(
        `action-proposals/${this.run.checkpoint.command_id}/${resuming ? "resume" : "admit"}`,
        this.body(),
      );
      resuming = false;
      this.check(generation);
      const admission = this.admission;
      if (admission.status === "advanced" && admission.checkpoint) {
        this.run.checkpoint = admission.checkpoint;
        this.clearBinding();
        await this.ports.reconcile?.();
        this.check(generation);
        continue;
      }
      if (admission.status === "needs_user_gate") {
        if (admission.gate?.kind === "navigation" && admission.gate.route) {
          const opened = await this.ports.navigate(admission.gate.route);
          this.check(generation);
          if (opened) continue;
        }
        this.show({
          phase: "gate",
          message:
            admission.gate?.message || "Add the missing detail to continue.",
          gate: admission.gate,
        });
        return;
      }
      const currentStep = this.run.plan.steps[this.run.checkpoint.next_step];
      if (!currentStep)
        throw new Error("The command checkpoint has no next step.");
      const currentAction = getKaiActionById(currentStep.action_id);
      if (
        admission.status !== "simulate" &&
        currentAction?.command?.permission === "location"
      ) {
        const permission = await OneLocationService.getPermissionState();
        this.check(generation);
        if (
          (permission.state !== "granted" &&
            !(permission.state === "prompt" && this.grantedPermission)) ||
          permission.locationServicesEnabled === false
        ) {
          this.permissionGate = true;
          this.show({
            phase: "gate",
            message:
              "Location access is needed for the next step. Continue to open the device permission prompt.",
            gate: {
              kind: "permission",
              message: "Allow Location access to continue.",
            },
          });
          return;
        }
      }
      if (admission.status === "needs_confirmation") {
        const action = currentAction;
        this.show({
          phase: "gate",
          message:
            this.preparedSummary ||
            `${action?.label || "Confirm this Location action"}${Object.values(currentStep.slots).length ? `: ${Object.values(currentStep.slots).join(", ")}` : ""}`,
          actionLabel: action?.label,
          gate: {
            kind: "confirmation",
            message: action?.meaning || "Confirm this action.",
          },
        });
        return;
      }
      if (admission.status === "reconcile") {
        this.show({
          phase: "gate",
          message:
            "This operation may already have happened. Open its review screen to check.",
          gate: {
            kind: "navigation",
            message: "Review the existing operation.",
            route: admission.review_route,
          },
        });
        return;
      }
      await this.execute(generation);
    }
    if (this.run)
      throw new Error(
        "The screen did not become ready. Review Location and resume this command.",
      );
  }

  private async execute(
    generation: number,
    confirmationReceipt?: string,
  ): Promise<void> {
    if (!this.run) return;
    const run = this.run;
    const index = run.checkpoint.next_step;
    const step = run.plan.steps[index];
    if (!step)
      throw new Error("The command checkpoint has no executable step.");
    this.check(generation);
    const action = getKaiActionById(step.action_id);
    if (action?.command?.backend_binding && !this.preferScreen) {
      const result = await this.request<Admission>(
        `action-proposals/${run.checkpoint.command_id}/execute`,
        { ...this.body(), confirmation_receipt: confirmationReceipt },
      );
      this.check(generation);
      if (result.checkpoint) run.checkpoint = result.checkpoint;
      this.clearBinding();
      await this.ports.reconcile?.();
      this.check(generation);
      return;
    }
    if (run.binding && !this.preferScreen) {
      const prepared = await prepareLocalOnboardingAction(
        step.action_id,
        step.slots,
        run.chosenResourceId,
      );
      this.check(generation);
      if (
        prepared?.status !== "ready" ||
        canonicalActionBinding(prepared.binding) !==
          canonicalActionBinding(run.binding)
      ) {
        throw new Error(
          "The selected information changed. Resume to review fresh details.",
        );
      }
    }
    const claim = await this.request<
      Directive & {
        execution_receipt: string;
        effect: "screen" | "action";
        route?: string;
      }
    >(`action-proposals/${run.checkpoint.command_id}/claim`, {
      ...this.body(),
      confirmation_receipt: confirmationReceipt,
    });
    this.check(generation);
    this.show({
      phase: "working",
      message:
        claim.effect === "screen"
          ? "Opening Location…"
          : "Running the Location action…",
    });
    // No abort races once a handler starts: a timeout cannot prove an effect failed.
    let result: Pick<AgentActionRuntimeResult, "status" | "resultSummary">;
    if (claim.effect === "screen") {
      const opened = Boolean(
        claim.route && (await this.ports.navigate(claim.route)),
      );
      result = {
        status: opened ? "succeeded" : "failed",
        resultSummary: opened
          ? "Location screen opened. Continue the operation there."
          : "The Location screen could not open. Open Location to review this operation.",
      };
    } else {
      result = await this.ports.execute(
        step.action_id,
        step.slots,
        {
          directiveId: claim.directive_id,
          humanConfirmationToken: confirmationReceipt,
          operationId: claim.operation_id,
          preparedBinding: run.binding,
          chosenResourceId: run.chosenResourceId,
          confirmedAt: new Date().toISOString(),
        },
        this.abort.signal,
      );
    }
    const status =
      claim.effect !== "screen" &&
      (result.status === "succeeded" || result.status === "noop")
        ? "succeeded"
        : "review_required";
    const settled = await this.request<{ checkpoint: CommandCheckpoint }>(
      `action-proposals/${run.checkpoint.command_id}/settle`,
      {
        step: index,
        operation_id: claim.operation_id,
        execution_receipt: claim.execution_receipt,
        status,
      },
    );
    this.check(generation);
    run.checkpoint = settled.checkpoint;
    run.binding = undefined;
    run.bindingDigest = undefined;
    run.bindingNonce = undefined;
    run.chosenResourceId = undefined;
    if (status !== "succeeded" || run.checkpoint.status === "completed") {
      this.run = null;
      this.show({
        phase: "result",
        message:
          claim.effect === "screen" && result.status === "succeeded"
            ? "Location screen opened. Continue the operation there."
            : result.resultSummary,
      });
    }
  }

  private clearBinding() {
    if (!this.run) return;
    this.run.binding = undefined;
    this.run.bindingDigest = undefined;
    this.run.bindingNonce = undefined;
    this.run.chosenResourceId = undefined;
  }

  async cancel(checkpoint?: CommandCheckpoint): Promise<void> {
    const current = checkpoint || this.run?.checkpoint;
    this.generation++;
    this.abort.abort();
    this.run = null;
    this.admission = null;
    this.transcript = "";
    this.permissionGate = false;
    this.grantedPermission = false;
    if (current)
      await this.request(
        `action-proposals/${current.command_id}`,
        undefined,
        "DELETE",
      );
    this.show({ phase: "idle", message: "" });
  }

  async refresh(): Promise<void> {
    const checkpoint = this.run?.checkpoint;
    if (this.busy) return;
    this.pause();
    if (checkpoint) await this.resume(checkpoint);
    else await this.recover();
  }

  pause(): void {
    this.generation++;
    this.abort.abort();
    this.run = null;
    this.admission = null;
    this.localGate = null;
    this.transcript = "";
    this.permissionGate = false;
    this.grantedPermission = false;
    this.show({ phase: "idle", message: "" });
  }
}
