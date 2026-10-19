import type { PluginListenerHandle } from "@capacitor/core";
import { nativeLegalActionIds } from "./native-profile-legal";
import { acknowledgeNativeProfilePreparation } from "./native-profile-preparation";
import {
  NativeDrawerChoiceFence, sameNativeDrawer, validNativeDrawerProjection,
  subscribeNativeDrawerIsolation, reconcileNativeDrawerIsolation, retainNativeDrawerIsolation,
  nativeDrawerAcknowledged as acknowledged,
  nativeWorkspaceRetirementBarrier,
  type HushhNativeDrawersPlugin, type NativeDrawerChoice, type NativeDrawerIdentity,
  type NativeDrawerProjection, type NativeDrawerReceipt,
  type NativeDrawerReadmission, type NativeDrawerPresentationState,
} from "./native-drawers";

export type NativeDrawerActions = {
  rows: ReadonlyMap<string, (choice: NativeDrawerChoice) => void | Promise<void>>;
  open: () => void;
  close: () => void | boolean;
  back?: () => void | boolean;
  root?: () => void | boolean;
  ancestor?: (choice: NativeDrawerChoice) => void | boolean;
};
export type NativeDrawerPresentationPhase = "preparing" | "active" | "quarantined" | "retired";

function receiptMatches(receipt: NativeDrawerReceipt, state: NativeDrawerProjection, phase: "active" | "retired") {
  return receipt && sameNativeDrawer(receipt, state) && receipt.phase === phase &&
    receipt.updateSequence === state.updateSequence && receipt.privacyGeneration === state.privacyGeneration;
}

function profileDestinationKey(state: NativeDrawerProjection): string {
  if (state.profileSupportDestinationId !== undefined) return `support:${state.profileSupportDestinationId}`;
  if (state.profileDestinationId !== undefined) return `page:${state.profileDestinationId}`;
  return "root";
}

/** One volatile presentation replica, not a feature controller. Authored row
 * handles call the current React owner only after both sides validate a choice.
 * No private projection is logged, persisted, or retained in an event queue. */
export class NativeDrawerPresentation {
  private readonly fence: NativeDrawerChoiceFence;
  private current: { state: NativeDrawerProjection; actions: NativeDrawerActions } | null = null;
  private pending: NativeDrawerProjection | null = null;
  private inFlight: Promise<void> | null = null;
  private handle: PluginListenerHandle | null = null;
  private isolationHandle: PluginListenerHandle | null = null;
  private readmissionHandle: PluginListenerHandle | null = null;
  private completionHandle: PluginListenerHandle | null = null;
  private completionRequired = false;
  private settledUpdate = 0;
  private presentedUpdate = 0;
  private readmissionGeneration = 0;
  private listening = false;
  private backSettlements = false;
  private closeSettlements = false;
  private disposed = false;
  private applied = 0;
  private latestReceipt: NativeDrawerReceipt | null = null;
  private highestUpdate = 0;
  private readonly destinations = new Map<number, string>();
  private seenChoice = 0;
  private withdrawal: Promise<boolean> | null = null;
  private phase: NativeDrawerPresentationPhase = "preparing";

  constructor(
    readonly identity: NativeDrawerIdentity,
    private readonly plugin: HushhNativeDrawersPlugin,
    private readonly ownerIsCurrent: () => boolean,
    private readonly onPhase: (phase: NativeDrawerPresentationPhase) => void,
    private readonly onApplied?: (state: NativeDrawerProjection) => void,
    private readonly onReadmission?: () => boolean,
    private readonly interactionIsCurrent: () => boolean = ownerIsCurrent,
  ) { this.fence = new NativeDrawerChoiceFence(identity); }

