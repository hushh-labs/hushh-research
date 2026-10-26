import type { PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";
import { captureNativeDrawerOwner, nativeDrawerOwnerIsCurrent } from "./native-drawer-owner";
import { nativeDrawerAcknowledged } from "./native-drawers";
import { getNativeSessionPrivacyState, subscribeNativeSessionPrivacy } from "./session-privacy";
import { subscribeVaultSessionEpoch } from "../vault/session-epoch";

/** Private NativeDrawers v1 extension. Handles are random presentation IDs, not
 * feature values. Labels are volatile display replicas, never public Chrome. */
export type OwnedChoiceIdentity = NonNullable<ReturnType<typeof captureNativeDrawerOwner>> & {
  visitId: string;
  revision: number;
};
export type OwnedChoiceOption = { handle: string; label: string; disabled: boolean; selected: boolean };
export type OwnedChoiceProjection = OwnedChoiceIdentity & NativeControlAppearance & {
  privacyGeneration: number;
  updateSequence: number;
  title: string;
  options: readonly OwnedChoiceOption[];
};
export type OwnedChoiceReceipt = OwnedChoiceIdentity & {
  privacyGeneration: number;
  updateSequence: number;
  phase: "active" | "retired";
};
export type OwnedChoiceEvent = Omit<OwnedChoiceReceipt, "phase"> & {
  sequence: 1;
  outcome: "selected" | "cancelled";
  handle?: string;
};
export type OwnedChoiceAppearance = OwnedChoiceIdentity & NativeControlAppearance & {
  privacyGeneration: number;
  updateSequence: number;
};
export interface NativeOwnedChoicePort {
  prepareOwnedChoice(state: OwnedChoiceProjection): Promise<OwnedChoiceReceipt>;
  updateOwnedChoice(state: OwnedChoiceAppearance): Promise<OwnedChoiceReceipt>;
  retireOwnedChoice(identity: OwnedChoiceIdentity): Promise<OwnedChoiceReceipt>;
  getOwnedChoiceState(identity: OwnedChoiceIdentity): Promise<OwnedChoiceReceipt & { choice?: OwnedChoiceEvent }>;
  addListener(event: "ownedChoice", listener: (event: OwnedChoiceEvent) => void): Promise<PluginListenerHandle>;
}

export function sameOwnedChoice(a: OwnedChoiceIdentity, b: OwnedChoiceIdentity): boolean {
  return a.documentId === b.documentId && a.ownerEpoch === b.ownerEpoch &&
    a.ownerGeneration === b.ownerGeneration && a.visitId === b.visitId && a.revision === b.revision;
}
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "visitId", "revision"];
const appearanceKeys = ["appearance", "accentHex", "foregroundHex"];
const sequence = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && (value as number) >= minimum;
const text = (value: unknown, maximum: number) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const closed = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
export function validOwnedChoiceIdentity(value: OwnedChoiceIdentity): boolean {
  return !!value && [value.documentId, value.ownerEpoch, value.visitId].every(id => text(id, 128)) &&
    sequence(value.ownerGeneration, 1) && sequence(value.revision, 1);
}
export function validOwnedChoiceProjection(value: OwnedChoiceProjection): boolean {
  return validOwnedChoiceIdentity(value) && closed(value, [...identityKeys, ...appearanceKeys,
    "privacyGeneration", "updateSequence", "title", "options"]) && sequence(value.privacyGeneration) &&
    sequence(value.updateSequence, 1) && text(value.title, 256) && ["light", "dark"].includes(value.appearance) &&
    /^#[\da-f]{6}$/i.test(value.accentHex) && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value.foregroundHex) &&
    Array.isArray(value.options) && value.options.length <= 256 && value.options.every(option => !!option &&
      closed(option, ["handle", "label", "disabled", "selected"]) && text(option.handle, 128) && text(option.label, 256) &&
      typeof option.disabled === "boolean" && typeof option.selected === "boolean") &&
    new Set(value.options.map(option => option.handle)).size === value.options.length &&
    value.options.filter(option => option.selected).length <= 1;
}

/** One immediate finite-choice presentation. Controlled dismissal, cancellable
 * DOM events and busy confirmations deliberately use another semantic adapter. */
export class NativeOwnedChoiceLease {
  private projection: OwnedChoiceProjection | null = null;
  private handles: PluginListenerHandle[] = [];
  private removeVault?: () => void;
  private disposed = false;
  private attempted = false;
  private ready = false;
  private pending?: OwnedChoiceEvent;
  private consumed = false;
  private highestSentUpdate = 1;
  private requestedAppearance?: NativeControlAppearance;
  private retirement?: Promise<boolean>;
  private updates: Promise<void> = Promise.resolve();
  private current: () => boolean;
  private finish?: (event: OwnedChoiceEvent) => void;
  private failed?: (retired: boolean, reason: "invalidated" | "failed") => void;
  constructor(readonly identity: OwnedChoiceIdentity, private readonly port: NativeOwnedChoicePort,
    current: () => boolean, finish: (event: OwnedChoiceEvent) => void,
    failed: (retired: boolean, reason: "invalidated" | "failed") => void) {
    this.current = current; this.finish = finish; this.failed = failed;
  }

