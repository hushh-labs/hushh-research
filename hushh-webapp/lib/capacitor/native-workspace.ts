import type { NativePresentationFeedback } from "./native-feedback-sink";
import { validNativeWalletProfileDraft, type NativeWalletProfileDraft } from "./native-wallet-profile-editor";
import { validNativeWalletCollection, type NativeWalletCollection } from "./native-wallet-workspace";
import type { PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";
import type { NativeDrawerSection, NativeDrawerOption } from "./native-drawers";

/** Private route body below the existing shell and native drawers. This is
 * additive to NativeDrawers v1, not another router or a Profile-modal lease. */
export type NativeWorkspaceIdentity = {
  documentId: string; ownerEpoch: string; ownerGeneration: number; revision: number;
  workspace: "referrals" | "wallet";
};
export type NativeWorkspaceFrame = {
  x: number; y: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number; layoutRevision: number;
  contentInset?: number;
};
export type NativeWorkspaceProjection = NativeWorkspaceIdentity & NativeControlAppearance & {
  updateSequence: number; privacyGeneration: number; isolationGeneration: number; frame: NativeWorkspaceFrame;
  page: "overview" | "rules" | "circle-picker" | "circle-create" | "circle-people";
  title: string; enabled: boolean; backEnabled: boolean;
  sections: readonly NativeDrawerSection[];
  tabs?: { label: string; options: readonly NativeDrawerOption[] };
  search?: { id: string; query: string; label: string };
  circleEditor?: NativeWorkspaceCircleEditor;
  wallet?: NativeWalletCollection;
  feedback?: NativePresentationFeedback;
  walletProfileEditor?: Omit<NativeWorkspaceCircleEditor, "draft"> & { draft: NativeWalletProfileDraft };
};
export type NativeWorkspaceCircleDraft = { name: string; kind: "family" | "friends" | "other" };
export type NativeWorkspaceCircleEditor = {
  destinationId: string; draft: NativeWorkspaceCircleDraft; draftRevision: number; acknowledgedEditRevision: number;
  busy: boolean; canSave: boolean; error: string | null;
};
export type NativeWorkspaceEdit = NativeWorkspaceIdentity & {
  destinationId: string; updateSequence: number; privacyGeneration: number; editRevision: number; composing: boolean; draft: NativeWorkspaceDraft;
};
export type NativeWorkspaceDraft = NativeWorkspaceCircleDraft | NativeWalletProfileDraft;
export type NativeWorkspaceFinalEdit = NativeWorkspaceEdit & { baseDraftRevision: number };
export type NativeWorkspaceReceipt = NativeWorkspaceIdentity & {
  updateSequence: number; privacyGeneration: number; layoutRevision: number;
  phase: "active" | "retired"; settled: boolean;
};
export type NativeWorkspaceChoice = NativeWorkspaceIdentity & {
  updateSequence: number; privacyGeneration: number; sequence: number;
  domain?: "wallet-detail"; detailVisitId?: string; dismissed?: boolean;
  action: "row" | "back" | "circle-save" | "circle-cancel" | "wallet-save" | "wallet-cancel" | "feedback-dismiss"; rowId?: string; text?: string; editRevision?: number;
};
export interface NativeWorkspacePort {
  applyWorkspace(options: NativeWorkspaceProjection): Promise<NativeWorkspaceReceipt>;
  retireWorkspace(options: NativeWorkspaceIdentity): Promise<NativeWorkspaceReceipt>;
  confirmWorkspaceChoice(options: NativeWorkspaceChoice): Promise<{ valid: boolean }>;
  settleWorkspaceChoice(options: NativeWorkspaceChoice): Promise<{ valid: boolean }>;
  getWorkspaceState(options: NativeWorkspaceIdentity): Promise<NativeWorkspaceReceipt | { valid: false }>;
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const seq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;
const closed = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
export function sameNativeWorkspace(a: NativeWorkspaceIdentity, b: NativeWorkspaceIdentity) {
  return a.documentId === b.documentId && a.ownerEpoch === b.ownerEpoch && a.ownerGeneration === b.ownerGeneration && a.revision === b.revision && a.workspace === b.workspace;
}
export function validNativeWorkspace(value: NativeWorkspaceProjection): boolean {
  if (!value || !closed(value, ["documentId", "ownerEpoch", "ownerGeneration", "revision", "workspace", "appearance", "accentHex", "foregroundHex",
    "updateSequence", "privacyGeneration", "isolationGeneration", "frame", "page", "title", "enabled", "backEnabled", "sections", "tabs", "search", "circleEditor", "wallet", "walletProfileEditor", "feedback"]) ||
    !id(value.documentId) || !id(value.ownerEpoch) || !seq(value.ownerGeneration) || !seq(value.revision) || !["referrals", "wallet"].includes(value.workspace) ||
    !seq(value.updateSequence) || !Number.isSafeInteger(value.privacyGeneration) || value.privacyGeneration < 0 || !Number.isSafeInteger(value.isolationGeneration) || value.isolationGeneration < 0 ||
    !["light", "dark"].includes(value.appearance) || ![value.accentHex, value.foregroundHex].every(v => /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(v)) ||
    !["overview", "rules", "circle-picker", "circle-create", "circle-people"].includes(value.page) || !text(value.title, 256) ||
    typeof value.enabled !== "boolean" || typeof value.backEnabled !== "boolean" || !Array.isArray(value.sections) || value.sections.length > 32) return false;
  if (value.workspace === "wallet" ? !value.wallet || !validNativeWalletCollection(value.wallet) || value.page !== "overview" || value.circleEditor !== undefined : value.wallet !== undefined) return false;
  if (value.feedback !== undefined) {
    const f = value.feedback;
    if (!f || !closed(f, ["id", "message", "tone", "dismissible"]) || !id(f.id) || !text(f.message, 2048) ||
      !["normal", "loading", "success", "error", "warning", "info"].includes(f.tone) || typeof f.dismissible !== "boolean") return false;
  }
  const frame = value.frame;
  if (!frame || !closed(frame, ["x", "y", "width", "height", "viewportWidth", "viewportHeight", "layoutRevision", "contentInset"]) ||
    !seq(frame.layoutRevision) || !Object.values(frame).every(Number.isFinite) || frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0 ||
    frame.viewportWidth <= 0 || frame.viewportHeight <= 0 || frame.viewportWidth > 10000 || frame.viewportHeight > 10000 ||
    frame.x + frame.width > frame.viewportWidth + 1 || frame.y + frame.height > frame.viewportHeight + 1 ||
    frame.contentInset !== undefined && (frame.contentInset < 0 || frame.contentInset > 64 || frame.contentInset * 2 >= frame.width)) return false;
  const ids = new Set<string>(); let count = 0;
  const insert = (key: unknown) => id(key) && !ids.has(key) && !!ids.add(key);
  for (const section of value.sections) {
    if (!section || !closed(section, ["id", "title", "rows"]) || !insert(section.id) || section.title !== undefined && !text(section.title, 256) || !Array.isArray(section.rows)) return false;
    for (const row of section.rows) {
      // The first bounded workspace family has no credential fields, history
      // actions, portrait blobs, arbitrary menus, URLs or operation parameters.
      if (++count > 200 || !row || !closed(row, ["id", "label", "detail", "symbol", "artworkId", "iconHex", "chevron", "trailing", "enabled", "destructive", "selected", "pending", "readOnly"]) ||
        !insert(row.id) || !text(row.label, 4096) || row.detail !== undefined && !text(row.detail, 4096) || row.trailing !== undefined && !text(row.trailing, 32) ||
        row.symbol !== undefined && !id(row.symbol) || row.artworkId !== undefined && !id(row.artworkId) || row.iconHex !== undefined && !/^#[\da-f]{6}$/i.test(row.iconHex) ||
        typeof row.enabled !== "boolean" || [row.chevron, row.destructive, row.selected, row.pending, row.readOnly].some(v => v !== undefined && typeof v !== "boolean")) return false;
    }
  }
  if (value.wallet) {
    for (const key of [value.wallet.addId, value.wallet.closeId, ...value.wallet.cards.map(card => card.id), ...(value.wallet.accessId ? [value.wallet.accessId] : [])]) if (!insert(key)) return false;
  }
  if (value.tabs !== undefined) {
    if (!value.tabs || !closed(value.tabs, ["label", "options"]) || !text(value.tabs.label, 64) || !Array.isArray(value.tabs.options) ||
      value.tabs.options.length < 2 || value.tabs.options.length > 4 || value.tabs.options.filter(v => v.selected).length !== 1) return false;
    for (const option of value.tabs.options) if (!option || !closed(option, ["id", "label", "selected"]) || !insert(option.id) || !text(option.label, 64) || typeof option.selected !== "boolean") return false;
  }
  if (value.search !== undefined && (!value.search || !closed(value.search, ["id", "query", "label"]) || !insert(value.search.id) ||
    typeof value.search.query !== "string" || value.search.query.length > 256 || !text(value.search.label, 64))) return false;
  if (value.circleEditor !== undefined) {
    const e = value.circleEditor;
    if (value.page !== "circle-create" || !e || !closed(e, ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error"]) ||
      !id(e.destinationId) || !validWorkspaceCircleDraft(e.draft) || !Number.isSafeInteger(e.draftRevision) || e.draftRevision < 0 ||
      !Number.isSafeInteger(e.acknowledgedEditRevision) || e.acknowledgedEditRevision < 0 || typeof e.busy !== "boolean" || typeof e.canSave !== "boolean" ||
      e.error !== null && (typeof e.error !== "string" || e.error.length > 1024)) return false;
  }
  if (value.walletProfileEditor !== undefined) {
    const e = value.walletProfileEditor;
    if (value.workspace !== "wallet" || !value.wallet?.selectedId || !e || !closed(e, ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error"]) ||
      !id(e.destinationId) || !validNativeWalletProfileDraft(e.draft) || !Number.isSafeInteger(e.draftRevision) || e.draftRevision < 0 ||
      !Number.isSafeInteger(e.acknowledgedEditRevision) || e.acknowledgedEditRevision < 0 || typeof e.busy !== "boolean" || typeof e.canSave !== "boolean" ||
      e.error !== null && (typeof e.error !== "string" || e.error.length > 1024)) return false;
  }
  return true;
}
export function validWorkspaceCircleDraft(value: unknown): value is NativeWorkspaceCircleDraft {
  const draft = value as NativeWorkspaceCircleDraft;
  return !!draft && typeof draft === "object" && !Array.isArray(draft) && closed(draft, ["name", "kind"]) &&
    typeof draft.name === "string" && draft.name.length <= 80 && ["family", "friends", "other"].includes(draft.kind);
}
export function workspaceAcknowledged(receipt: NativeWorkspaceReceipt, state: NativeWorkspaceProjection, phase: NativeWorkspaceReceipt["phase"]) {
  return !!receipt && sameNativeWorkspace(receipt, state) && receipt.updateSequence === state.updateSequence && receipt.privacyGeneration === state.privacyGeneration &&
    receipt.layoutRevision === state.frame.layoutRevision && receipt.phase === phase && receipt.settled === true;
}
export type NativeWorkspaceEvents = {
  addListener(event: "workspaceChoice", listener: (choice: NativeWorkspaceChoice) => void): Promise<PluginListenerHandle>;
};

/** A confirmed child may act while its own scrim isolates the collection.
 * That admission never grants access to base tabs or another child visit. */
export function workspaceChoiceDomainAllowed(choice: NativeWorkspaceChoice, state: NativeWorkspaceProjection, isolated: boolean): boolean {
  if (choice.domain === undefined) return !isolated && choice.detailVisitId === undefined && choice.dismissed === undefined;
  const wallet = state.wallet;
  if (choice.domain !== "wallet-detail" || state.workspace !== "wallet" || !wallet?.selectedId ||
    !wallet.detailVisitId || wallet.detailVisitId !== choice.detailVisitId) return false;
  if (choice.dismissed) return choice.action === "row" && choice.rowId === wallet.closeId && !wallet.detailBusy && choice.text === undefined;
  if (choice.action === "feedback-dismiss") return typeof choice.rowId === "string" && choice.rowId === state.feedback?.id && state.feedback?.dismissible === true && choice.text === undefined;
  if (choice.action === "wallet-save" || choice.action === "wallet-cancel") return !!state.walletProfileEditor && choice.rowId === undefined && choice.text === undefined;
  if (choice.action !== "row" || !choice.rowId) return false;
  if (choice.rowId === wallet.closeId) return !wallet.detailBusy && choice.text === undefined;
  if (state.search?.id === choice.rowId) return typeof choice.text === "string" && choice.text.length <= 256;
  return choice.text === undefined && state.sections.some(section => section.rows.some(row => row.id === choice.rowId && row.enabled && !row.pending && !row.readOnly));
}