  async listen(): Promise<boolean> {
    if (this.disposed || this.listening) return false;
    this.listening = true;
    try {
      const capability = await acknowledged(this.plugin.getCapabilities());
      if (this.disposed) return false;
      if (capability.contractVersion !== 1 || !capability.supported || !capability.wholePresentation ||
          this.identity.family === "agent-profile" && capability.agentProfileMenu !== true) {
        await this.retire();
        return false; // No native body has been prepared; established web fallback is safe.
      }
      if (capability.terminalRefreshes === true) this.fence.enableTerminalRefreshes();
      if (capability.profileNavigationStack === true && capability.compatibleBackRefreshes === true) this.fence.enableCompatibleBackRefreshes();
      this.backSettlements = capability.profileNavigationStack === true && this.identity.family === "profile";
      this.closeSettlements = capability.closeSettlements === true;
      if (this.closeSettlements && !this.plugin.settleChoice) { await this.retire(); return false; }
      this.completionRequired = capability.presentationCompletion === true;
      if (this.completionRequired) {
        if (!this.plugin.getPresentationState) { this.quarantine(); return false; }
        const completion = await this.plugin.addListener("presentationSettled", event => this.acceptCompletion(event));
        if (this.disposed) { await completion.remove(); return false; }
        this.completionHandle = completion;
      }
      // Listener installation creates no view. If it arrives after retirement,
      // remove that exact handle rather than leaking a callback into next owner.
      const handle = await this.plugin.addListener("choice", event => { void this.choose(event); });
      if (this.disposed) { await handle.remove(); return false; }
      this.handle = handle;
      if (capability.terminalReadmission === true) {
        const readmission = await this.plugin.addListener("readmissionRequested", event => this.readmit(event));
        if (this.disposed) { await readmission.remove(); return false; }
        this.readmissionHandle = readmission;
      }
      const pendingIsolation = subscribeNativeDrawerIsolation(this.plugin);
      let isolationRemoved = false;
      const removeLateIsolation = (handle: PluginListenerHandle) => {
        if (isolationRemoved) return;
        isolationRemoved = true;
        void handle.remove().catch(() => undefined);
      };
      void pendingIsolation.then(handle => { if (this.disposed) removeLateIsolation(handle); }).catch(() => undefined);
      const isolation = await acknowledged(pendingIsolation);
      if (this.disposed) { removeLateIsolation(isolation); return false; }
      this.isolationHandle = isolation;
      return true;
    } catch {
      if (!this.disposed) this.quarantine();
      return false;
    }
  }

  publish(state: NativeDrawerProjection, actions: NativeDrawerActions): boolean {
    if (this.disposed || this.phase === "quarantined" || !this.handle || !this.isolationHandle) return false;
    if (!this.ownerIsCurrent() || !validNativeDrawerProjection(state) || !sameNativeDrawer(this.identity, state) ||
        [...state.sections, ...(state.profileStack?.flatMap(page => page.sections) ?? [])].some(section => section.rows.some(row => !row.readOnly && (row.options ? row.options.map(option => option.id) : [row.id, row.renameActionId, row.deleteActionId])
          .some(id => id !== undefined && !actions.rows.has(id)))) ||
        state.profileStack?.some(page => page.legalDocument && nativeLegalActionIds(page.legalDocument).some(id => !actions.rows.has(id))) ||
        state.profileStack?.some(page => page.memorySearch && !actions.rows.has(page.memorySearch.id)) ||
        state.backEnabled && !actions.back || (state.profileStack?.length ?? 0) > 1 && !actions.root ||
        (state.profileStack?.length === 3 && state.profileStack[0]?.id === "security" ||
          (state.profileStack?.length ?? 0) >= 3 && ["memory", "payouts", "connectors"].includes(state.profileStack?.[0]?.id ?? "")) && !actions.ancestor) { this.quarantine(); return false; }
    // Callers own their product state. Retain a bounded, immutable snapshot so
    // a later render cannot mutate a pending private projection in place.
    const snapshot: NativeDrawerProjection = { ...state,
      ...(state.profilePreparation ? { profilePreparation: { ...state.profilePreparation } } : {}),
      sections: state.sections.map(section => ({ ...section, rows: section.rows.map(row => ({ ...row,
        ...(row.progress ? { progress: { ...row.progress } } : {}),
        ...(row.options ? { options: row.options.map(option => ({ ...option })) } : {}) })) })),
      ...(state.profileStack ? { profileStack: state.profileStack.map(page => ({ ...page,
        ...(page.legalDocument ? { legalDocument: structuredClone(page.legalDocument) } : {}),
        ...(page.memorySearch ? { memorySearch: { ...page.memorySearch } } : {}),
        sections: page.sections.map(section => ({ ...section, rows: section.rows.map(row => ({ ...row,
          ...(row.progress ? { progress: { ...row.progress } } : {}),
          ...(row.options ? { options: row.options.map(option => ({ ...option })) } : {}) })) })) })) } : {}) };
    if (!this.fence.update(snapshot)) return false;
    this.current = { state: snapshot, actions: { ...actions, rows: new Map(actions.rows) } };
    this.highestUpdate = snapshot.updateSequence;
    this.destinations.set(snapshot.updateSequence, profileDestinationKey(snapshot));
    while (this.destinations.size > 128) this.destinations.delete(this.destinations.keys().next().value!);
    this.pending = snapshot;
    this.pump();
    return true;
  }