  private owns(): boolean { return !this.disposed && this.current() && nativeDrawerOwnerIsCurrent(this.identity); }
  private invalidate(): void { void this.fail("invalidated"); }
  private async fail(reason: "invalidated" | "failed"): Promise<void> {
    const callback = this.failed;
    callback?.(await this.retire(), reason);
  }
  private async retain(pending: Promise<PluginListenerHandle>): Promise<boolean> {
    void pending.then(handle => { if (this.disposed) void handle.remove(); }).catch(() => undefined);
    const handle = await nativeDrawerAcknowledged(pending);
    if (this.disposed) { await handle.remove(); return false; }
    this.handles.push(handle); return true;
  }
  async present(state: Omit<OwnedChoiceProjection, "privacyGeneration" | "updateSequence">): Promise<void> {
    try {
      if (!this.owns()) { await this.fail("invalidated"); return; }
      const privacy = await getNativeSessionPrivacyState();
      if (!this.owns() || privacy.shielded || !privacy.appIsActive) { await this.fail("invalidated"); return; }
      const next = { ...state, privacyGeneration: privacy.generation, updateSequence: 1 };
      if (!validOwnedChoiceProjection(next) || !sameOwnedChoice(next, this.identity)) throw new Error("OWNED_CHOICE_INVALID");
      this.projection = { ...next, options: next.options.map(option => ({ ...option })) };
      if (!await this.retain(this.port.addListener("ownedChoice", event => this.receive(event)))) return;
      if (!await this.retain(subscribeNativeSessionPrivacy(current => {
        if (current.shielded || !current.appIsActive || current.generation !== privacy.generation) this.invalidate();
      }))) return;
      this.removeVault = subscribeVaultSessionEpoch(() => this.invalidate());
      if (!this.owns()) return;
      this.attempted = true;
      const receipt = await nativeDrawerAcknowledged(this.port.prepareOwnedChoice(this.projection));
      if (this.disposed) return;
      if (!this.owns() || !sameOwnedChoice(receipt, next) || receipt.phase !== "active" ||
          receipt.updateSequence !== 1 || receipt.privacyGeneration !== privacy.generation) throw new Error("OWNED_CHOICE_ACK_INVALID");
      this.ready = true;
      if (this.pending) this.receive(this.pending);
      if (this.requestedAppearance) this.updateAppearance(this.requestedAppearance);
    } catch { if (!this.disposed) await this.fail("failed"); }
  }
  updateAppearance(appearance: NativeControlAppearance): void {
    this.requestedAppearance = { ...appearance };
    this.updates = this.updates.catch(() => undefined).then(async () => {
      const state = this.projection;
      if (!this.ready || !state || !this.owns()) return;
      const next = { ...this.identity, ...appearance, privacyGeneration: state.privacyGeneration,
        updateSequence: state.updateSequence + 1 };
      try {
        this.highestSentUpdate = next.updateSequence;
        const receipt = await nativeDrawerAcknowledged(this.port.updateOwnedChoice(next));
        if (this.disposed) return;
        if (sameOwnedChoice(receipt, next) && receipt.phase === "retired") {
          const terminal = await nativeDrawerAcknowledged(this.port.getOwnedChoiceState(this.identity));
          if (this.owns() && sameOwnedChoice(terminal, this.identity) && terminal.phase === "retired") {
            if (terminal.choice) this.receive(terminal.choice);
            else this.invalidate();
          }
          return;
        }
        if (!sameOwnedChoice(receipt, next) || receipt.phase !== "active" || receipt.updateSequence !== next.updateSequence ||
            receipt.privacyGeneration !== next.privacyGeneration) throw new Error("OWNED_CHOICE_UPDATE_INVALID");
        if (this.projection === state) this.projection = { ...state, ...next };
      } catch { if (!this.disposed) await this.fail("failed"); }
    });
  }
  private receive(event: OwnedChoiceEvent): void {
    const state = this.projection;
    if (!state || this.consumed || !this.owns() || !event || !sameOwnedChoice(event, state) ||
        !closed(event, [...identityKeys, "privacyGeneration", "updateSequence", "sequence", "outcome", "handle"]) ||
        event.sequence !== 1 || !sequence(event.updateSequence, 1) || event.updateSequence > this.highestSentUpdate ||
        event.privacyGeneration !== state.privacyGeneration ||
        !["selected", "cancelled"].includes(event.outcome) ||
        (event.outcome === "selected" ? !state.options.some(option => option.handle === event.handle && !option.disabled) : event.handle !== undefined)) return;
    if (!this.ready) { this.pending = { ...event }; return; }
    this.consumed = true;
    // The terminal native event is emitted only after actual detachment.
    const complete = this.finish;
    this.disposed = true; this.clear();
    complete?.(event);
  }
  private clear(): void {
    this.projection = null; this.pending = undefined;
    this.current = () => false; this.finish = undefined; this.failed = undefined;
    this.removeVault?.(); this.removeVault = undefined;
    for (const handle of this.handles) void handle.remove().catch(() => undefined);
    this.handles = [];
  }
  retire(): Promise<boolean> {
    return this.retirement ??= (async () => {
      this.disposed = true; this.ready = false; this.clear();
      if (!this.attempted) return true;
      try {
        const receipt = await nativeDrawerAcknowledged(this.port.retireOwnedChoice(this.identity));
        return sameOwnedChoice(receipt, this.identity) && receipt.phase === "retired";
      } catch { return false; }
    })();
  }
  async retirementIsConfirmed(): Promise<boolean> {
    try {
      const receipt = await nativeDrawerAcknowledged(this.port.getOwnedChoiceState(this.identity));
      return sameOwnedChoice(receipt, this.identity) && receipt.phase === "retired";
    } catch { return false; }
  }
}
