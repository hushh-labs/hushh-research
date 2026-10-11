import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";

/** Private presentation, never public chrome metadata. Values and callbacks are
 * process-local replicas of the existing feature owner, not another store. */
export type NativeDrawerFamily = "history" | "profile";
export type NativeDrawerRow = {
  id: string;
  label: string;
  detail?: string;
  symbol?: string;
  enabled: boolean;
  destructive?: boolean;
  selected?: boolean;
  pending?: boolean;
};
export type NativeDrawerSection = { id: string; title?: string; rows: readonly NativeDrawerRow[] };
export type NativeDrawerIdentity = {
  documentId: string;
  ownerEpoch: string;
  ownerGeneration: number;
  revision: number;
  family: NativeDrawerFamily;
};
export type NativeDrawerProjection = NativeDrawerIdentity & NativeControlAppearance & {
  updateSequence: number;
  privacyGeneration: number;
  title: string;
  sections: readonly NativeDrawerSection[];
  open: boolean;
  enabled: boolean;
  backEnabled: boolean;
};
export type NativeDrawerReceipt = NativeDrawerIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  phase: "active" | "retired";
};
export type NativeDrawerChoice = NativeDrawerIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  sequence: number;
  interactionGeneration: number;
  action: "row" | "back" | "close" | "open";
  rowId?: string;
};
export type NativeDrawerIsolation = { generation: number; isolated: boolean };
export interface HushhNativeDrawersPlugin {
  getCapabilities(): Promise<NativeDrawerIsolation & { contractVersion: number; supported: boolean; wholePresentation: boolean }>;
  apply(options: NativeDrawerProjection): Promise<NativeDrawerReceipt>;
  confirmChoice(options: NativeDrawerChoice): Promise<{ valid: boolean }>;
  retire(options: NativeDrawerIdentity): Promise<NativeDrawerReceipt>;
  addListener(eventName: "choice", listener: (event: NativeDrawerChoice) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "isolationChanged", listener: (event: NativeDrawerIsolation) => void): Promise<PluginListenerHandle>;
}
export const nativeDrawers = registerPlugin<HushhNativeDrawersPlugin>("HushhNativeDrawers");

// Public eligibility metadata only. The private presentation installs this
// observer before admission; base adapters compare it across awaited choices.
let isolation: NativeDrawerIsolation = { generation: 0, isolated: false };
export function nativeDrawerIsolation(): Readonly<NativeDrawerIsolation> { return isolation; }
type NativeDrawerIsolationSource = {
  getCapabilities(): Promise<NativeDrawerIsolation>;
  addListener(eventName: "isolationChanged", listener: (event: NativeDrawerIsolation) => void): Promise<PluginListenerHandle>;
};
/** Bounds presentation metadata, never retries an action. */
export async function nativeDrawerAcknowledged<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("NATIVE_DRAWER_UNCERTAIN_ACK")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

// Uncertain withdrawal transfers only a public metadata observer to document
// lifetime. Keep one per native source: no private feature closure or body.
// A later privacy/uncover event must still invalidate delayed base choices.
const retainedIsolation = new WeakMap<NativeDrawerIsolationSource, PluginListenerHandle>();
export function retainNativeDrawerIsolation(plugin: NativeDrawerIsolationSource, handle: PluginListenerHandle): void {
  if (typeof window === "undefined") { void handle.remove().catch(() => undefined); return; }
  if (retainedIsolation.has(plugin)) { void handle.remove().catch(() => undefined); return; }
  retainedIsolation.set(plugin, handle);
  const release = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    retainedIsolation.delete(plugin);
    window.removeEventListener("pagehide", release);
    void handle.remove().catch(() => undefined);
  };
  window.addEventListener("pagehide", release);
}
export async function reconcileNativeDrawerIsolation(plugin: NativeDrawerIsolationSource): Promise<void> {
  updateNativeDrawerIsolation(await nativeDrawerAcknowledged(plugin.getCapabilities()));
}
function updateNativeDrawerIsolation(next: NativeDrawerIsolation) {
  if (!next || !Number.isSafeInteger(next.generation) || next.generation < 0 || typeof next.isolated !== "boolean") {
    throw new Error("NATIVE_DRAWER_ISOLATION_INVALID");
  }
  if (next.generation < isolation.generation || next.generation === isolation.generation && next.isolated !== isolation.isolated) return;
  isolation = { generation: next.generation, isolated: next.isolated };
}
export async function subscribeNativeDrawerIsolation(plugin: NativeDrawerIsolationSource): Promise<PluginListenerHandle> {
  const update = (next: NativeDrawerIsolation) => {
    try { updateNativeDrawerIsolation(next); } catch { /* Invalid metadata cannot change eligibility. */ }
  };
  const handle = await plugin.addListener("isolationChanged", update);
  try { await reconcileNativeDrawerIsolation(plugin); return handle; }
  catch { void handle.remove().catch(() => undefined); throw new Error("NATIVE_DRAWER_ISOLATION_UNAVAILABLE"); }
}

