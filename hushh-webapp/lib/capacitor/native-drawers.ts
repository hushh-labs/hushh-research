import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";
import type { NativeProfileNameScenePort } from "./native-profile-name-scene";
import type { NativeProfileStyleScenePort } from "./native-profile-style-scene";

/** Private presentation, never public chrome metadata. Values and callbacks are
 * process-local replicas of the existing feature owner, not another store. */
export type NativeDrawerFamily = "history" | "profile" | "agent-profile";
export type NativeDrawerRow = {
  id: string;
  label: string;
  detail?: string;
  symbol?: string;
  iconHex?: string;
  chevron?: boolean;
  trailing?: string;
  enabled: boolean;
  destructive?: boolean;
  selected?: boolean;
  pending?: boolean;
  readOnly?: boolean;
  artworkId?: string;
  renameActionId?: string;
  deleteActionId?: string;
};
export type NativeDrawerSection = { id: string; title?: string; rows: readonly NativeDrawerRow[] };
/** Bounded native destinations, not URLs or another routing authority. */
export type NativeProfilePage = { id: "account"; title: string; sections: readonly NativeDrawerSection[] };
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
  searchable?: boolean;
  loading?: boolean;
  /** Negotiated Profile drawer lifetime, not menu/body visibility. */
  surfaceOpen?: boolean;
  profileStack?: readonly NativeProfilePage[];
  profileDestinationId?: string;
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
  text?: string;
};
export type NativeDrawerIsolation = { generation: number; isolated: boolean };
export type NativeDrawerReadmission = NativeDrawerIdentity & {
  updateSequence: number; privacyGeneration: number; interactionGeneration: number;
};
export interface HushhNativeDrawersPlugin {
  getCapabilities(): Promise<NativeDrawerIsolation & { contractVersion: number; supported: boolean; wholePresentation: boolean; historyActions?: boolean; terminalRefreshes?: boolean; terminalReadmission?: boolean; profileMenuRows?: boolean; profileContentHandoff?: boolean; profileNavigationStack?: boolean; agentProfileMenu?: boolean; profileNameScene?: boolean; profileStyleScene?: boolean }>;
  applyProfileNameScene?(options: Parameters<NativeProfileNameScenePort["applyProfileNameScene"]>[0]): ReturnType<NativeProfileNameScenePort["applyProfileNameScene"]>;
  confirmProfileNameAction?(options: Parameters<NativeProfileNameScenePort["confirmProfileNameAction"]>[0]): ReturnType<NativeProfileNameScenePort["confirmProfileNameAction"]>;
  settleProfileNameAction?(options: Parameters<NativeProfileNameScenePort["settleProfileNameAction"]>[0]): ReturnType<NativeProfileNameScenePort["settleProfileNameAction"]>;
  retireProfileNameScene?(options: Parameters<NativeProfileNameScenePort["retireProfileNameScene"]>[0]): ReturnType<NativeProfileNameScenePort["retireProfileNameScene"]>;
  applyProfileStyleScene?(options: Parameters<NativeProfileStyleScenePort["applyProfileStyleScene"]>[0]): ReturnType<NativeProfileStyleScenePort["applyProfileStyleScene"]>;
  confirmProfileStyleAction?(options: Parameters<NativeProfileStyleScenePort["confirmProfileStyleAction"]>[0]): ReturnType<NativeProfileStyleScenePort["confirmProfileStyleAction"]>;
  settleProfileStyleAction?(options: Parameters<NativeProfileStyleScenePort["settleProfileStyleAction"]>[0]): ReturnType<NativeProfileStyleScenePort["settleProfileStyleAction"]>;
  retireProfileStyleScene?(options: Parameters<NativeProfileStyleScenePort["retireProfileStyleScene"]>[0]): ReturnType<NativeProfileStyleScenePort["retireProfileStyleScene"]>;
  addListener: NativeProfileNameScenePort["addListener"] & NativeProfileStyleScenePort["addListener"] & {
    (eventName: "choice", listener: (event: NativeDrawerChoice) => void): Promise<PluginListenerHandle>;
    (eventName: "isolationChanged", listener: (event: NativeDrawerIsolation) => void): Promise<PluginListenerHandle>;
    (eventName: "readmissionRequested", listener: (event: NativeDrawerReadmission) => void): Promise<PluginListenerHandle>;
  };
  apply(options: NativeDrawerProjection): Promise<NativeDrawerReceipt>;
  confirmChoice(options: NativeDrawerChoice): Promise<{ valid: boolean }>;
  settleChoice?(options: NativeDrawerIdentity & { sequence: number; privacyGeneration: number; success: boolean }): Promise<{ valid: boolean }>;
  retire(options: NativeDrawerIdentity): Promise<NativeDrawerReceipt>;
}
export const nativeDrawers = registerPlugin<HushhNativeDrawersPlugin>("HushhNativeDrawers");

