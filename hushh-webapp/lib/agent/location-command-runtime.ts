"use client";

import { ApiService } from "@/lib/services/api-service";
import {
  LocationReferenceSession,
  isLocationObservation,
  type LocationObservation,
} from "@/lib/one-location/command-references";
import {
  commandContinuation,
  type CommandContinuationProof,
} from "@/lib/one-location/command-continuation";
import type { PrivateCheckInDraft } from "@/lib/one-location/command-private-check-in";
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
  type LocalActionResources,
  type LocalActionContinuation,
} from "@/lib/agent/local-onboarding-actions";
import {
  parseLocationOnboardingRunResult,
  type LocationOnboardingRunResultV1,
} from "@/lib/services/one-location-onboarding-run-client";
import type { LocationRequestedWorkflowAuthority } from "@/lib/personal-knowledge-model/mutation-plan";
import type {
  OneLocationPreVaultDraft,
  OneLocationPreVaultDraftMetadataV1,
} from "@/lib/services/one-location-pre-vault-draft-service";

export type LocationActionStep = {
  action_id: string;
  slots: Record<string, string | number | boolean>;
  dependencies?: Array<{ slot: string; source_step: number }>;
  references?: Array<{ slot: string; reference: string }>;
};
export type LocationWorkflowStep = {
  workflow_id: "workflow.setup.location";
  slots: Record<string, never>;
};
export type LocationCommandStep = LocationActionStep | LocationWorkflowStep;

export type LocationCommandPlan = {
  schema_version: "location.plan.v1" | "location.plan.v2";
  capability_revision: string;
  context_revision: string;
  mode: "end_to_end" | "needs_user_gate" | "simulate";
  steps: LocationCommandStep[];
  gate: CommandGate | null;
  intent_summary?: string | null;
};
export type CommandGate = {
  kind: "input" | "confirmation" | "permission" | "navigation" | "unavailable";
  message: string;
  route?: string | null;
  waitForUser?: boolean;
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
    | "recovery_required"
    | "workflow"
    | "advanced"
    | "resume_preparation_required";
  continuation?: CommandContinuationProof;
  workflow?: unknown;
  workflow_finalize_renewed?: boolean;
  directive?: Directive;
  gate?: CommandGate;
  route?: string;
  review_route?: string;
  checkpoint?: CommandCheckpoint;
};
type Run = {
  privateContinuation?: PrivateCheckInDraft;
  continuation?: LocalActionContinuation;
  continuationSnapshot?: string;
  needsReconcile?: boolean;
  checkpointUncertain?: boolean;
  observedResourceThrough?: number;
  checkpoint: CommandCheckpoint;
  plan: LocationCommandPlan;
  binding?: Record<string, unknown>;
  bindingNonce?: string;
  bindingDigest?: string;
  chosenResourceId?: string;
  resolvedResources?: LocalActionResources;
  observations?: LocationObservation[];
  workflow?: {
    authority: LocationRequestedWorkflowAuthority;
    draft?: {
      sealed: EncryptedPayload;
      metadata: OneLocationPreVaultDraftMetadataV1;
    };
    commitDispatched?: boolean;
  };
};
class CommandRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "COMMAND_UNAVAILABLE",
  ) {
    super(message);
  }
}

export type CommandPresentation = {
  phase: "idle" | "working" | "gate" | "recovery" | "result";
  message: string;
  transcript?: string;
  gate?: CommandGate;
  actionLabel?: string;
  recoverable?: CommandCheckpoint[];
};
export type CommandPorts = {
  modelConnection?: () => Promise<Record<string, unknown>>;
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
      privateContinuation?: PrivateCheckInDraft;
      chosenResourceId?: string;
      resolvedResources?: LocalActionResources;
      confirmedAt?: string;
      continuation?: LocalActionContinuation;
    },
    signal: AbortSignal,
  ): Promise<AgentActionRuntimeResult>;
  navigate(route: string, requiredActionId?: string): Promise<boolean>;
  reconcile?(): Promise<void>;
  presentWorkflow?(result: LocationOnboardingRunResultV1): void;
  pauseWorkflow?(): void;
  present(value: CommandPresentation): void;
};

/** The app owns effects. This controller has no model, phrase router or speech output. */
export class LocationCommandRuntime {
  private run: Run | null = null;
  private generation = 0;
  private admission: Admission | null = null;
  private abort = new AbortController();
  private transcriptionAbort = new AbortController();
  private busy = false;
  private transcript = "";
  private permissionGate = false;
  private grantedPermission = false;
  private preferScreen = false;
  private preparedSummary = "";
  private preparedScreenSummary = "";
  private localGate: CommandGate | null = null;
  private readonly references = new LocationReferenceSession();
  private pendingCancellation: { commandId: string; owner: string } | null =
    null;

  constructor(private readonly ports: CommandPorts) {}

  get hasActiveCheckpoint(): boolean {
    return this.run?.checkpoint !== undefined && this.run?.checkpoint !== null;
  }

  clearReferences(): void {
    this.references.clear();
  }