  refreshActions(actions: NativeDrawerActions): void {
    if (!this.disposed && this.current && this.ownerIsCurrent()) {
      this.current.actions = { ...actions, rows: new Map(actions.rows) };
    }
  }

  private readmit(event: NativeDrawerReadmission): void {
    const state = this.current?.state;
    if (this.disposed || !state || !sameNativeDrawer(event, this.identity) ||
        event.privacyGeneration !== state.privacyGeneration || event.updateSequence !== state.updateSequence ||
        !Number.isSafeInteger(event.interactionGeneration) || event.interactionGeneration <= this.readmissionGeneration ||
        event.interactionGeneration > Number.MAX_SAFE_INTEGER) return;
    this.readmissionGeneration = event.interactionGeneration;
    // Refresh presentation from the current feature. Never replay the timed-out
    // choice, retain an old callback, or grant authority from the native receipt.
    try { if (!this.ownerIsCurrent() || !this.onReadmission?.()) this.quarantine(); }
    catch { this.quarantine(); }
  }

  private pump() {
    if (this.inFlight || !this.pending || this.disposed || this.phase === "quarantined") return;
    this.inFlight = this.drain().finally(() => { this.inFlight = null; this.pump(); });
  }

  private acceptCompletion(event: NativeDrawerPresentationState): void {
    const state = this.current?.state;
    if (this.disposed || !state || !this.ownerIsCurrent() || event.settled !== true ||
        !receiptMatches(event, state, "active")) return;
    this.settledUpdate = state.updateSequence;
    this.notifyPresented();
  }

  private notifyPresented(): void {
    const state = this.current?.state;
    if (!state || this.disposed || !this.ownerIsCurrent() || this.applied !== state.updateSequence ||
        this.presentedUpdate >= state.updateSequence || this.completionRequired && this.settledUpdate !== state.updateSequence) return;
    this.presentedUpdate = state.updateSequence;
    this.onApplied?.(state);
  }