// Public eligibility metadata only. The private presentation installs this
// observer before admission; base adapters compare it across awaited choices.
let isolation: NativeDrawerIsolation = { generation: 0, isolated: false };
const isolationObservers = new Set<() => void>();
export function observeNativeDrawerIsolation(observer: () => void): () => void {
  isolationObservers.add(observer);
  return () => { isolationObservers.delete(observer); };
}
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
  if (next.generation === isolation.generation && next.isolated === isolation.isolated) return;
  isolation = { generation: next.generation, isolated: next.isolated };
  isolationObservers.forEach(observer => observer());
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
      "updateSequence", "privacyGeneration", "title", "sections", "open", "enabled", "backEnabled", "searchable", "loading", "surfaceOpen", "profileStack", "profileDestinationId"]) ||
      !validIdentifier(value.documentId) || !validIdentifier(value.ownerEpoch) ||
      !validSequence(value.ownerGeneration) || !validSequence(value.revision) || !validSequence(value.updateSequence) ||
      !["history", "profile", "agent-profile"].includes(value.family) ||
      !Number.isSafeInteger(value.privacyGeneration) || value.privacyGeneration < 0 ||
      ![value.open, value.enabled, value.backEnabled].every(item => typeof item === "boolean") ||
      [value.searchable, value.loading].some(item => item !== undefined && typeof item !== "boolean") ||
      value.surfaceOpen !== undefined && (typeof value.surfaceOpen !== "boolean" || value.family !== "profile" || value.open && !value.surfaceOpen) ||
      !["light", "dark"].includes(value.appearance) ||
      ![value.accentHex, value.foregroundHex].every(color => /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) ||
      !validText(value.title, 256) || !Array.isArray(value.sections) || value.sections.length > 32) return false;
  const ids = new Set<string>();
  let rows = 0;
  if (value.profileStack !== undefined && (value.family !== "profile" || !Array.isArray(value.profileStack) ||
      value.profileStack.length > 1 || value.profileStack.some(page => !page || !closedShape(page, ["id", "title", "sections"]) ||
        page.id !== "account" || !validText(page.title, 256) || !Array.isArray(page.sections) || page.sections.length > 32) ||
      value.profileStack.length > 0 && (!value.backEnabled || !validIdentifier(value.profileDestinationId)))) return false;
  if (value.profileDestinationId !== undefined && (!value.profileStack?.length || !validIdentifier(value.profileDestinationId))) return false;
  for (const section of [...value.sections, ...(value.profileStack?.flatMap(page => page.sections) ?? [])]) {
    if (!section || !closedShape(section, ["id", "title", "rows"]) || !validIdentifier(section.id) || ids.has(section.id) ||
        (section.title !== undefined && !validText(section.title, 256)) ||
        !Array.isArray(section.rows)) return false;
    ids.add(section.id);
    for (const row of section.rows) {
      if (++rows > 500 || !row || !closedShape(row, ["id", "label", "detail", "symbol", "iconHex", "chevron", "trailing", "enabled", "destructive", "selected", "pending", "renameActionId", "deleteActionId", "readOnly", "artworkId"]) ||
          !validIdentifier(row.id) || ids.has(row.id) ||
          !validText(row.label, 4096) || (row.detail !== undefined && !validText(row.detail, 4096)) ||
          (row.symbol !== undefined && !validIdentifier(row.symbol)) || typeof row.enabled !== "boolean" ||
          [row.destructive, row.selected, row.pending, row.chevron, row.readOnly].some(item => item !== undefined && typeof item !== "boolean") ||
          (row.artworkId !== undefined && !validIdentifier(row.artworkId)) ||
          (row.iconHex !== undefined && !/^#[\da-f]{6}$/i.test(row.iconHex)) ||
          (row.trailing !== undefined && !validText(row.trailing, 32))) return false;
      ids.add(row.id);
      for (const action of [row.renameActionId, row.deleteActionId]) {
        if (action === undefined) continue;
        if (!validIdentifier(action) || ids.has(action)) return false;
        ids.add(action);
      }
    }
  }
  return true;
}

export function activeNativeDrawerSections(state: NativeDrawerProjection): readonly NativeDrawerSection[] {
  return state.profileStack?.at(-1)?.sections ?? state.sections;
}