  private remember(
    values: readonly unknown[] | undefined,
    replacePlaces = false,
  ): void {
    this.references.observe(
      this.authority().userId,
      values || [],
      replacePlaces,
    );
  }

  private neededObservations(
    plan: LocationCommandPlan,
    saved: readonly unknown[] = [],
  ): LocationObservation[] {
    const needed = new Set(
      plan.steps.flatMap((step) =>
        "action_id" in step
          ? (step.references || []).map((item) => item.reference)
          : [],
      ),
    );
    const values = new Map(
      [
        ...saved.filter(isLocationObservation),
        ...this.references.list(this.authority().userId),
      ].map(({ reference, kind, id, name, observed_at }) => [
        reference,
        { reference, kind, id, name, observed_at },
      ]),
    );
    return [...values.values()]
      .filter((item) => needed.has(item.reference))
      .slice(0, 50);
  }

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
    signal = this.abort.signal,
  ): Promise<T> {
    const authority = this.authority();
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const response = path.startsWith("pod/commands/")
      ? await ApiService.ownerPodRequest(path.slice(4), { ...init, signal })
      : await ApiService.apiFetch(`/api/one/${path}`, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${authority.token}`,
          },
        });
    if (this.ports.authority()?.userId !== authority.userId)
      throw new Error("Your account changed. Unlock to continue.");
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      const code =
        typeof result?.detail?.code === "string"
          ? result?.detail.code
          : "COMMAND_UNAVAILABLE";
      const messages: Record<string, string> = {
        AGENT_PRIVATE_RUNTIME_REQUIRED:
          "Connect your private pod to use this command.",
        POD_DIRECT_NOT_READY: "Your private pod connection is not ready yet.",
        LOCAL_AUTHORITY_UNAVAILABLE:
          "Your private pod could not verify this session. Reconnect to continue.",
      };
      throw new CommandRequestError(
        messages[code] ??
          (typeof result?.detail === "string"
            ? result?.detail
            : response.status === 401 || response.status === 403
              ? "Unlock your vault and reconnect to continue."
              : response.status >= 500
                ? "The command service is temporarily unavailable. Try again shortly."
                : "The command could not continue. Try again."),
        response.status,
        code,
      );
    }
    const result = (await response.json()) as T;
    if (this.ports.authority()?.userId !== authority.userId)
      throw new Error("Your account changed. Unlock to continue.");
    return result;
  }

  private body(run = this.run) {
    if (!run) throw new Error("No command is active.");
    return {
      revision: run.checkpoint.revision,
      plan: run.plan,
      context: this.ports.context(),
      resource_binding_digest: run.bindingDigest,
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

  cancelTranscription(): void {
    this.transcriptionAbort.abort();
  }

  async transcribe(audioBase64: string): Promise<string> {
    this.cancelTranscription();
    this.transcriptionAbort = new AbortController();
    const generation = this.generation;
    const result = await this.request<{ transcript: string }>(
      "pod/commands/transcriptions",
      {
        audio_base64: audioBase64,
        model: (await this.ports.modelConnection?.()) ?? {},
      },
      "POST",
      this.transcriptionAbort.signal,
    );
    this.check(generation);
    return result.transcript;
  }

  private async assessPrivately(
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const generation = this.generation;
    const grant = await this.request<{ scopeToken: string }>(
      "agent-chat/proposals/prepare",
    );
    this.check(generation);
    const model = (await this.ports.modelConnection?.()) ?? {};
    this.check(generation);
    const result = await this.request<unknown>("pod/commands/assess", {
      ...input,
      scope_token: grant.scopeToken,
      model,
    });
    this.check(generation);
    return result;
  }

  async submit(
    transcript: string,
    requestId = crypto.randomUUID(),
    accepted?: () => void,
    typedAction?: LocationCommandPlan["steps"][number],
    chosenResourceId?: string,
  ): Promise<void> {
    if (this.busy || this.run || this.pendingCancellation)
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
        observations?: LocationObservation[];
      }>(typedAction ? "agent-chat/proposals/typed" : "agent-chat/proposals", {
        request_id: requestId,
        ...(typedAction
          ? { action: typedAction }
          : {
              semantic: await this.assessPrivately({
                query: this.transcript,
                context: this.ports.context(),
                plan_version: "location.plan.v2",
                observations: this.references.list(this.authority().userId),
              }),
              plan_version: "location.plan.v2",
            }),
        context: this.ports.context(),
      });
      this.check(generation);
      this.remember(proposed.observations);
      if (proposed.recovery_required || !proposed.plan) {
        this.show({
          phase: "recovery",
          message:
            "This request already has a checkpoint. Resume or cancel it.",
          recoverable: [proposed.checkpoint],
        });
        accepted?.(); // The existing durable task is now available for explicit Resume.
        return;
      }
      this.run = {
        observations: this.neededObservations(proposed.plan),
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
    slots: Record<string, string | number | boolean>,
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
      typeof slots.resolvedRecipientId === "string"
        ? slots.resolvedRecipientId
        : undefined,
    );
  }

  private async digestBinding(run = this.run) {
    if (!run?.binding) return;
    run.bindingNonce ||= Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    // The salt stays in the vault capsule. Most actions expose only this
    // commitment. Circle membership discloses its typed selection transiently
    // at claim so the owning service can freeze batch HMACs; coordinates and
    // messages are never part of that specialized disclosure.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${run.bindingNonce}:${canonicalActionBinding(run.binding)}`,
      ),
    );
    run.bindingDigest = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  private async checkpoint(assessmentToken?: string, candidate = this.run) {
    const active = this.run;
    const run = candidate;
    if (!run || !active) return;
    const generation = this.generation;
    const authority = this.authority();
    const check = () => {
      this.check(generation);
      if (this.run !== active || this.authority().userId !== authority.userId)
        throw new Error("The active command changed.");
    };
    await this.digestBinding(run);
    check();
    // Raw transcription and model response are deliberately absent. Only the
    // validated continuation and personal action inputs enter the owner capsule.
    const capsule = await encryptData(
      JSON.stringify({
        schema: "one.command.capsule.v1",
        owner: authority.userId,
        command: run.checkpoint.command_id,
        plan: run.plan,
        binding: run.binding,
        private_continuation: run.privateContinuation,
        binding_nonce: run.bindingNonce,
        binding_step: run.checkpoint.next_step,
        chosen_resource_id: run.chosenResourceId,
        workflow: run.workflow,
        observations: run.observations,
      }),
      authority.vaultKey,
    );
    check();
    let result: { checkpoint: CommandCheckpoint };
    try {
      result = await this.request<{ checkpoint: CommandCheckpoint }>(
        `action-proposals/${run.checkpoint.command_id}/checkpoint`,
        { ...this.body(run), capsule, assessment_token: assessmentToken },
        "PUT",
      );
    } catch (error) {
      // The server may have committed even when its response was lost. Keep
      // the original local selection and require an explicit canonical reload.
      if (this.run === active) active.checkpointUncertain = true;
      throw error;
    }
    check();
    run.checkpoint = result.checkpoint;
    this.run = run;
  }

  private requireFreshCheckpoint(): void {
    if (this.run?.checkpointUncertain)
      throw new Error(
        "Refresh / Resume to read the saved task before continuing.",
      );
  }

  async recover(): Promise<void> {
    if (this.busy || this.run) return;
    const owner = this.authority().userId;
    const generation = this.generation;
    const { commands } = await this.request<{ commands: CommandCheckpoint[] }>(
      "action-proposals",
      undefined,
      "GET",
    );
    if (
      generation !== this.generation ||
      this.ports.authority()?.userId !== owner ||
      this.busy ||
      this.run
    )
      return;
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
        outcome?: { state: string; consumed_at?: string };
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
        !["location.plan.v1", "location.plan.v2"].includes(
          capsule.plan?.schema_version,
        )
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
        privateContinuation:
          capsule.binding_step === fresh.checkpoint.next_step &&
          capsule.plan.steps[fresh.checkpoint.next_step]?.action_id ===
            "location.send_check_in"
            ? capsule.private_continuation
            : undefined,
        chosenResourceId:
          capsule.binding_step === fresh.checkpoint.next_step
            ? capsule.chosen_resource_id
            : undefined,
        workflow: capsule.workflow,
        observations: Array.isArray(capsule.observations)
          ? capsule.observations.slice(0, 50).filter(isLocationObservation)
          : [],
      };
      // Only still-fresh references re-enter the unlocked session. Retained
      // expired locators remain task-local and require the owning preparer.
      this.remember(this.run.observations);
      await this.digestBinding();
      if (
        fresh.outcome &&
        (["consumed", "settled"].includes(fresh.outcome.state) ||
          !!fresh.outcome.consumed_at)
      ) {
        // Reconcile BEFORE reading a resource that a completed operation may
        // have deleted. The ledger remains the authority after restart.
        this.preferScreen = false;
        const outcome = await this.request<Admission>(
          `action-proposals/${checkpoint.command_id}/resume`,
          this.resumeBody(),
        );
        this.check(generation);
        if (outcome.status === "resume_preparation_required")
          this.installContinuation(outcome);
        if (outcome.status === "workflow") {
          await this.presentWorkflow(outcome, generation);
          return;
        }
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
      this.requireFreshCheckpoint();
      if (this.run.continuation || this.run.needsReconcile)
        throw new Error(
          "Resume the original selection before choosing another resource.",
        );
      const replacement = {
        ...this.run,
        chosenResourceId: id,
        binding: undefined,
        privateContinuation: undefined,
        bindingDigest: undefined,
        bindingNonce: undefined,
      };
      await this.checkpoint(undefined, replacement);
      this.check(generation);
      this.localGate = null;
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
    this.requireFreshCheckpoint();
    if (this.run.continuation || this.run.needsReconcile)
      throw new Error(
        "Resume the original operation before changing this task.",
      );
    const savedObservations = (this.run.observations || []).filter((value) =>
      this.run!.plan.steps.slice(this.run!.checkpoint.next_step).some(
        (step) =>
          "action_id" in step &&
          step.references?.some((item) => item.reference === value.reference),
      ),
    );
    const semantic = await this.assessPrivately({
      context: this.ports.context(),
      plan_version: this.run.plan.schema_version,
      completed_steps: this.run.plan.steps.slice(
        0,
        this.run.checkpoint.next_step,
      ),
      observations: this.references.list(this.authority().userId),
      saved_observations: savedObservations,
      query: JSON.stringify({
        intent_summary: this.run.plan.intent_summary,
        pending_steps: this.run.plan.steps.slice(this.run.checkpoint.next_step),
        clarification: input,
      }),
    });
    this.check(generation);
    const result = await this.request<{
      plan: LocationCommandPlan;
      assessment_token: string;
      observations?: LocationObservation[];
    }>(`action-proposals/${this.run.checkpoint.command_id}/resolve`, {
      ...this.body(),
      semantic,
      saved_observations: savedObservations,
    });
    this.check(generation);
    const replacement = {
      ...this.run,
      plan: result.plan,
      observations: this.neededObservations(result.plan, result.observations),
      binding: undefined,
      privateContinuation: undefined,
      bindingDigest: undefined,
      bindingNonce: undefined,
      chosenResourceId: undefined,
      resolvedResources: undefined,
    };
    await this.checkpoint(result.assessment_token, replacement);
    this.check(generation);
    this.remember(result.observations);
  }

  async continueGate(trustedGesture: boolean): Promise<void> {
    if (this.busy || !this.run || !trustedGesture) return;
    this.requireFreshCheckpoint();
    this.busy = true;
    const generation = this.generation;
    try {
      if (this.run.needsReconcile) {
        await this.advance(generation, true);
        return;
      }
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
        const gate = this.localGate;
        const opened = await this.ports.navigate(gate.route!);
        this.check(generation);
        if (!opened)
          throw new Error(
            "The required review could not open. Try again or cancel this task.",
          );
        if (gate.waitForUser) {
          this.localGate = { ...gate, route: undefined };
          this.show({
            phase: "gate",
            message: gate.message,
            gate: this.localGate,
          });
          return;
        }
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
        ).catch((error: unknown) => {
          if (generation === this.generation && this.run) {
            this.run.needsReconcile = true;
            this.admission = null;
          }
          throw error;
        });
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

  private resumeBody(snapshot?: string) {
    return {
      ...this.body(),
      ...(this.run?.binding && this.run.bindingNonce
        ? {
            preparation: {
              nonce: this.run.bindingNonce,
              binding_json: canonicalActionBinding(this.run.binding),
            },
            ...(snapshot ? { resume_snapshot: snapshot } : {}),
          }
        : {}),
    };
  }

  private installContinuation(admission: Admission) {
    if (!this.run?.binding || !admission.continuation)
      throw Error(
        "The original encrypted selection is unavailable. Review the unfinished task.",
      );
    this.run.continuation = commandContinuation(
      admission.continuation,
      this.run.binding,
    );
    this.run.continuationSnapshot = admission.continuation.snapshot;
  }

  private async rememberCompletedResources(generation: number): Promise<void> {
    const run = this.run;
    if (!run) return;
    const through = run.checkpoint.next_step;
    const previous = run.observedResourceThrough || 0;
    if (through <= previous) return;
    run.observedResourceThrough = through;
    if (
      !run.plan.steps
        .slice(previous, through)
        .some(
          (step) =>
            "action_id" in step &&
            getKaiActionById(step.action_id)?.command?.backend_binding,
        )
    )
      return;
    try {
      const result = await this.request<{
        observations?: LocationObservation[];
      }>(`action-proposals/${run.checkpoint.command_id}`, undefined, "GET");
      this.check(generation);
      if (this.run === run) this.remember(result.observations);
    } catch {
      // An optional current label read cannot turn a verified effect into a
      // failure. Missing context means the next request must resolve it again.
      this.check(generation);
    }
  }

  private async advance(generation: number, resuming = false): Promise<void> {
    this.requireFreshCheckpoint();
    const attemptedNavigation = new Set<string>();
    // The bounded plan plus server step identities prevents accidental loops.
    for (let turns = 0; turns < 25 && this.run; turns++) {
      this.check(generation);
      await this.rememberCompletedResources(generation);
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
      if (
        this.run.needsReconcile ||
        (this.run.continuation && !this.run.continuationSnapshot)
      ) {
        const inspected = await this.request<Admission>(
          `action-proposals/${this.run.checkpoint.command_id}/resume`,
          this.resumeBody(),
        );
        this.check(generation);
        this.run.needsReconcile = false;
        if (inspected.status === "resume_preparation_required")
          this.installContinuation(inspected);
        else if (inspected.status === "advanced" && inspected.checkpoint) {
          this.run.checkpoint = inspected.checkpoint;
          this.clearBinding();
          continue;
        } else if (inspected.status === "reconcile") {
          this.admission = inspected;
          this.show({
            phase: "gate",
            message:
              "Review this operation before continuing. Its outcome is uncertain.",
            gate: {
              kind: "navigation",
              message: "Review the existing operation.",
              route: inspected.review_route,
            },
          });
          return;
        }
      }
      const preparingStep = this.run.plan.steps[this.run.checkpoint.next_step];
      if (preparingStep && "workflow_id" in preparingStep) {
        const admitted = await this.request<Admission>(
          `action-proposals/${this.run.checkpoint.command_id}/${resuming ? "resume" : "admit"}`,
          this.body(),
        );
        this.check(generation);
        resuming = false;
        if (admitted.status === "advanced" && admitted.checkpoint) {
          this.run.checkpoint = admitted.checkpoint;
          this.run.workflow = undefined;
          this.ports.pauseWorkflow?.();
          await this.ports.reconcile?.();
          this.check(generation);
          continue;
        }
        if (admitted.status === "workflow") {
          await this.presentWorkflow(admitted, generation);
          return;
        }
        if (admitted.status !== "ready")
          throw new Error(
            admitted.gate?.message ||
              "Location setup is not ready. Retry or cancel this task.",
          );
        const result = await this.request<Admission>(
          `action-proposals/${this.run.checkpoint.command_id}/execute`,
          this.body(),
        );
        this.check(generation);
        if (result.status === "advanced" && result.checkpoint) {
          this.run.checkpoint = result.checkpoint;
          await this.ports.reconcile?.();
          this.check(generation);
          continue;
        }
        if (result.status === "recovery_required" && result.checkpoint) {
          this.run = null;
          this.ports.pauseWorkflow?.();
          this.show({
            phase: "recovery",
            message: "Resume your existing Location setup task.",
            recoverable: [result.checkpoint],
          });
          return;
        }
        await this.presentWorkflow(result, generation);
        return;
      }
      const preparingAction =
        preparingStep && getKaiActionById(preparingStep.action_id);
      const resources: LocalActionResources = {};
      for (const reference of preparingStep?.references || []) {
        const observed = this.run.observations?.find(
          (item) => item.reference === reference.reference,
        );
        if (
          !observed ||
          !["person", "circle", "place"].includes(observed.kind) ||
          preparingAction?.command?.resource_inputs?.[reference.slot] !==
            observed.kind
        ) {
          throw new Error(
            "That earlier result is no longer available. Choose it again.",
          );
        }
        resources[reference.slot] = [
          {
            kind: observed.kind as "person" | "circle" | "place",
            id: observed.id,
          },
        ];
      }
      if (preparingStep?.dependencies?.length) {
        const receipts = await this.request<{
          results: Array<{
            step: number;
            operation_id: string;
            kind: "circle";
            id: string;
          }>;
        }>(
          `action-proposals/${this.run.checkpoint.command_id}`,
          undefined,
          "GET",
        );
        this.check(generation);
        for (const dependency of preparingStep.dependencies) {
          const receipt = receipts.results?.find(
            (item) => item.step === dependency.source_step,
          );
          if (
            !receipt ||
            dependency.source_step >= this.run.checkpoint.next_step ||
            preparingAction?.command?.resource_inputs?.[dependency.slot] !==
              receipt.kind
          ) {
            throw new Error(
              "The earlier operation has no verified resource result. Review it before continuing.",
            );
          }
          resources[dependency.slot] = [
            {
              kind: receipt.kind,
              id: receipt.id,
              sourceStep: receipt.step,
              operationId: receipt.operation_id,
            },
          ];
        }
      }
      this.run.resolvedResources = Object.keys(resources).length
        ? resources
        : undefined;
      this.preferScreen = false;
      this.preparedSummary = "";
      this.preparedScreenSummary = "";
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
          this.run.resolvedResources,
          this.run.continuation,
          this.run.privateContinuation,
        );
        if (!preparation && preparingAction.command?.review_route) {
          await this.ports.navigate(
            preparingAction.command.review_route,
            preparingStep!.action_id,
          );
          this.check(generation);
          preparation = await prepareLocalOnboardingAction(
            preparingStep!.action_id,
            preparingStep!.slots,
            this.run.chosenResourceId,
            this.run.resolvedResources,
            this.run.continuation,
            this.run.privateContinuation,
          );
        }
        this.check(generation);
        if (preparation?.status === "blocked") {
          if (
            preparation.resolvedChoiceId &&
            preparation.resolvedChoiceId !== this.run.chosenResourceId
          ) {
            this.run.chosenResourceId = preparation.resolvedChoiceId;
            await this.checkpoint();
            this.check(generation);
          }
          this.admission = null;
          this.permissionGate = preparation.gate === "permission";
          this.localGate = {
            kind: preparation.gate,
            message: preparation.summary,
            route: preparation.route,
            waitForUser: preparation.waitForUser,
            choices: preparation.choices,
          };
          this.show({
            phase: "gate",
            message: preparation.summary,
            gate: this.localGate,
          });
          return;
        }
        if (preparation?.status === "simulate") {
          this.preparedSummary = preparation.summary;
          this.preparedScreenSummary = preparation.summary;
          this.preferScreen = true;
        } else if (preparation?.status === "ready") {
          this.preparedSummary = preparation.summary;
          const bindingChanged =
            canonicalActionBinding(this.run.binding) !==
            canonicalActionBinding(preparation.binding);
          if (
            bindingChanged ||
            canonicalActionBinding(this.run.privateContinuation) !==
              canonicalActionBinding(preparation.privateContinuation)
          ) {
            this.run.binding = preparation.binding;
            this.run.privateContinuation = preparation.privateContinuation;
            // Updating the private recovery capsule does not replace an
            // unchanged reviewed binding or its remaining-operation authority.
            if (bindingChanged) this.run.bindingNonce = undefined;
            await this.checkpoint();
            this.check(generation);
          }
        } else this.preferScreen = true;
      }
      const admissionBody = this.run.continuation
        ? this.resumeBody(this.run.continuationSnapshot)
        : this.body();
      if (this.run.continuation) {
        // Renewal can commit even if its response is lost. Consume the local
        // snapshot before dispatch and inspect the ledger before any retry.
        this.run.continuationSnapshot = undefined;
        this.run.needsReconcile = true;
      }
      const response = await this.request<Admission>(
        `action-proposals/${this.run.checkpoint.command_id}/${resuming || this.run.continuation ? "resume" : "admit"}`,
        admissionBody,
      );
      resuming = false;
      this.check(generation);
      this.run.needsReconcile = false;
      this.admission = response;
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
          const route = admission.gate.route;
          if (attemptedNavigation.has(route)) {
            this.show({
              phase: "gate",
              message:
                "Location opened, but this action is not ready. Retry after the screen finishes loading.",
              gate: {
                kind: "unavailable",
                message: "Retry or cancel this task.",
              },
            });
            return;
          }
          attemptedNavigation.add(route);
          const opened = await this.ports.navigate(route);
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
      if (!currentStep || "workflow_id" in currentStep)
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
    if (!step || "workflow_id" in step)
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
        run.resolvedResources,
        run.continuation,
        run.privateContinuation,
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
    // A lost claim response can still mean the server consumed the attempt.
    // Reconcile before another preparation can change the original binding.
    run.needsReconcile = true;
    const claim = await this.request<
      Directive & {
        execution_receipt: string;
        effect: "screen" | "action";
        route?: string;
      }
    >(`action-proposals/${run.checkpoint.command_id}/claim`, {
      ...this.body(),
      ...(step.action_id === "location.add_to_circle" &&
      !this.preferScreen &&
      run.binding
        ? {
            membership_preparation: {
              nonce: run.bindingNonce,
              binding_json: canonicalActionBinding(run.binding),
            },
          }
        : {}),
      ...(action?.command?.client_receipt && !this.preferScreen && run.binding
        ? {
            effect_preparation: {
              nonce: run.bindingNonce,
              binding_json: canonicalActionBinding(run.binding),
            },
          }
        : {}),
      confirmation_receipt: confirmationReceipt,
    });
    this.check(generation);
    if (run.continuation && claim.operation_id !== run.continuation.operationId)
      throw Error(
        "The resumed operation identity changed. Refresh its receipts before continuing.",
      );
    this.show({
      phase: "working",
      message:
        claim.effect === "screen"
          ? "Opening Location…"
          : "Running the Location action…",
    });
    // No abort races once a handler starts: a timeout cannot prove an effect failed.
    let result: Pick<
      AgentActionRuntimeResult,
      "status" | "resultSummary" | "data"
    >;
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
          privateContinuation: run.privateContinuation,
          chosenResourceId: run.chosenResourceId,
          resolvedResources: run.resolvedResources,
          confirmedAt: new Date().toISOString(),
          continuation: run.continuation,
        },
        this.abort.signal,
      );
    }
    let status =
      claim.effect !== "screen" &&
      (result.status === "succeeded" || result.status === "noop")
        ? "succeeded"
        : "review_required";
    const settled = await this.request<{
      checkpoint: CommandCheckpoint;
      settlement_status?: string;
      verified_membership_result?: boolean;
      verified_effect_result?: boolean;
      resume_required?: boolean;
    }>(`action-proposals/${run.checkpoint.command_id}/settle`, {
      step: index,
      operation_id: claim.operation_id,
      execution_receipt: claim.execution_receipt,
      status,
    });
    this.check(generation);
    run.checkpoint = settled.checkpoint;
    if (settled.resume_required) {
      this.run = null;
      this.show({
        phase: "recovery",
        message: `${result.resultSummary} Resume the unfinished part after reviewing current state.`,
        recoverable: [settled.checkpoint],
      });
      return;
    }
    if (
      settled.checkpoint.status !== "cancelled" &&
      status === "succeeded" &&
      Array.isArray(result.data?.command_observations)
    ) {
      this.remember(
        result.data.command_observations,
        step.action_id === "location.nearby_check_in",
      );
    }
    if (
      (settled.verified_membership_result || settled.verified_effect_result) &&
      settled.settlement_status === "succeeded"
    ) {
      status = "succeeded";
      if (result.status !== "succeeded" && result.status !== "noop")
        result = {
          status: "succeeded",
          resultSummary: settled.verified_membership_result
            ? "Circle membership completed and verified by Location."
            : "Operation completed and verified by Location.",
        };
    }
    run.binding = undefined;
    run.privateContinuation = undefined;
    run.bindingDigest = undefined;
    run.bindingNonce = undefined;
    run.chosenResourceId = undefined;
    run.resolvedResources = undefined;
    run.continuation = undefined;
    run.continuationSnapshot = undefined;
    run.needsReconcile = false;
    if (status !== "succeeded" || run.checkpoint.status === "completed") {
      this.run = null;
      const setupComplete =
        status === "succeeded" &&
        run.checkpoint.status === "completed" &&
        run.plan.steps.some((step) => "workflow_id" in step);
      // The final action's authored settlement destination also applies when
      // its owner was already mounted. Navigation is presentation, after the
      // authoritative settlement; failure must never replay the operation.
      const completionRoute = setupComplete
        ? action?.goal?.workflow_steps?.find(
            (item) =>
              item.type === "action" && item.action_id === step.action_id,
          )?.settlement_target?.route
        : undefined;
      let destinationOpened = true;
      if (completionRoute) {
        destinationOpened = await this.ports
          .navigate(completionRoute)
          .catch(() => false);
        this.check(generation);
      }
      this.show({
        phase: "result",
        message:
          claim.effect === "screen" && result.status === "succeeded"
            ? this.preparedScreenSummary ||
              "Location screen opened. Continue the operation there."
            : setupComplete
              ? `Location setup complete. ${result.resultSummary || "Location is on."}${destinationOpened ? "" : " Open Location to view the hub."}`
              : result.resultSummary,
      });
    } else if (
      Array.isArray(result.data?.command_observations) &&
      result.data.command_observations.length
    ) {
      await this.reassess(
        "The requested lookup completed. Continue the remaining original task using its actual observed results. Earlier steps are complete and must not be repeated.",
        generation,
      );
    }
  }

  private clearBinding() {
    if (!this.run) return;
    this.run.binding = undefined;
    this.run.privateContinuation = undefined;
    this.run.bindingDigest = undefined;
    this.run.bindingNonce = undefined;
    this.run.chosenResourceId = undefined;
    this.run.resolvedResources = undefined;
    this.run.continuation = undefined;
    this.run.continuationSnapshot = undefined;
    this.run.needsReconcile = false;
  }

  private async presentWorkflow(admission: Admission, generation: number) {
    const result = parseLocationOnboardingRunResult(admission.workflow);
    const run = this.run;
    const binding = result?.run.commandBinding;
    if (
      !run ||
      !result ||
      !binding ||
      !this.ports.presentWorkflow ||
      binding.commandId !== run.checkpoint.command_id ||
      binding.commandStep !== run.checkpoint.next_step
    ) {
      throw new Error(
        "The Location workflow did not return its command binding. Refresh to reconcile this task.",
      );
    }
    if (
      run.workflow &&
      (run.workflow.authority.run_id !== result.run.runId ||
        run.workflow.authority.operation_id !== binding.operationId)
    ) {
      throw new Error(
        "The Location workflow changed. Review the existing task.",
      );
    }
    if (admission.checkpoint) run.checkpoint = admission.checkpoint;
    run.workflow ||= {
      authority: {
        command_id: binding.commandId,
        command_step: binding.commandStep,
        operation_id: binding.operationId,
        workflow_id: "workflow.setup.location",
        run_id: result.run.runId,
      },
    };
    if (
      admission.workflow_finalize_renewed === true &&
      result.run.pendingDirective?.contractId ===
        "one.location.awaiting_vault_finalize.v2" &&
      result.run.pkmFinalizeAuthorization &&
      !result.run.evidence.place
    ) {
      // The server has fenced every older attempt under the writer's run lock.
      // Keep the same encrypted draft; only the acknowledged new attempt may run.
      run.workflow.commitDispatched = false;
    }
    await this.checkpoint();
    this.check(generation);
    this.show({ phase: "gate", message: "Completing Location setup…" });
    this.ports.presentWorkflow(result);
  }

  /** Sensitive continuation stays in the existing owner-vault capsule. */
  activeGeneration(): number {
    return this.generation;
  }

  isWorkflowActive(runId: string, generation = this.generation): boolean {
    return Boolean(
      generation === this.generation &&
      this.ports.authority() &&
      this.run?.workflow?.authority.run_id === runId,
    );
  }

  reviewWorkflowSave(runId: string): void {
    if (!this.isWorkflowActive(runId)) return;
    this.ports.pauseWorkflow?.();
    this.localGate = null;
    this.admission = null;
    this.show({
      phase: "gate",
      message:
        "The save outcome could not be verified. Resume to check the saved task and safely continue.",
      gate: { kind: "unavailable", message: "Resume Location setup" },
    });
  }

  async stageWorkflowDraft(
    runId: string,
    revision: number,
    draft: OneLocationPreVaultDraft,
  ): Promise<OneLocationPreVaultDraftMetadataV1> {
    const run = this.run;
    const workflow = run?.workflow;
    const generation = this.generation;
    if (!run || !workflow || workflow.authority.run_id !== runId)
      throw new Error("Resume this Location command before saving.");
    if (workflow.draft) {
      if (workflow.draft.metadata.revision !== revision) {
        workflow.draft.metadata = { ...workflow.draft.metadata, revision };
        await this.checkpoint();
        this.check(generation);
      }
      return workflow.draft.metadata;
    }
    const sealed = await encryptData(
      JSON.stringify(draft),
      this.authority().vaultKey,
    );
    this.check(generation);
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(sealed)),
    );
    this.check(generation);
    const metadata: OneLocationPreVaultDraftMetadataV1 = {
      schemaVersion: "one.location.pre_vault.draft_metadata.v1",
      status: "staged",
      runId,
      revision,
      digest: Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
      expiresAt: run.checkpoint.expires_at,
    };
    workflow.draft = { sealed, metadata };
    await this.checkpoint();
    this.check(generation);
    return metadata;
  }

  async readWorkflowDraft(runId: string) {
    const workflow = this.run?.workflow;
    const generation = this.generation;
    if (!workflow || workflow.authority.run_id !== runId || !workflow.draft)
      return null;
    if (Date.parse(workflow.draft.metadata.expiresAt) <= Date.now())
      throw new Error(
        "This Location draft expired. Cancel and start setup again.",
      );
    const draft = JSON.parse(
      await decryptData(workflow.draft.sealed, this.authority().vaultKey),
    ) as OneLocationPreVaultDraft;
    this.check(generation);
    return {
      draft,
      metadata: workflow.draft.metadata,
      authority: workflow.authority,
      commitDispatched: workflow.commitDispatched === true,
    };
  }

  async markWorkflowCommitDispatched(runId: string, dispatched = true) {
    const workflow = this.run?.workflow;
    const generation = this.generation;
    if (!workflow || workflow.authority.run_id !== runId)
      throw new Error("This Location task is no longer active.");
    workflow.commitDispatched = dispatched;
    await this.checkpoint();
    this.check(generation);
  }

  async clearWorkflowDraft(runId: string) {
    const workflow = this.run?.workflow;
    if (!workflow || workflow.authority.run_id !== runId) return;
    workflow.draft = undefined;
    workflow.commitDispatched = undefined;
    await this.checkpoint();
  }

  async cancel(checkpoint?: CommandCheckpoint): Promise<void> {
    const current = checkpoint || this.run?.checkpoint;
    const owner = this.authority().userId;
    if (current)
      this.pendingCancellation = { commandId: current.command_id, owner };
    const pending = this.pendingCancellation;
    if (pending && pending.owner !== owner)
      throw new Error("Unlock the original account to cancel this task.");
    const generation = ++this.generation;
    this.abort.abort();
    this.cancelTranscription();
    this.ports.pauseWorkflow?.();
    this.run = null;
    this.admission = null;
    this.transcript = "";
    this.permissionGate = false;
    this.grantedPermission = false;
    this.localGate = null;
    if (pending) {
      let result: { checkpoint: CommandCheckpoint } | undefined;
      try {
        result = await this.request<{ checkpoint: CommandCheckpoint }>(
          `action-proposals/${pending.commandId}`,
          undefined,
          "DELETE",
        );
      } catch (error) {
        if (!(error instanceof CommandRequestError && error.status === 404))
          throw error;
        // The owner-scoped endpoint confirms there is no unfinished task,
        // including after the 24-hour capsule expiry. Never revive it.
      }
      if (
        result &&
        !["cancelled", "completed", "expired", "review_required"].includes(
          result.checkpoint.status,
        )
      )
        throw new Error(
          "Cancellation is not confirmed. Retry Cancel or refresh its status.",
        );
      if (this.pendingCancellation === pending) this.pendingCancellation = null;
    }
    if (generation === this.generation)
      this.show({ phase: "idle", message: "" });
  }

  async refresh(): Promise<void> {
    const checkpoint = this.run?.checkpoint;
    if (this.busy) return;
    if (this.pendingCancellation) {
      await this.cancel();
      return;
    }
    this.pause();
    if (checkpoint) await this.resume(checkpoint);
    else await this.recover();
  }

  pause(): void {
    this.generation++;
    this.abort.abort();
    this.cancelTranscription();
    this.ports.pauseWorkflow?.();
    this.run = null;
    this.pendingCancellation = null;
    this.admission = null;
    this.localGate = null;
    this.transcript = "";
    this.permissionGate = false;
    this.grantedPermission = false;
    this.show({ phase: "idle", message: "" });
  }
}
