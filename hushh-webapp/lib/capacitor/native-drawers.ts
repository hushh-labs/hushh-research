import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";
import type { NativeProfileNameScenePort } from "./native-profile-name-scene";
import type { NativeProfileStyleScenePort } from "./native-profile-style-scene";
import type { NativeSupportScenePort } from "./native-profile-support-scene";
import type { NativePhoneScenePort } from "./native-profile-phone-scene";
import { nativeLegalActionIds, validNativeLegalDocument, type NativeLegalDocument } from "./native-profile-legal";

/** Private presentation, never public chrome metadata. Values and callbacks are
 * process-local replicas of the existing feature owner, not another store. */
export type NativeDrawerFamily = "history" | "profile" | "agent-profile";
export type NativeDrawerOption = { id: string; label: string; selected: boolean; symbol?: string; colorHex?: string };
export type NativeDrawerRow = {
  id: string;
  label: string;
  detail?: string;
  symbol?: string;
  iconHex?: string;
  chevron?: boolean;
  trailing?: string;
  /** Authored finite choices. IDs bind to existing React writers, never values or URLs. */
  options?: readonly NativeDrawerOption[];
  toggle?: boolean;
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
export type NativeProfilePage = { id: "account" | "account-reset" | "account-delete" | "preferences" | "voice" | "security" | "session" | "devices" | "device-unlink" | "legal" | "privacy" | "terms";
  title: string; sections: readonly NativeDrawerSection[]; legalDocument?: NativeLegalDocument };
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
  /** A bounded support sheet anchored to the retained root, not an empty page. */
  profileSupportDestinationId?: string;
};
export type NativeDrawerReceipt = NativeDrawerIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  phase: "active" | "retired";
};
/** Metadata only: admission is not proof of a completed UIKit transition. */
export type NativeDrawerPresentationState = NativeDrawerReceipt & { settled: boolean };
export type NativeDrawerChoice = NativeDrawerIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  sequence: number;
  interactionGeneration: number;
  action: "row" | "back" | "root" | "ancestor" | "close" | "open";
  rowId?: string;
  text?: string;
};
export type NativeDrawerIsolation = { generation: number; isolated: boolean };
export type NativeDrawerReadmission = NativeDrawerIdentity & {
  updateSequence: number; privacyGeneration: number; interactionGeneration: number;
};
export interface HushhNativeDrawersPlugin {
  getCapabilities(): Promise<NativeDrawerIsolation & { contractVersion: number; supported: boolean; wholePresentation: boolean; historyActions?: boolean; terminalRefreshes?: boolean; terminalReadmission?: boolean; presentationCompletion?: boolean; profileMenuRows?: boolean; profileContentHandoff?: boolean; profileNavigationStack?: boolean; profileSettingsPages?: boolean; profileVoiceSettings?: boolean; profileTrustedDevices?: boolean; profileAccountActions?: boolean; profileLegalReader?: boolean; agentProfileMenu?: boolean; profileNameScene?: boolean; profileStyleScene?: boolean; profileSupportScene?: boolean; profilePhoneScene?: boolean }>;
  getPresentationState?(options: NativeDrawerIdentity): Promise<({ valid: true } & NativeDrawerPresentationState) | { valid: false }>;
  applyProfilePhoneScene?(options: Parameters<NativePhoneScenePort["applyProfilePhoneScene"]>[0]): ReturnType<NativePhoneScenePort["applyProfilePhoneScene"]>;
  confirmProfilePhoneAction?(options: Parameters<NativePhoneScenePort["confirmProfilePhoneAction"]>[0]): ReturnType<NativePhoneScenePort["confirmProfilePhoneAction"]>;
  settleProfilePhoneAction?(options: Parameters<NativePhoneScenePort["settleProfilePhoneAction"]>[0]): ReturnType<NativePhoneScenePort["settleProfilePhoneAction"]>;
  retireProfilePhoneScene?(options: Parameters<NativePhoneScenePort["retireProfilePhoneScene"]>[0]): ReturnType<NativePhoneScenePort["retireProfilePhoneScene"]>;
  applyProfileSupportScene?(options: Parameters<NativeSupportScenePort["applyProfileSupportScene"]>[0]): ReturnType<NativeSupportScenePort["applyProfileSupportScene"]>;
  confirmProfileSupportAction?(options: Parameters<NativeSupportScenePort["confirmProfileSupportAction"]>[0]): ReturnType<NativeSupportScenePort["confirmProfileSupportAction"]>;
  settleProfileSupportAction?(options: Parameters<NativeSupportScenePort["settleProfileSupportAction"]>[0]): ReturnType<NativeSupportScenePort["settleProfileSupportAction"]>;
  retireProfileSupportScene?(options: Parameters<NativeSupportScenePort["retireProfileSupportScene"]>[0]): ReturnType<NativeSupportScenePort["retireProfileSupportScene"]>;
  applyProfileNameScene?(options: Parameters<NativeProfileNameScenePort["applyProfileNameScene"]>[0]): ReturnType<NativeProfileNameScenePort["applyProfileNameScene"]>;
  confirmProfileNameAction?(options: Parameters<NativeProfileNameScenePort["confirmProfileNameAction"]>[0]): ReturnType<NativeProfileNameScenePort["confirmProfileNameAction"]>;
  settleProfileNameAction?(options: Parameters<NativeProfileNameScenePort["settleProfileNameAction"]>[0]): ReturnType<NativeProfileNameScenePort["settleProfileNameAction"]>;
  retireProfileNameScene?(options: Parameters<NativeProfileNameScenePort["retireProfileNameScene"]>[0]): ReturnType<NativeProfileNameScenePort["retireProfileNameScene"]>;
  applyProfileStyleScene?(options: Parameters<NativeProfileStyleScenePort["applyProfileStyleScene"]>[0]): ReturnType<NativeProfileStyleScenePort["applyProfileStyleScene"]>;
  confirmProfileStyleAction?(options: Parameters<NativeProfileStyleScenePort["confirmProfileStyleAction"]>[0]): ReturnType<NativeProfileStyleScenePort["confirmProfileStyleAction"]>;
  settleProfileStyleAction?(options: Parameters<NativeProfileStyleScenePort["settleProfileStyleAction"]>[0]): ReturnType<NativeProfileStyleScenePort["settleProfileStyleAction"]>;
  retireProfileStyleScene?(options: Parameters<NativeProfileStyleScenePort["retireProfileStyleScene"]>[0]): ReturnType<NativeProfileStyleScenePort["retireProfileStyleScene"]>;
  addListener: NativeProfileNameScenePort["addListener"] & NativeProfileStyleScenePort["addListener"] & NativeSupportScenePort["addListener"] & NativePhoneScenePort["addListener"] & {
    (eventName: "choice", listener: (event: NativeDrawerChoice) => void): Promise<PluginListenerHandle>;
    (eventName: "isolationChanged", listener: (event: NativeDrawerIsolation) => void): Promise<PluginListenerHandle>;
    (eventName: "readmissionRequested", listener: (event: NativeDrawerReadmission) => void): Promise<PluginListenerHandle>;
    (eventName: "presentationSettled", listener: (event: NativeDrawerPresentationState) => void): Promise<PluginListenerHandle>;
  };
  apply(options: NativeDrawerProjection): Promise<NativeDrawerReceipt>;
  confirmChoice(options: NativeDrawerChoice): Promise<{ valid: boolean }>;
  settleChoice?(options: NativeDrawerIdentity & { sequence: number; privacyGeneration: number; success: boolean }): Promise<{ valid: boolean }>;
  retire(options: NativeDrawerIdentity): Promise<NativeDrawerReceipt>;
}
export const nativeDrawers = registerPlugin<HushhNativeDrawersPlugin>("HushhNativeDrawers");