  private async readPresentation(state: NativeDrawerProjection): Promise<void> {
    try {
      const result = await acknowledged(this.plugin.getPresentationState!(this.identity));
      if (this.disposed || this.current?.state.updateSequence !== state.updateSequence) return;
      if (!result.valid || !receiptMatches(result, state, "active")) { this.quarantine(); return; }
      this.acceptCompletion(result);
    } catch {
      if (!this.disposed && this.current?.state.updateSequence === state.updateSequence) this.quarantine();
    }
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.disposed && this.phase !== "quarantined") {
      const state = this.pending;
      this.pending = null;
      try {
        const withdrawal = nativeWorkspaceRetirementBarrier();
        if (withdrawal) {
          if (!await acknowledged(withdrawal)) throw new Error("NATIVE_WORKSPACE_RETIRE_UNCONFIRMED");
          if (this.disposed) return;
          if (!this.ownerIsCurrent()) { this.quarantine(); return; }
          // A newer binding can arrive while UIKit finishes dismissal. Do not
          // install the superseded projection or replay an operation.
          if (this.current?.state.updateSequence !== state.updateSequence) continue;
        }
        const receipt = await acknowledged(this.plugin.apply(state));
        if (this.disposed) return;
        if (!receiptMatches(receipt, state, "active") || !this.ownerIsCurrent()) { this.quarantine(); return; }
        this.latestReceipt = receipt;
        if (this.current?.state.updateSequence === state.updateSequence) {
          acknowledgeNativeProfilePreparation(state);
          this.applied = state.updateSequence;
          this.setPhase("active");
          // Register completion before apply; a zero-duration transition may
          // finish before its receipt. Read back once to close that event race.
          this.notifyPresented();
          if (this.completionRequired) void this.readPresentation(state);
        }
      } catch {
        // Apply may have succeeded without a receipt. Never reveal a duplicate
        // web drawer or replay the request to resolve an uncertain delivery.
        if (!this.disposed) this.quarantine();
        return;
      }
    }
  }

  private async choose(event: NativeDrawerChoice): Promise<void> {
    if (!this.interactionIsCurrent()) return;
    if (!this.disposed && !this.ownerIsCurrent()) { this.quarantine(); return; }
    if (this.disposed || !this.current || event.sequence <= this.seenChoice) return;
    const terminal = event.action === "close" || event.action === "open";
    if (!this.fence.allows(event)) {
      if (event.action === "close" && this.closeSettlements && Number.isSafeInteger(event.sequence) &&
          sameNativeDrawer(event, this.identity) && event.updateSequence <= this.current.state.updateSequence) {
        this.seenChoice = event.sequence;
        await this.settle(event, false);
        return;
      }
      // Cancel the exact unconfirmed intent, never replay it against new rows.
      if ((event.action === "row" || (event.action === "back" || event.action === "root" || event.action === "ancestor") && this.backSettlements) && Number.isSafeInteger(event.sequence) && sameNativeDrawer(event, this.identity) && event.updateSequence < this.current.state.updateSequence) {
        this.seenChoice = event.sequence;
        await this.settle(event, false);
      }
      else if (this.fence.terminalIsCurrent(event)) this.quarantine();
      return;
    }
    this.seenChoice = event.sequence;
    // A choice can outrun its apply receipt. A compatible refresh may also
    // start after this await captures the previous drain (including null).
    // Follow the replacement drain before checking the current applied state;
    // never confirm against an unacknowledged projection or reject merely
    // because its dispatch began in that microtask gap.
    do { await this.inFlight; } while (this.inFlight && !this.disposed);
    const current = this.current;
    if (this.disposed || this.phase !== "active" || !current || this.applied !== current.state.updateSequence ||
        !this.fence.allows(event)) {
      if (!this.disposed && current && this.canSettle(event) && sameNativeDrawer(event, this.identity)) await this.settle(event, false);
      else if (!this.disposed && this.fence.terminalIsCurrent(event)) this.quarantine();
      return;
    }
    const action = event.action === "row" ? current.actions.rows.get(event.rowId ?? "") : current.actions[event.action];
    if (!action) return;
    const followsCurrentBinding = terminal || this.fence.backIsCurrent(event);
    let invoked = false;
    let operationAccepted = true;
    try {
      const accepted = await this.fence.consume(event, () => acknowledged(this.plugin.confirmChoice(event)),
        () => !this.disposed && this.phase === "active" && (followsCurrentBinding || this.current === current) && this.ownerIsCurrent() && this.interactionIsCurrent(),
        async () => {
          const owner = followsCurrentBinding ? this.current : current;
          const latest = event.action === "row" ? owner?.actions.rows.get(event.rowId ?? "") : owner?.actions[event.action];
          if (!latest) return;
          invoked = true;
          operationAccepted = await latest(event) !== false;
        });
      if (invoked) await this.settle(event, operationAccepted);
      else if (!accepted && this.canSettle(event)) await this.settle(event, false);
      if (!accepted && this.fence.terminalIsCurrent(event) && !(event.action === "close" && this.closeSettlements)) this.quarantine();
    } catch {
      if (invoked) await this.settle(event, false);
      if (!invoked && !this.disposed && (this.fence.terminalIsCurrent(event) || !terminal && this.current === current)) this.quarantine();
      // The owning feature reports operation failures. No raw provider error,
      // private text or automatic retry belongs in this presentation adapter.
    }
  }

  private canSettle(event: NativeDrawerChoice): boolean {
    return event.action === "row" || event.action === "close" && this.closeSettlements ||
      (event.action === "back" || event.action === "root" || event.action === "ancestor") && this.backSettlements && !!this.current?.state.profileStack;
  }

  private async settle(event: NativeDrawerChoice, success: boolean): Promise<void> {
    if (!this.canSettle(event) || !this.plugin.settleChoice || this.disposed || !this.ownerIsCurrent()) return;
    try {
      const result = await acknowledged(this.plugin.settleChoice({ ...this.identity,
        sequence: event.sequence, privacyGeneration: event.privacyGeneration, success }));
      if (!result.valid && !this.disposed && this.ownerIsCurrent() && !this.destinationWasSuperseded(event)) this.quarantine();
    } catch {
      // An uncertain completion retires the presentation; it never repeats the operation.
      if (!this.disposed && this.ownerIsCurrent() && !this.destinationWasSuperseded(event)) this.quarantine();
    }
  }

  private destinationWasSuperseded(event: NativeDrawerChoice): boolean {
    // A late Close receipt belongs to its original open/close lifetime, not a
    // newly reopened root that happens to have the same destination key.
    // Ignore that receipt; never quarantine or re-operate the new visit.
    if (event.action === "close" && this.closeSettlements && !this.fence.terminalLifetimeIsCurrent(event)) return true;
    return this.current?.state.profileStack !== undefined && this.destinations.has(event.updateSequence) &&
      this.destinations.get(event.updateSequence) !== profileDestinationKey(this.current.state);
  }

  private provesRetirement(receipt: NativeDrawerReceipt | null, highestUpdate: number): boolean {
    return !!receipt && sameNativeDrawer(receipt, this.identity) && receipt.phase === "retired" &&
      Number.isSafeInteger(receipt.updateSequence) && receipt.updateSequence >= 0 && receipt.updateSequence <= highestUpdate &&
      (!this.latestReceipt || receipt.updateSequence >= this.latestReceipt.updateSequence);
  }

  private async confirmedRetirement(highestUpdate: number): Promise<boolean> {
    try {
      if (this.provesRetirement(await acknowledged(this.plugin.retire(this.identity)), highestUpdate)) return true;
    } catch { /* An uncertain request does not authorize a repeated operation. */ }
    if (!this.completionRequired || !this.plugin.getPresentationState) return false;
    try {
      const state = await acknowledged(this.plugin.getPresentationState(this.identity));
      return state.valid && state.settled === true && this.provesRetirement(state, highestUpdate);
    } catch { return false; }
  }

  private setPhase(phase: NativeDrawerPresentationPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.onPhase(phase);
  }
  private quarantine() {
    if (this.disposed || this.phase === "retired") return;
    this.pending = null;
    this.current = null;
    this.fence.retire();
    // Withdrawal is a targeted presentation cleanup, not a repeated operation.
    // Unknown outcomes remain quarantined until actual native absence is proved.
    try { this.setPhase("quarantined"); } finally { void this.retire(); }
  }

  async retire(): Promise<boolean> {
    if (this.withdrawal) return this.withdrawal;
    this.withdrawal = this.withdraw();
    return this.withdrawal;
  }
  private async withdraw(): Promise<boolean> {
    this.disposed = true;
    this.fence.retire();
    this.destinations.clear();
    this.pending = null;
    const highestUpdate = this.highestUpdate;
    this.current = null; // Clear private bodies and feature callbacks immediately.
    const handle = this.handle;
    const isolationHandle = this.isolationHandle;
    const readmissionHandle = this.readmissionHandle;
    const completionHandle = this.completionHandle;
    this.handle = null;
    this.isolationHandle = null;
    this.readmissionHandle = null;
    this.completionHandle = null;
    // Listener cleanup may stall; it must not delay native privacy withdrawal.
    // A disposed callback cannot invoke an operation even if removal is late.
    if (handle) void acknowledged(handle.remove()).catch(() => undefined);
    if (readmissionHandle) void acknowledged(readmissionHandle.remove()).catch(() => undefined);
    if (completionHandle) void acknowledged(completionHandle.remove()).catch(() => undefined);
    // Keep public isolation metadata observable through withdrawal. Otherwise
    // the final uncover event may be missed and base controls stay blocked.
    // Native retirement tombstones this identity even before admission. Send
    // withdrawal immediately; a delayed apply cannot revive the private body.
    let reconciled = false;
    try {
      // A newer queued projection may have been withdrawn before dispatch.
      // Absence is proven by identity/retired phase, not its unapplied update.
      if (highestUpdate > 0 && !await this.confirmedRetirement(highestUpdate)) {
        this.setPhase("quarantined"); return false;
      }
      if (isolationHandle) await acknowledged(reconcileNativeDrawerIsolation(this.plugin));
      reconciled = true;
      this.latestReceipt = null;
      this.setPhase("retired");
      return true;
    } catch { this.setPhase("quarantined"); return false; }
    finally {
      if (isolationHandle) {
        if (reconciled) void acknowledged(isolationHandle.remove()).catch(() => undefined);
        else retainNativeDrawerIsolation(this.plugin, isolationHandle);
      }
    }
  }
}