export function sameNativeDrawer(a: NativeDrawerIdentity, b: NativeDrawerIdentity): boolean {
  return a.documentId === b.documentId && a.ownerEpoch === b.ownerEpoch && a.ownerGeneration === b.ownerGeneration &&
    a.revision === b.revision && a.family === b.family;
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function closedShape(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

/** Bounded authored projections only: no DOM inference, URL, token, credential,
 * arbitrary view tree, provider payload or action transport in this contract. */
export function validNativeDrawerProjection(value: NativeDrawerProjection): boolean {
  if (!value || !closedShape(value, ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "appearance", "accentHex", "foregroundHex",
      "updateSequence", "privacyGeneration", "title", "sections", "open", "enabled", "backEnabled"]) ||
      !validIdentifier(value.documentId) || !validIdentifier(value.ownerEpoch) ||
      !validSequence(value.ownerGeneration) || !validSequence(value.revision) || !validSequence(value.updateSequence) ||
      !["history", "profile"].includes(value.family) ||
      !Number.isSafeInteger(value.privacyGeneration) || value.privacyGeneration < 0 ||
      ![value.open, value.enabled, value.backEnabled].every(item => typeof item === "boolean") ||
      !["light", "dark"].includes(value.appearance) ||
      ![value.accentHex, value.foregroundHex].every(color => /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) ||
      !validText(value.title, 256) || !Array.isArray(value.sections) || value.sections.length > 32) return false;
  const ids = new Set<string>();
  let rows = 0;
  for (const section of value.sections) {
    if (!section || !closedShape(section, ["id", "title", "rows"]) || !validIdentifier(section.id) || ids.has(section.id) ||
        (section.title !== undefined && !validText(section.title, 256)) ||
        !Array.isArray(section.rows)) return false;
    ids.add(section.id);
    for (const row of section.rows) {
      if (++rows > 500 || !row || !closedShape(row, ["id", "label", "detail", "symbol", "enabled", "destructive", "selected", "pending"]) ||
          !validIdentifier(row.id) || ids.has(row.id) ||
          !validText(row.label, 4096) || (row.detail !== undefined && !validText(row.detail, 4096)) ||
          (row.symbol !== undefined && !validIdentifier(row.symbol)) || typeof row.enabled !== "boolean" ||
          [row.destructive, row.selected, row.pending].some(item => item !== undefined && typeof item !== "boolean")) return false;
      ids.add(row.id);
    }
  }
  return true;
}

export function nativeDrawerChoiceAllowed(choice: NativeDrawerChoice, state: NativeDrawerProjection): boolean {
  if (!choice || !sameNativeDrawer(choice, state) || !validSequence(choice.sequence) || !validSequence(choice.interactionGeneration) ||
      choice.updateSequence !== state.updateSequence || choice.privacyGeneration !== state.privacyGeneration ||
      !state.enabled) return false;
  if (choice.action === "open") return !state.open && choice.rowId === undefined;
  if (!state.open) return false;
  if (choice.action === "close") return choice.rowId === undefined;
  if (choice.action === "back") return state.backEnabled && choice.rowId === undefined;
  if (choice.action !== "row" || !validIdentifier(choice.rowId)) return false;
  return state.sections.some(section => section.rows.some(row => row.id === choice.rowId && row.enabled && !row.pending));
}

/** The native receipt is not permission to call an operation later. Revalidate
 * the current feature owner after confirmation, then consume exactly once. */
export class NativeDrawerChoiceFence {
  private consumed = 0;
  private generation = 0;
  private retired = false;
  private current: NativeDrawerProjection | null = null;
  constructor(readonly identity: NativeDrawerIdentity) {}
  update(state: NativeDrawerProjection): boolean {
    if (this.retired || !validNativeDrawerProjection(state) || !sameNativeDrawer(this.identity, state) ||
        (this.current && state.updateSequence <= this.current.updateSequence)) return false;
    this.current = state;
    this.generation++;
    return true;
  }
  retire() { this.retired = true; this.current = null; this.generation++; }
  async consume(choice: NativeDrawerChoice, confirm: () => Promise<{ valid: boolean }>,
    isCurrent: () => boolean, invoke: () => void | Promise<void>): Promise<boolean> {
    if (!this.current || choice.sequence <= this.consumed ||
        !nativeDrawerChoiceAllowed(choice, this.current) || !isCurrent()) return false;
    const generation = this.generation;
    const result = await confirm();
    if (!result.valid || generation !== this.generation || !this.current ||
        choice.sequence <= this.consumed || !isCurrent() ||
        !nativeDrawerChoiceAllowed(choice, this.current)) return false;
    this.consumed = choice.sequence;
    await invoke();
    return true;
  }
}

/** Unsupported platforms decide their renderer before surface reveal. Product
 * admission is separate from this private contract and remains qualification-gated. */
export function nativeDrawersPlatformEligible(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}