/** Admission needs the whole scene handshake, including confirmed withdrawal.
 * A flag alone cannot safely transfer an editor to a partially capable wrapper.
 * Keep this mapping shared by the destination and its editor adapters. */
export function hasNativeProfileScene(plugin: HushhNativeDrawersPlugin, scene: "account-name" | "writing-style" | "support" | "phone"): boolean {
  const methods = scene === "account-name"
    ? [plugin.applyProfileNameScene, plugin.confirmProfileNameAction, plugin.settleProfileNameAction, plugin.retireProfileNameScene]
    : scene === "writing-style"
      ? [plugin.applyProfileStyleScene, plugin.confirmProfileStyleAction, plugin.settleProfileStyleAction, plugin.retireProfileStyleScene]
      : scene === "support" ? [plugin.applyProfileSupportScene, plugin.confirmProfileSupportAction, plugin.settleProfileSupportAction, plugin.retireProfileSupportScene]
      : [plugin.applyProfilePhoneScene, plugin.confirmProfilePhoneAction, plugin.settleProfilePhoneAction, plugin.retireProfilePhoneScene];
  return methods.every(method => typeof method === "function");
}

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
      "updateSequence", "privacyGeneration", "title", "sections", "open", "enabled", "backEnabled", "searchable", "loading", "surfaceOpen", "profileStack", "profileDestinationId", "profileSupportDestinationId"]) ||
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
      value.profileStack.length > 3 || new Set(value.profileStack.map(page => page?.id)).size !== value.profileStack.length ||
      value.profileStack.some((page, index) => !page || !closedShape(page, ["id", "title", "sections", "legalDocument"]) ||
        !(index === 0 ? ["account", "preferences", "voice", "security", "devices", "legal", "privacy", "terms"].includes(page.id) :
          ["account-reset", "account-delete"].includes(page.id) && index === 1 && value.profileStack?.[0]?.id === "account" ||
          page.id === "voice" && index === 1 && value.profileStack?.[0]?.id === "preferences" ||
          ["session", "devices"].includes(page.id) && index === 1 && value.profileStack?.[0]?.id === "security" ||
          page.id === "device-unlink" && (index === 1 && value.profileStack?.[0]?.id === "devices" || index === 2 && value.profileStack?.[0]?.id === "security" && value.profileStack?.[1]?.id === "devices") ||
          ["privacy", "terms"].includes(page.id) && index === 1 && value.profileStack?.[0]?.id === "legal") ||
        (["privacy", "terms"].includes(page.id) ? !page.legalDocument || !validNativeLegalDocument(page.legalDocument) ||
          page.legalDocument.type !== page.id || !Array.isArray(page.sections) || page.sections.length !== 0 : page.legalDocument !== undefined) ||
        !validText(page.title, 256) || !Array.isArray(page.sections) || page.sections.length > 32) ||
      value.profileStack.length > 0 && (!value.backEnabled || !validIdentifier(value.profileDestinationId)))) return false;
  if (value.profileDestinationId !== undefined && (!value.profileStack?.length || !validIdentifier(value.profileDestinationId))) return false;
  if (value.profileSupportDestinationId !== undefined && (value.family !== "profile" || !value.open || value.surfaceOpen !== true ||
      value.profileStack?.length !== 0 || value.profileDestinationId !== undefined || !validIdentifier(value.profileSupportDestinationId))) return false;
  for (const section of [...value.sections, ...(value.profileStack?.flatMap(page => page.sections) ?? [])]) {
    if (!section || !closedShape(section, ["id", "title", "rows"]) || !validIdentifier(section.id) || ids.has(section.id) ||
        (section.title !== undefined && !validText(section.title, 256)) ||
        !Array.isArray(section.rows)) return false;
    ids.add(section.id);
    for (const row of section.rows) {
      if (++rows > 500 || !row || !closedShape(row, ["id", "label", "detail", "symbol", "iconHex", "chevron", "trailing", "options", "toggle", "enabled", "destructive", "selected", "pending", "renameActionId", "deleteActionId", "readOnly", "artworkId"]) ||
          !validIdentifier(row.id) || ids.has(row.id) ||
          !validText(row.label, 4096) || (row.detail !== undefined && !validText(row.detail, 4096)) ||
          (row.symbol !== undefined && !validIdentifier(row.symbol)) || typeof row.enabled !== "boolean" ||
          [row.destructive, row.selected, row.pending, row.chevron, row.readOnly, row.toggle].some(item => item !== undefined && typeof item !== "boolean") ||
          row.toggle === true && row.options?.length !== 2 ||
          (row.artworkId !== undefined && !validIdentifier(row.artworkId)) ||
          (row.iconHex !== undefined && !/^#[\da-f]{6}$/i.test(row.iconHex)) ||
          (row.trailing !== undefined && !validText(row.trailing, 32))) return false;
      ids.add(row.id);
      if (row.options !== undefined) {
        if (value.family !== "profile" || !Array.isArray(row.options) || row.options.length < 2 || row.options.length > 8 ||
            row.readOnly || row.renameActionId || row.deleteActionId || row.options.filter((option: NativeDrawerOption) => option?.selected).length !== 1) return false;
        for (const option of row.options) {
          if (!option || !closedShape(option, ["id", "label", "selected", "symbol", "colorHex"]) || !validIdentifier(option.id) || ids.has(option.id) ||
              !validText(option.label, 64) || typeof option.selected !== "boolean" ||
              option.symbol !== undefined && !validIdentifier(option.symbol) ||
              option.colorHex !== undefined && !/^#[\da-f]{6}$/i.test(option.colorHex)) return false;
          ids.add(option.id);
        }
      }
      for (const action of [row.renameActionId, row.deleteActionId]) {
        if (action === undefined) continue;
        if (!validIdentifier(action) || ids.has(action)) return false;
        ids.add(action);
      }
    }
  }
  for (const page of value.profileStack ?? []) {
    if (!page.legalDocument) continue;
    for (const id of nativeLegalActionIds(page.legalDocument)) {
      if (ids.has(id)) return false;
      ids.add(id);
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
  if (choice.action === "root") return state.family === "profile" && state.backEnabled && (state.profileStack?.length ?? 0) > 1 && choice.rowId === undefined;
  if (choice.action === "ancestor") return state.family === "profile" && state.backEnabled && choice.rowId === "security" &&
    state.profileStack?.map(page => page.id).join("/") === "security/devices/device-unlink";
  if (choice.action !== "row" || !validIdentifier(choice.rowId)) return false;
  const document = valueDocument(state);
  if (document && choice.text === undefined && nativeLegalActionIds(document).includes(choice.rowId)) return true;
  return activeNativeDrawerSections(state).some(section => section.rows.some(row => row.enabled && !row.readOnly && !row.pending &&
    (row.renameActionId === choice.rowId ? typeof choice.text === "string" && choice.text.trim().length > 0 && choice.text.length <= 160 :
      (row.options ? row.options.some(option => option.id === choice.rowId && !option.selected) : row.id === choice.rowId || row.deleteActionId === choice.rowId) && choice.text === undefined)));
}

function valueDocument(state: NativeDrawerProjection): NativeLegalDocument | undefined {
  return state.profileStack?.at(-1)?.legalDocument;
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
