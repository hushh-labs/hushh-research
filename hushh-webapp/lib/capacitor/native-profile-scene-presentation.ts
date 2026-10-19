import type { PluginListenerHandle } from "@capacitor/core";
import { nativeDrawerAcknowledged as acknowledged, reconcileNativeDrawerIsolation,
  retainNativeDrawerIsolation, sameNativeDrawer, subscribeNativeDrawerIsolation,
  type HushhNativeDrawersPlugin } from "./native-drawers";
import { NativeProfileSceneFence, type NativeProfileSceneAction, type NativeProfileSceneEdit,
  type NativeProfileSceneIdentity, type NativeProfileSceneState } from "./native-profile-scene-fence";

export type NativeProfileSceneReceipt = NativeProfileSceneIdentity & {
  updateSequence: number; privacyGeneration: number; phase: "active" | "retired";
};
export type NativeProfileScenePort<P, E, A> = {
  source: HushhNativeDrawersPlugin;
  apply: (state: P) => Promise<NativeProfileSceneReceipt>;
  confirm: (action: A) => Promise<{ valid: boolean }>;
  settle: (action: A, saved?: boolean) => Promise<{ valid: boolean }>;
  retire: (identity: NativeProfileSceneIdentity) => Promise<NativeProfileSceneReceipt>;
  edits: (callback: (event: E) => void) => Promise<PluginListenerHandle>;
  choices: (callback: (event: A) => void) => Promise<PluginListenerHandle>;
};
export type NativeProfileSceneActions<E, A, T> = {
  edit: (event: E) => void;
  commit: (event: A) => Promise<{ kind: "saved"; value: T } | { kind: "retained" }>;
  saved: (value: T) => void;
  cancel: () => void;
};

/** Private presentation lifetime only. Closed scene schemas and feature
 * callbacks retain meaning and operations; no routing or persistence is added. */
