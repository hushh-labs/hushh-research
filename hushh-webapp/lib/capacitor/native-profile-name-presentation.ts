import type { PluginListenerHandle } from "@capacitor/core";
import {
  nativeDrawerAcknowledged as acknowledged,
  reconcileNativeDrawerIsolation, retainNativeDrawerIsolation, sameNativeDrawer,
  subscribeNativeDrawerIsolation, type HushhNativeDrawersPlugin,
} from "./native-drawers";
import {
  NativeProfileNameFence, validNativeProfileNameProjection,
  type NativeProfileNameAction, type NativeProfileNameEdit, type NativeProfileNameIdentity,
  type NativeProfileNameProjection, type NativeProfileNameScenePort,
} from "./native-profile-name-scene";

export type NativeProfileNameActions<T> = {
  edit: (text: string, composing: boolean, revision: number) => void;
  save: () => Promise<{ kind: "saved"; value: T } | { kind: "retained" }>;
  saved: (value: T) => void;
  cancel: () => void;
};
type Plugin = HushhNativeDrawersPlugin & NativeProfileNameScenePort;
export function hasNativeProfileNameScene(plugin: HushhNativeDrawersPlugin): plugin is Plugin {
  return [plugin.applyProfileNameScene, plugin.confirmProfileNameAction, plugin.settleProfileNameAction,
    plugin.retireProfileNameScene].every(method => typeof method === "function");
}

/** One complete private presentation; no transport, persistence or form policy.
 * Retirement is receipt-confirmed before revealing the established web form. */
export class NativeProfileNamePresentation<T> {
  private readonly fence: NativeProfileNameFence;
  private current: { state: NativeProfileNameProjection; actions: NativeProfileNameActions<T> } | null = null;
  private pending: NativeProfileNameProjection | null = null;
  private inFlight: Promise<void> | null = null;
  private handles: PluginListenerHandle[] = [];
  private isolation: PluginListenerHandle | null = null;
  private highestUpdate = 0;
  private seenAction = 0;
  private disposed = false;
  private listening = false;
  private ready = false;
  private withdrawal: Promise<boolean> | null = null;

  constructor(readonly identity: NativeProfileNameIdentity, private readonly plugin: Plugin,
    private readonly ownerIsCurrent: () => boolean,
    private readonly onPhase: (phase: "active" | "blocked" | "fallback") => void) {
    this.fence = new NativeProfileNameFence(identity);
  }
  async listen(): Promise<boolean> {
    if (this.disposed || this.listening) return false;
    this.listening = true;
    try {
      if (!await this.installListener(this.plugin.addListener("profileNameEdit", event => this.edit(event)))) return false;
      if (!await this.installListener(this.plugin.addListener("profileNameAction", event => { void this.choose(event); }))) return false;
      if (!await this.installListener(subscribeNativeDrawerIsolation(this.plugin), true)) return false;
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
    // No scene is applied until all listeners arrive. A late SDK result must
    // not retain the old private feature after bounded admission has failed.
    void pending.then(handle => { if (this.disposed) remove(handle); }).catch(() => undefined);
    const handle = await acknowledged(pending);
    if (this.disposed) { remove(handle); return false; }
    if (isolation) this.isolation = handle;
    else this.handles.push(handle);
    return true;
  }
  publish(state: NativeProfileNameProjection, actions: NativeProfileNameActions<T>): boolean {
    if (this.disposed || !this.ready) return false;
    if (!this.ownerIsCurrent() || !validNativeProfileNameProjection(state) || !this.fence.update(state)) {
      void this.fail(); return false;
    }
    const snapshot = { ...state };
    this.current = { state: snapshot, actions: { ...actions } };
    this.highestUpdate = state.updateSequence;
    this.pending = snapshot;
    this.pump();
    return true;
  }
  refreshActions(actions: NativeProfileNameActions<T>): void {
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
        const receipt = await acknowledged(this.plugin.applyProfileNameScene(state));
        if (this.disposed) return;
        if (!receipt || !sameNativeDrawer(receipt, state) || receipt.scene !== state.scene ||
            receipt.phase !== "active" || receipt.updateSequence !== state.updateSequence ||
            receipt.privacyGeneration !== state.privacyGeneration || !this.ownerIsCurrent()) {
          await this.fail(); return;
        }
        if (this.current?.state.updateSequence === state.updateSequence) this.onPhase("active");
      } catch { await this.fail(); return; }
    }
  }
  private edit(event: NativeProfileNameEdit): void {
    if (this.disposed || !this.ownerIsCurrent() || !this.current || !this.fence.consumeEdit(event)) return;
    try { this.current.actions.edit(event.text, event.composing, event.editRevision); }
    catch { void this.fail(); }
  }
  private async choose(event: NativeProfileNameAction): Promise<void> {
    if (this.disposed || !this.ownerIsCurrent() || !event || !sameNativeDrawer(event, this.identity) ||
        event.scene !== this.identity.scene || !Number.isSafeInteger(event.sequence) || event.sequence <= this.seenAction) return;
    this.seenAction = event.sequence;
    if (!this.fence.allows(event)) { await this.reject(event); return; }
    await this.inFlight;
    const current = this.current;
    if (this.disposed || !current) return;
    if (!this.fence.allows(event)) { await this.reject(event); return; }
    try {
      const accepted = await this.fence.consumeAction(event,
        () => acknowledged(this.plugin.confirmProfileNameAction(event)),
        () => !this.disposed && (event.action === "cancel" || this.current === current) && this.ownerIsCurrent());
      if (!accepted) { await acknowledged(this.plugin.settleProfileNameAction(event)); return; }
      if (event.action === "cancel") {
        if (await this.retire() && this.ownerIsCurrent()) current.actions.cancel();
        return;
      }
      const result = await current.actions.save();
      if (this.disposed || !this.ownerIsCurrent()) return;
      if (result.kind === "saved") {
        if (await this.retire() && this.ownerIsCurrent()) current.actions.saved(result.value);
        return;
      }
      const settled = await acknowledged(this.plugin.settleProfileNameAction(event));
      if (!settled.valid) await this.fail();
    } catch { await this.fail(); }
  }
  private async reject(event: NativeProfileNameAction): Promise<void> {
    if (this.disposed || !this.current || event.privacyGeneration !== this.current.state.privacyGeneration) return;
    try {
      const result = await acknowledged(this.plugin.settleProfileNameAction(event));
      if (!result.valid) await this.fail();
    } catch { await this.fail(); }
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
    const handles = this.handles;
    this.handles = [];
    for (const handle of handles) void handle.remove().catch(() => undefined);
    const isolation = this.isolation;
    this.isolation = null;
    let retired = false;
    try {
      const receipt = await acknowledged(this.plugin.retireProfileNameScene(this.identity));
      retired = !!receipt && sameNativeDrawer(receipt, this.identity) && receipt.scene === this.identity.scene &&
        receipt.phase === "retired" && Number.isSafeInteger(receipt.updateSequence) &&
        receipt.updateSequence >= 0 && receipt.updateSequence <= this.highestUpdate;
      if (retired) await acknowledged(reconcileNativeDrawerIsolation(this.plugin));
      return retired;
    } catch { return false; }
    finally {
      if (isolation) {
        if (retired) void isolation.remove().catch(() => undefined);
        else retainNativeDrawerIsolation(this.plugin, isolation);
      }
    }
  }
}