export function nativeDrawerChoiceAllowed(choice: NativeDrawerChoice, state: NativeDrawerProjection): boolean {
  if (!choice || !sameNativeDrawer(choice, state) || !validSequence(choice.sequence) || !validSequence(choice.interactionGeneration) ||
      choice.updateSequence !== state.updateSequence || choice.privacyGeneration !== state.privacyGeneration ||
      !state.enabled) return false;
  if (choice.action !== "row" && choice.text !== undefined) return false;
  if (choice.action === "open") return !state.open && choice.rowId === undefined;
  if (!state.open) return false;
  if (choice.action === "close") return choice.rowId === undefined;
  if (choice.action === "back") return state.backEnabled && choice.rowId === undefined;
  if (choice.action !== "row" || !validIdentifier(choice.rowId)) return false;
  return activeNativeDrawerSections(state).some(section => section.rows.some(row => row.enabled && !row.readOnly && !row.pending &&
    (row.renameActionId === choice.rowId ? typeof choice.text === "string" && choice.text.trim().length > 0 && choice.text.length <= 160 :
      (row.id === choice.rowId || row.deleteActionId === choice.rowId) && choice.text === undefined)));
}

/** The native receipt is not permission to call an operation later. Revalidate
 * the current feature owner after confirmation, then consume exactly once. */
export class NativeDrawerChoiceFence {
  private consumed = 0;
  private generation = 0;
  private retired = false;
  private current: NativeDrawerProjection | null = null;
  private terminalRefreshes = false;
  private terminalUpdateFloor = 0;
  constructor(readonly identity: NativeDrawerIdentity) {}
  enableTerminalRefreshes(): void { if (!this.current) this.terminalRefreshes = true; }
  update(state: NativeDrawerProjection): boolean {
    if (this.retired || !validNativeDrawerProjection(state) || !sameNativeDrawer(this.identity, state) ||
        (this.current && state.updateSequence <= this.current.updateSequence)) return false;
    if (!this.current || this.current.open !== state.open || this.current.enabled !== state.enabled ||
        this.current.privacyGeneration !== state.privacyGeneration) this.terminalUpdateFloor = state.updateSequence;
    this.current = state;
    this.generation++;
    return true;
  }
  retire() { this.retired = true; this.current = null; this.generation++; }
  terminalIsCurrent(choice: NativeDrawerChoice): boolean {
    if (this.retired || !this.current || choice.action !== "open" && choice.action !== "close") return false;
    return validSequence(choice.updateSequence) && choice.updateSequence >= this.terminalUpdateFloor &&
      choice.updateSequence <= this.current.updateSequence &&
      nativeDrawerChoiceAllowed({ ...choice, updateSequence: this.current.updateSequence }, this.current);
  }
  allows(choice: NativeDrawerChoice): boolean {
    if (this.retired || !this.current) return false;
    if (!this.terminalRefreshes || choice.action !== "open" && choice.action !== "close") {
      return nativeDrawerChoiceAllowed(choice, this.current);
    }
    // Only terminal presentation intents survive compatible content updates.
    // Native still confirms the exact emitted token and interaction generation.
    return this.terminalIsCurrent(choice);
  }
  async consume(choice: NativeDrawerChoice, confirm: () => Promise<{ valid: boolean }>,
    isCurrent: () => boolean, invoke: () => void | Promise<void>): Promise<boolean> {
    if (!this.current || choice.sequence <= this.consumed ||
        !this.allows(choice) || !isCurrent()) return false;
    const terminal = this.terminalRefreshes && (choice.action === "open" || choice.action === "close");
    const generation = terminal ? this.terminalUpdateFloor : this.generation;
    const result = await confirm();
    if (!result.valid || generation !== (terminal ? this.terminalUpdateFloor : this.generation) || !this.current ||
        choice.sequence <= this.consumed || !isCurrent() ||
        !this.allows(choice)) return false;
    this.consumed = choice.sequence;
    await invoke();
    return true;
  }
}

/** Unsupported platforms decide their renderer before surface reveal. Product
 * admission is separate from this private contract and remains qualification-gated. */
export function nativeDrawersPlatformEligible(): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios" || typeof window === "undefined") return false;
  const bootstrap = (window as Window & { __HUSHH_NATIVE_DRAWER_BOOTSTRAP__?: { contractVersion: number; enabled: boolean } }).__HUSHH_NATIVE_DRAWER_BOOTSTRAP__;
  return bootstrap?.contractVersion === 1 && bootstrap.enabled === true;
}