export class NativeProfileScenePresentation<P extends NativeProfileSceneState,
  E extends NativeProfileSceneEdit, A extends NativeProfileSceneAction, T> {
  private current: { state: P; actions: NativeProfileSceneActions<E, A, T> } | null = null;
  private pending: P | null = null;
  private inFlight: Promise<void> | null = null;
  private handles: PluginListenerHandle[] = [];
  private isolation: PluginListenerHandle | null = null;
  private highestUpdate = 0;
  private seenAction = 0;
  private disposed = false;
  private listening = false;
  private ready = false;
  private withdrawal: Promise<boolean> | null = null;
  constructor(readonly identity: NativeProfileSceneIdentity,
    private readonly port: NativeProfileScenePort<P, E, A>,
    private readonly fence: NativeProfileSceneFence<P, E, A>,
    private readonly validState: (state: P) => boolean,
    private readonly ownerIsCurrent: () => boolean,
    private readonly onPhase: (phase: "active" | "blocked" | "fallback") => void,
    private readonly closeOnSaved = true,
    private readonly copyState: (state: P) => P = state => ({ ...state })) {}

  async listen(): Promise<boolean> {
    if (this.disposed || this.listening) return false;
    this.listening = true;
    try {
      if (!await this.installListener(this.port.edits(event => this.edit(event)))) return false;
      if (!await this.installListener(this.port.choices(event => { void this.choose(event); }))) return false;
      if (!await this.installListener(subscribeNativeDrawerIsolation(this.port.source), true)) return false;
      this.ready = true;
      return true;
    } catch { await this.fail(); return false; }
  }
  private async installListener(pending: Promise<PluginListenerHandle>, isolation = false): Promise<boolean> {
    let removed = false;
    const remove = (handle: PluginListenerHandle) => {
      if (removed) return;
      removed = true;
      void handle.remove().catch(() => undefined);
    };
    void pending.then(handle => { if (this.disposed) remove(handle); }).catch(() => undefined);
    const handle = await acknowledged(pending);
    if (this.disposed) { remove(handle); return false; }
    if (isolation) this.isolation = handle;
    else this.handles.push(handle);
    return true;
  }
  publish(state: P, actions: NativeProfileSceneActions<E, A, T>): boolean {
    if (this.disposed || !this.ready) return false;
    if (!this.ownerIsCurrent() || !this.validState(state)) { void this.fail(); return false; }
    if (!this.fence.update(state)) return false; // A stale echo is not a renderer failure.
    const snapshot = this.copyState(state);
    this.current = { state: snapshot, actions: { ...actions } };
    this.highestUpdate = state.updateSequence;
    this.pending = snapshot;
    this.pump();
    return true;
  }
  refreshActions(actions: NativeProfileSceneActions<E, A, T>): void {
    if (!this.disposed && this.current && this.ownerIsCurrent()) this.current.actions = { ...actions };
  }
  private pump(): void {
    if (this.disposed || this.inFlight || !this.pending) return;
    this.inFlight = this.drain().finally(() => { this.inFlight = null; this.pump(); });
  }
  private async drain(): Promise<void> {
    while (this.pending && !this.disposed) {
      const state = this.pending;
      this.pending = null;
      try {
        const receipt = await acknowledged(this.port.apply(state));
        if (this.disposed) return;
        if (!receipt || !sameNativeDrawer(receipt, state) || receipt.scene !== state.scene || receipt.destinationId !== state.destinationId ||
            receipt.phase !== "active" || receipt.updateSequence !== state.updateSequence ||
            receipt.privacyGeneration !== state.privacyGeneration || !this.ownerIsCurrent()) { await this.fail(); return; }
        if (this.current?.state.updateSequence === state.updateSequence) this.onPhase("active");
      } catch { await this.fail(); return; }
    }
  }
  private edit(event: E): void {
    if (this.disposed || !this.ownerIsCurrent() || !this.current || !this.fence.consumeEdit(event)) return;
    try { this.current.actions.edit(event); } catch { void this.fail(); }
  }
  private async choose(event: A): Promise<void> {
    if (this.disposed || !this.ownerIsCurrent() || !event || !sameNativeDrawer(event, this.identity) ||
        event.scene !== this.identity.scene || !Number.isSafeInteger(event.sequence) || event.sequence <= this.seenAction) return;
    this.seenAction = event.sequence;
    if (!this.fence.allows(event)) { await this.reject(event); return; }
    await this.inFlight;
    const current = this.current;
    if (this.disposed || !current) return;
    if (!this.fence.allows(event)) { await this.reject(event); return; }
    try {
      const accepted = await this.fence.consumeAction(event, () => acknowledged(this.port.confirm(event)),
        () => !this.disposed && (event.action === "cancel" || this.current === current) && this.ownerIsCurrent());
      if (!accepted) { await acknowledged(this.port.settle(event)); return; }
      if (event.action === "cancel") {
        if (await this.retire() && this.ownerIsCurrent()) current.actions.cancel();
        return;
      }
      const result = await current.actions.commit(event);
      if (this.disposed || !this.ownerIsCurrent()) return;
      if (result.kind === "saved" && this.closeOnSaved) {
        if (await this.retire() && this.ownerIsCurrent()) current.actions.saved(result.value);
        return;
      }
      if (!(await acknowledged(this.port.settle(event, result.kind === "saved"))).valid) { await this.fail(); return; }
      if (result.kind === "saved" && this.ownerIsCurrent()) current.actions.saved(result.value);
    } catch { await this.fail(); }
  }
  private async reject(event: A): Promise<void> {
    if (this.disposed || !this.current || event.privacyGeneration !== this.current.state.privacyGeneration) return;
    try { if (!(await acknowledged(this.port.settle(event))).valid) await this.fail(); }
    catch { await this.fail(); }
  }
  private async fail(): Promise<void> {
    if (this.disposed) return;
    this.onPhase("blocked");
    if (await this.retire() && this.ownerIsCurrent()) this.onPhase("fallback");
  }
  retire(): Promise<boolean> { return this.withdrawal ??= this.withdraw(); }
  private async withdraw(): Promise<boolean> {
    this.disposed = true;
    this.ready = false;
    this.fence.retire();
    this.pending = null;
    this.current = null;
    for (const handle of this.handles) void handle.remove().catch(() => undefined);
    this.handles = [];
    const isolation = this.isolation;
    this.isolation = null;
    let retired = false;
    try {
      const receipt = await acknowledged(this.port.retire(this.identity));
      retired = !!receipt && sameNativeDrawer(receipt, this.identity) && receipt.scene === this.identity.scene && receipt.destinationId === this.identity.destinationId &&
        receipt.phase === "retired" && Number.isSafeInteger(receipt.updateSequence) &&
        receipt.updateSequence >= 0 && receipt.updateSequence <= this.highestUpdate;
      if (retired) await acknowledged(reconcileNativeDrawerIsolation(this.port.source));
      return retired;
    } catch { return false; }
    finally {
      if (isolation) {
        if (retired) void isolation.remove().catch(() => undefined);
        else retainNativeDrawerIsolation(this.port.source, isolation);
      }
    }
  }
}
