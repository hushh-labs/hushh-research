import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";
import type { NativeProfileNameScenePort } from "./native-profile-name-scene";
import type { NativePasswordScenePort } from "./native-profile-password-scene";
import type { NativeProfilePricingScenePort } from "./native-profile-pricing-scene";
import type { NativeProfileStyleScenePort } from "./native-profile-style-scene";
import type { NativeSupportScenePort } from "./native-profile-support-scene";
import type { NativePhoneScenePort } from "./native-profile-phone-scene";
import type { NativeWorldModelScenePort } from "./native-profile-world-model-scene";
import type { NativeRuntimeScenePort } from "./native-profile-runtime-scene";
import type { NativeConnectorScenePort } from "./native-profile-connector-scene";
import type { NativeMemoryScenePort } from "./native-profile-memory-scene";
import type { NativeWorkspacePort, NativeWorkspaceChoice, NativeWorkspaceEdit, NativeWorkspaceFinalEdit } from "./native-workspace";
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
  /** Private raster-only Profile header; never a URL or public chrome field. */
  portrait?: boolean;
  portraitData?: string;
  renameActionId?: string;
  deleteActionId?: string;
};
export type NativeDrawerSection = { id: string; title?: string; rows: readonly NativeDrawerRow[] };
/** Bounded native destinations, not URLs or another routing authority. */
export type NativePayoutPageId = "payouts" | "payout-activity" | "payout-stripe" | `payout-receipt-${1 | 2 | 3 | 4 | 5 | 6}`;
export type NativeMemoryPageId = "memory" | "memory-domain" | "memory-section" | "memory-entity" | "memory-sharing" | "memory-connection" | "memory-confirm" | "memory-live" | "memory-record" | "memory-shared" | "memory-shared-person" | "memory-received" | "memory-received-files" | "memory-secrets" | "memory-secret" | "memory-secret-remove" | "memory-identity";
export type NativeWorldModelPageId = "world-model" | "world-model-fact" | "world-model-remove" | "world-model-research" | "world-model-sources" | "world-model-invitations" | "world-model-review" | "world-model-review-fact";
export type NativeConnectorPageId = "connectors" | "connector-detail" | "connector-confirm" | "connector-custom" | "connector-custom-detail" | "connector-custom-confirm" |
  "connector-preparation" | "connector-files" | "connector-selection" | "connector-packets" | "connector-packet" | "connector-trust" | "connector-trust-rule" | "connector-trust-confirm";
export type NativeProfilePage = { id: NativeConnectorPageId | NativeWorldModelPageId | NativeMemoryPageId | NativePayoutPageId | "request-pricing" | "account" | "account-reset" | "account-delete" | "preferences" | "gemini" | "finance-preferences" | "finance-anchor" | "voice" | "security" | "session" | "devices" | "device-unlink" | "vault" | "vault-method" | "vault-remove" | "legal" | "privacy" | "terms";
  title: string; sections: readonly NativeDrawerSection[]; legalDocument?: NativeLegalDocument;
  /** Private feature filter (legacy wire name), submitted to its owning model. */
  memorySearch?: { id: string; query: string } };
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
  /** Keep reconciliation/Retry usable without discarding an uncertain write. */
  navigationLocked?: boolean;
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
export interface HushhNativeDrawersPlugin extends Partial<NativeWorkspacePort> {
  applyProfileMemoryScene?: NativeMemoryScenePort["applyProfileMemoryScene"];
  confirmProfileMemoryAction?: NativeMemoryScenePort["confirmProfileMemoryAction"];
  settleProfileMemoryAction?: NativeMemoryScenePort["settleProfileMemoryAction"];
  retireProfileMemoryScene?: NativeMemoryScenePort["retireProfileMemoryScene"];
  applyProfileConnectorScene?: NativeConnectorScenePort["applyProfileConnectorScene"];
  confirmProfileConnectorAction?: NativeConnectorScenePort["confirmProfileConnectorAction"];
  settleProfileConnectorAction?: NativeConnectorScenePort["settleProfileConnectorAction"];
  retireProfileConnectorScene?: NativeConnectorScenePort["retireProfileConnectorScene"];
  applyProfileRuntimeScene?: NativeRuntimeScenePort["applyProfileRuntimeScene"];
  confirmProfileRuntimeAction?: NativeRuntimeScenePort["confirmProfileRuntimeAction"];
  settleProfileRuntimeAction?: NativeRuntimeScenePort["settleProfileRuntimeAction"];
  retireProfileRuntimeScene?: NativeRuntimeScenePort["retireProfileRuntimeScene"];
  getCapabilities(): Promise<NativeDrawerIsolation & { closeSettlements?: boolean;
    contractVersion: number; supported: boolean; wholePresentation: boolean; historyActions?: boolean; terminalRefreshes?: boolean; terminalReadmission?: boolean; presentationCompletion?: boolean; profileMenuRows?: boolean; profileContentHandoff?: boolean; profileNavigationStack?: boolean; compatibleBackRefreshes?: boolean; profileSettingsPages?: boolean; profileVoiceSettings?: boolean; profileTrustedDevices?: boolean; profileAccountActions?: boolean; profileLegalReader?: boolean; agentProfileMenu?: boolean; profileNameScene?: boolean; profileStyleScene?: boolean; profileSupportScene?: boolean; profilePhoneScene?: boolean; profilePortrait?: boolean; profilePricingScene?: boolean; profilePayoutPages?: boolean; profileMemoryPages?: boolean; profileSharedMemoryPages?: boolean; profileSecretMemoryPages?: boolean; profileMemoryScene?: boolean; profileWorldModelPages?: boolean; profileWorldModelPublicProfiles?: boolean; profileFinancePreferences?: boolean; profileVaultMethods?: boolean; profilePasswordScene?: boolean; profileRuntimeScene?: boolean; profileConnectorScene?: boolean; profileConnectorPages?: boolean; routeWorkspaces?: readonly "referrals"[] }>;
  applyProfileWorldModelScene?: NativeWorldModelScenePort["applyProfileWorldModelScene"];
  confirmProfileWorldModelAction?: NativeWorldModelScenePort["confirmProfileWorldModelAction"];
  settleProfileWorldModelAction?: NativeWorldModelScenePort["settleProfileWorldModelAction"];
  retireProfileWorldModelScene?: NativeWorldModelScenePort["retireProfileWorldModelScene"];
  applyProfilePricingScene?(options: Parameters<NativeProfilePricingScenePort["applyProfilePricingScene"]>[0]): ReturnType<NativeProfilePricingScenePort["applyProfilePricingScene"]>;
  confirmProfilePricingAction?(options: Parameters<NativeProfilePricingScenePort["confirmProfilePricingAction"]>[0]): ReturnType<NativeProfilePricingScenePort["confirmProfilePricingAction"]>;
  settleProfilePricingAction?(options: Parameters<NativeProfilePricingScenePort["settleProfilePricingAction"]>[0]): ReturnType<NativeProfilePricingScenePort["settleProfilePricingAction"]>;
  retireProfilePricingScene?(options: Parameters<NativeProfilePricingScenePort["retireProfilePricingScene"]>[0]): ReturnType<NativeProfilePricingScenePort["retireProfilePricingScene"]>;
  applyProfilePasswordScene?(options: Parameters<NativePasswordScenePort["applyProfilePasswordScene"]>[0]): ReturnType<NativePasswordScenePort["applyProfilePasswordScene"]>;
  confirmProfilePasswordAction?(options: Parameters<NativePasswordScenePort["confirmProfilePasswordAction"]>[0]): ReturnType<NativePasswordScenePort["confirmProfilePasswordAction"]>;
  settleProfilePasswordAction?(options: Parameters<NativePasswordScenePort["settleProfilePasswordAction"]>[0]): ReturnType<NativePasswordScenePort["settleProfilePasswordAction"]>;
  retireProfilePasswordScene?(options: Parameters<NativePasswordScenePort["retireProfilePasswordScene"]>[0]): ReturnType<NativePasswordScenePort["retireProfilePasswordScene"]>;
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
  addListener: NativeMemoryScenePort["addListener"] & NativeConnectorScenePort["addListener"] & NativeRuntimeScenePort["addListener"] & NativeWorldModelScenePort["addListener"] & NativeProfilePricingScenePort["addListener"] & NativePasswordScenePort["addListener"] & NativeProfileNameScenePort["addListener"] & NativeProfileStyleScenePort["addListener"] & NativeSupportScenePort["addListener"] & NativePhoneScenePort["addListener"] & {
    (eventName: "choice", listener: (event: NativeDrawerChoice) => void): Promise<PluginListenerHandle>;
    (eventName: "workspaceChoice", listener: (event: NativeWorkspaceChoice) => void): Promise<PluginListenerHandle>;
    (eventName: "workspaceEdit", listener: (event: NativeWorkspaceEdit) => void): Promise<PluginListenerHandle>;
    (eventName: "workspaceFinalEdit", listener: (event: NativeWorkspaceFinalEdit) => void): Promise<PluginListenerHandle>;
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
export function hasNativeProfileScene(plugin: HushhNativeDrawersPlugin, scene: "account-name" | "writing-style" | "support" | "phone" | "vault-passphrase" | "request-price" | "world-model" | "runtime-provider" | "connector-custom-server" | "memory-financial-context"): boolean {
  const methods = scene === "memory-financial-context" ? [plugin.applyProfileMemoryScene, plugin.confirmProfileMemoryAction, plugin.settleProfileMemoryAction, plugin.retireProfileMemoryScene]
    : scene === "account-name"
    ? [plugin.applyProfileNameScene, plugin.confirmProfileNameAction, plugin.settleProfileNameAction, plugin.retireProfileNameScene]
    : scene === "writing-style"
      ? [plugin.applyProfileStyleScene, plugin.confirmProfileStyleAction, plugin.settleProfileStyleAction, plugin.retireProfileStyleScene]
      : scene === "support" ? [plugin.applyProfileSupportScene, plugin.confirmProfileSupportAction, plugin.settleProfileSupportAction, plugin.retireProfileSupportScene]
      : scene === "vault-passphrase" ? [plugin.applyProfilePasswordScene, plugin.confirmProfilePasswordAction, plugin.settleProfilePasswordAction, plugin.retireProfilePasswordScene]
      : scene === "request-price" ? [plugin.applyProfilePricingScene, plugin.confirmProfilePricingAction, plugin.settleProfilePricingAction, plugin.retireProfilePricingScene]
      : scene === "world-model" ? [plugin.applyProfileWorldModelScene, plugin.confirmProfileWorldModelAction, plugin.settleProfileWorldModelAction, plugin.retireProfileWorldModelScene]
      : scene === "connector-custom-server" ? [plugin.applyProfileConnectorScene, plugin.confirmProfileConnectorAction, plugin.settleProfileConnectorAction, plugin.retireProfileConnectorScene]
      : scene === "runtime-provider" ? [plugin.applyProfileRuntimeScene, plugin.confirmProfileRuntimeAction, plugin.settleProfileRuntimeAction, plugin.retireProfileRuntimeScene]
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

/** Closed financial presentation ancestry; never admits arbitrary destinations. */
export function validNativePayoutPath(pages: readonly NativeProfilePage[]): boolean {
  if (pages[0]?.id !== "payouts" || pages.length > 8) return false;
  const start = ["payout-activity", "payout-stripe"].includes(pages[1]?.id ?? "") ? 2 : 1;
  return pages.slice(start).every((page, index) => page?.id === `payout-receipt-${index + 1}`) && pages.length - start <= 6;
}

export function validNativeMemoryPath(pages: readonly NativeProfilePage[]): boolean {
  if (pages[0]?.id !== "memory" || pages.length > 5) return false;
  const children: Partial<Record<NativeMemoryPageId, readonly NativeMemoryPageId[]>> = {
    memory: ["memory-domain", "memory-sharing", "memory-live", "memory-shared", "memory-received", "memory-secrets"],
    "memory-secrets": ["memory-secret", "memory-identity"], "memory-secret": ["memory-secret-remove", "memory-identity"],
    "memory-shared": ["memory-shared-person"], "memory-received": ["memory-received-files"],
    "memory-domain": ["memory-section"], "memory-section": ["memory-entity"],
    "memory-entity": ["memory-confirm"], "memory-sharing": ["memory-connection"],
    "memory-connection": ["memory-confirm"], "memory-live": ["memory-record"],
  };
  return pages.slice(1).every((page, index) => children[pages[index]!.id as NativeMemoryPageId]?.includes(page.id as NativeMemoryPageId));
}

export function validNativeFinancePath(pages: readonly NativeProfilePage[]): boolean {
  const path = pages.map(page => page?.id);
  const start = path[0] === "preferences" ? 1 : 0;
  return path[start] === "finance-preferences" && path.length <= start + 2 &&
    (path.length === start + 1 || path[start + 1] === "finance-anchor");
}

export function validNativeConnectorPath(pages: readonly NativeProfilePage[]): boolean {
  if (pages[0]?.id !== "connectors" || pages.length > 5) return false;
  const children: Partial<Record<NativeConnectorPageId, readonly NativeConnectorPageId[]>> = {
    connectors: ["connector-detail", "connector-confirm", "connector-custom", "connector-custom-detail", "connector-custom-confirm"],
    "connector-detail": ["connector-confirm", "connector-preparation", "connector-files", "connector-selection", "connector-packets", "connector-trust"],
    "connector-files": ["connector-confirm", "connector-selection"], "connector-packets": ["connector-packet"], "connector-trust": ["connector-trust-rule"], "connector-trust-rule": ["connector-trust-confirm"],
    "connector-custom-detail": ["connector-custom-confirm"],
  };
  return pages.slice(1).every((page, index) => children[pages[index]!.id as NativeConnectorPageId]?.includes(page.id as NativeConnectorPageId));
}

export function validNativeWorldModelPath(pages: readonly NativeProfilePage[]): boolean {
  if (pages[0]?.id !== "world-model" || pages.length > 4) return false;
  const children: Partial<Record<NativeWorldModelPageId, readonly NativeWorldModelPageId[]>> = {
    "world-model": ["world-model-fact", "world-model-research", "world-model-sources", "world-model-invitations"],
    "world-model-fact": ["world-model-remove"], "world-model-sources": ["world-model-review"],
    "world-model-review": ["world-model-review-fact"],
  };
  return pages.slice(1).every((page, index) => children[pages[index]!.id as NativeWorldModelPageId]?.includes(page.id as NativeWorldModelPageId));
}

/** Bounded authored projections only: no DOM inference, URL, token, credential,
 * arbitrary view tree, provider payload or action transport in this contract. */
export function validNativeDrawerProjection(value: NativeDrawerProjection): boolean {
  if (!value || !closedShape(value, ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "appearance", "accentHex", "foregroundHex",
      "updateSequence", "privacyGeneration", "title", "sections", "open", "enabled", "backEnabled", "navigationLocked", "searchable", "loading", "surfaceOpen", "profileStack", "profileDestinationId", "profileSupportDestinationId"]) ||
      !validIdentifier(value.documentId) || !validIdentifier(value.ownerEpoch) ||
      !validSequence(value.ownerGeneration) || !validSequence(value.revision) || !validSequence(value.updateSequence) ||
      !["history", "profile", "agent-profile"].includes(value.family) ||
      !Number.isSafeInteger(value.privacyGeneration) || value.privacyGeneration < 0 ||
      ![value.open, value.enabled, value.backEnabled].every(item => typeof item === "boolean") ||
      value.navigationLocked !== undefined && (value.family !== "profile" || typeof value.navigationLocked !== "boolean") ||
      [value.searchable, value.loading].some(item => item !== undefined && typeof item !== "boolean") ||
      value.surfaceOpen !== undefined && (typeof value.surfaceOpen !== "boolean" || value.family !== "profile" || value.open && !value.surfaceOpen) ||
      !["light", "dark"].includes(value.appearance) ||
      ![value.accentHex, value.foregroundHex].every(color => /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) ||
      !validText(value.title, 256) || !Array.isArray(value.sections) || value.sections.length > 32) return false;
  const ids = new Set<string>();
  let rows = 0;
  if (value.profileStack !== undefined && (value.family !== "profile" || !Array.isArray(value.profileStack) ||
      value.profileStack.length > (value.profileStack[0]?.id === "payouts" ? 8 : ["memory", "connectors"].includes(value.profileStack[0]?.id ?? "") ? 5 : value.profileStack[0]?.id === "world-model" ? 4 : 3) ||
      value.profileStack[0]?.id === "payouts" && !validNativePayoutPath(value.profileStack) ||
      value.profileStack[0]?.id === "memory" && !validNativeMemoryPath(value.profileStack) ||
      value.profileStack[0]?.id === "world-model" && !validNativeWorldModelPath(value.profileStack) ||
      value.profileStack[0]?.id === "connectors" && !validNativeConnectorPath(value.profileStack) ||
      value.profileStack.some(page => page && ["finance-preferences", "finance-anchor"].includes(page.id)) && !validNativeFinancePath(value.profileStack) ||
      new Set(value.profileStack.map(page => page?.id)).size !== value.profileStack.length ||
      value.profileStack.some((page, index) => !page || !closedShape(page, ["id", "title", "sections", "legalDocument", "memorySearch"]) ||
        page.memorySearch !== undefined && (!["memory", "connectors"].includes(page.id) || !page.memorySearch || typeof page.memorySearch !== "object" || Array.isArray(page.memorySearch) || !closedShape(page.memorySearch, ["id", "query"]) ||
          !validIdentifier(page.memorySearch.id) || typeof page.memorySearch.query !== "string" || page.memorySearch.query.length > 256) ||
        !(index === 0 ? ["connectors", "world-model", "memory", "payouts", "request-pricing", "account", "preferences", "gemini", "finance-preferences", "voice", "security", "devices", "vault", "legal", "privacy", "terms"].includes(page.id) :
          validNativeFinancePath(value.profileStack!) ||
          value.profileStack?.[0]?.id === "memory" && validNativeMemoryPath(value.profileStack) ||
          value.profileStack?.[0]?.id === "world-model" && validNativeWorldModelPath(value.profileStack) ||
          value.profileStack?.[0]?.id === "connectors" && validNativeConnectorPath(value.profileStack) ||
          value.profileStack?.[0]?.id === "payouts" && validNativePayoutPath(value.profileStack) ||
          ["account-reset", "account-delete"].includes(page.id) && index === 1 && value.profileStack?.[0]?.id === "account" ||
          ["voice", "gemini"].includes(page.id) && index === 1 && value.profileStack?.[0]?.id === "preferences" ||
          ["session", "devices"].includes(page.id) && index === 1 && value.profileStack?.[0]?.id === "security" ||
          page.id === "device-unlink" && (index === 1 && value.profileStack?.[0]?.id === "devices" || index === 2 && value.profileStack?.[0]?.id === "security" && value.profileStack?.[1]?.id === "devices") ||
          page.id === "vault" && index === 1 && value.profileStack?.[0]?.id === "security" ||
          ["vault-method", "vault-remove"].includes(page.id) && (index === 1 && value.profileStack?.[0]?.id === "vault" || index === 2 && value.profileStack?.[0]?.id === "security" && value.profileStack?.[1]?.id === "vault") ||
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
      if (++rows > 500 || !row || !closedShape(row, ["id", "label", "detail", "symbol", "iconHex", "chevron", "trailing", "options", "toggle", "enabled", "destructive", "selected", "pending", "renameActionId", "deleteActionId", "readOnly", "artworkId", "portrait", "portraitData"]) ||
          !validIdentifier(row.id) || ids.has(row.id) ||
          !validText(row.label, 4096) || (row.detail !== undefined && !validText(row.detail, 4096)) ||
          (row.symbol !== undefined && !validIdentifier(row.symbol)) || typeof row.enabled !== "boolean" ||
          [row.destructive, row.selected, row.pending, row.chevron, row.readOnly, row.toggle].some(item => item !== undefined && typeof item !== "boolean") ||
          row.toggle === true && row.options?.length !== 2 ||
          (row.artworkId !== undefined && !validIdentifier(row.artworkId)) ||
          (row.iconHex !== undefined && !/^#[\da-f]{6}$/i.test(row.iconHex)) ||
          (row.trailing !== undefined && !validText(row.trailing, 32))) return false;
      if (row.portrait !== undefined && (row.portrait !== true || value.family !== "profile" ||
          !(section.id === "identity-section" && row.id === "identity" || section.id === "account-portrait" && row.id === "account-photo")) ||
          row.portrait === true && (row.readOnly || row.options || row.toggle || row.renameActionId || row.deleteActionId) ||
          row.portraitData !== undefined && (row.portrait !== true || typeof row.portraitData !== "string" || row.portraitData.length > 100_000 ||
            !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(row.portraitData))) return false;
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
    if (page.memorySearch) {
      if (ids.has(page.memorySearch.id)) return false;
      ids.add(page.memorySearch.id);
    }
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
  if (state.navigationLocked && ["back", "root", "ancestor", "close"].includes(choice.action)) return false;
  if (choice.action === "open") return !state.open && choice.rowId === undefined;
  if (!state.open) return false;
  if (choice.action === "close") return choice.rowId === undefined;
  if (choice.action === "back") return state.backEnabled && choice.rowId === undefined;
  if (choice.action === "root") return state.family === "profile" && state.backEnabled && (state.profileStack?.length ?? 0) > 1 && choice.rowId === undefined;
  if (choice.action === "ancestor") return state.family === "profile" && state.backEnabled &&
    (choice.rowId === "security" && ["security/devices/device-unlink", "security/vault/vault-method", "security/vault/vault-remove"].includes(state.profileStack?.map(page => page.id).join("/") ?? "") ||
      !!state.profileStack && (validNativePayoutPath(state.profileStack) || validNativeMemoryPath(state.profileStack) || validNativeFinancePath(state.profileStack) || validNativeWorldModelPath(state.profileStack) || validNativeConnectorPath(state.profileStack)) && state.profileStack.slice(0, -2).some(page => page.id === choice.rowId));
  if (choice.action !== "row" || !validIdentifier(choice.rowId)) return false;
  if (state.profileStack?.at(-1)?.memorySearch?.id === choice.rowId) return typeof choice.text === "string" && choice.text.length <= 256;
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
  private backRefreshes = false;
  private backUpdateFloor = 0;
  private backBoundary: string | null = null;
  constructor(readonly identity: NativeDrawerIdentity) {}
  enableTerminalRefreshes(): void { if (!this.current) this.terminalRefreshes = true; }
  enableCompatibleBackRefreshes(): void { if (!this.current && this.identity.family === "profile") this.backRefreshes = true; }
  update(state: NativeDrawerProjection): boolean {
    if (this.retired || !validNativeDrawerProjection(state) || !sameNativeDrawer(this.identity, state) ||
        (this.current && state.updateSequence <= this.current.updateSequence)) return false;
    if (!this.current || this.current.open !== state.open || this.current.enabled !== state.enabled ||
        this.current.privacyGeneration !== state.privacyGeneration) this.terminalUpdateFloor = state.updateSequence;
    // Monotonic across A → B → A and lock/unlock, not a comparison with the
    // original values at confirmation time. Only navigation metadata belongs
    // here; row choices and private bodies retain their exact revision fence.
    const backBoundary = JSON.stringify([state.privacyGeneration, state.open, state.enabled, state.backEnabled,
      state.navigationLocked ?? false, state.surfaceOpen ?? null, state.profileDestinationId ?? null,
      state.profileSupportDestinationId ?? null, state.profileStack?.map(page => page.id) ?? null]);
    if (this.backBoundary !== backBoundary) { this.backUpdateFloor = state.updateSequence; this.backBoundary = backBoundary; }
    this.current = state;
    this.generation++;
    return true;
  }
  retire() { this.retired = true; this.current = null; this.generation++; }
  terminalLifetimeIsCurrent(choice: NativeDrawerChoice): boolean {
    return !this.retired && !!this.current && (choice.action === "open" || choice.action === "close") &&
      sameNativeDrawer(choice, this.current) && choice.privacyGeneration === this.current.privacyGeneration &&
      validSequence(choice.updateSequence) && choice.updateSequence >= this.terminalUpdateFloor &&
      choice.updateSequence <= this.current.updateSequence;
  }
  terminalIsCurrent(choice: NativeDrawerChoice): boolean {
    return !!this.current && this.terminalLifetimeIsCurrent(choice) &&
      nativeDrawerChoiceAllowed({ ...choice, updateSequence: this.current.updateSequence }, this.current);
  }
  backIsCurrent(choice: NativeDrawerChoice): boolean {
    if (!this.backRefreshes || this.retired || !this.current?.profileStack ||
        !["back", "root", "ancestor"].includes(choice.action)) return false;
    return validSequence(choice.updateSequence) && choice.updateSequence >= this.backUpdateFloor &&
      choice.updateSequence <= this.current.updateSequence &&
      nativeDrawerChoiceAllowed({ ...choice, updateSequence: this.current.updateSequence }, this.current);
  }
  allows(choice: NativeDrawerChoice): boolean {
    if (this.retired || !this.current) return false;
    if (this.backIsCurrent(choice)) return true;
    if (!this.terminalRefreshes || choice.action !== "open" && choice.action !== "close") {
      return nativeDrawerChoiceAllowed(choice, this.current);
    }
    // Drawer Open/Close use their own compatibility floor, separate from Back.
    // Native still confirms the exact emitted token and interaction generation.
    return this.terminalIsCurrent(choice);
  }
  async consume(choice: NativeDrawerChoice, confirm: () => Promise<{ valid: boolean }>,
    isCurrent: () => boolean, invoke: () => void | Promise<void>): Promise<boolean> {
    if (!this.current || choice.sequence <= this.consumed ||
        !this.allows(choice) || !isCurrent()) return false;
    const terminal = this.terminalRefreshes && (choice.action === "open" || choice.action === "close");
    const compatibleBack = this.backIsCurrent(choice);
    const generation = terminal ? this.terminalUpdateFloor : compatibleBack ? this.backUpdateFloor : this.generation;
    const result = await confirm();
    if (!result.valid || generation !== (terminal ? this.terminalUpdateFloor : compatibleBack ? this.backUpdateFloor : this.generation) || !this.current ||
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
