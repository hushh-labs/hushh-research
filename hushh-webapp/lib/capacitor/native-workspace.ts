import type { NativeFeedbackActionToken, NativePresentationFeedback } from "./native-feedback-sink";
import { validNativeWalletProfileDraft, type NativeWalletProfileDraft } from "./native-wallet-profile-editor";
import { validNativeWalletCollection, type NativeWalletCollection } from "./native-wallet-workspace";
import type { PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";
import type { NativeDrawerRow, NativeDrawerSection, NativeDrawerOption, NativeWorkspaceInlineAction } from "./native-drawers";

/** Private route body below the existing shell and native drawers. This is
 * additive to NativeDrawers v1, not another router or a Profile-modal lease. */
export type NativeWorkspaceIdentity = {
  documentId: string; ownerEpoch: string; ownerGeneration: number; revision: number;
  workspace: "referrals" | "wallet" | "memory" | "consent" | "tasks" | "feed" | "connect" | "email" | "launcher" | "mail" | "calendar" | "finance" | "career" | "location" | "setup";
};
export type NativeWorkspaceFrame = {
  x: number; y: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number; layoutRevision: number;
  contentInset?: number;
  bottomContentInset?: number;
};
export type NativeWorkspaceFrameAnchors = {
  seat: { x: number; y: number; width: number; height: number };
  shell: { x: number; width: number };
  viewport: { width: number; height: number };
  shellInsets: { left: number; right: number };
  layoutRevision: number;
  bottomContentInset?: number;
};
/** AppPageShell owns the horizontal frame/inset; the fixed shell seat owns the vertical frame. */
export function nativeWorkspaceFrameFromAnchors(anchors: NativeWorkspaceFrameAnchors): NativeWorkspaceFrame | null {
  const { seat, shell, viewport, shellInsets, layoutRevision } = anchors;
  const bottomContentInset = anchors.bottomContentInset ?? 0;
  if (![seat.x, seat.y, seat.width, seat.height, shell.x, shell.width, viewport.width, viewport.height,
    shellInsets.left, shellInsets.right, layoutRevision, bottomContentInset].every(Number.isFinite) ||
    bottomContentInset < 0 || bottomContentInset >= seat.height ||
    seat.width <= 0 || seat.height <= 0 || shell.width <= 0 || viewport.width <= 0 || viewport.height <= 0 || layoutRevision <= 0 ||
    shell.x < seat.x - 1 || shell.x + shell.width > seat.x + seat.width + 1 ||
    shellInsets.left < 0 || shellInsets.right < 0 || Math.abs(shellInsets.left - shellInsets.right) > 1 || shellInsets.left * 2 >= shell.width) return null;
  return { x: shell.x, y: seat.y, width: shell.width, height: seat.height, viewportWidth: viewport.width,
    viewportHeight: viewport.height, layoutRevision, contentInset: shellInsets.left,
    ...(bottomContentInset > 0 ? { bottomContentInset } : {}) };
}
export type NativeWorkspaceProjection = NativeWorkspaceIdentity & NativeControlAppearance & {
  /** Wallet canvas sampled from the committed app CSS `--background` token. */
  canvasHex?: string;
  updateSequence: number; privacyGeneration: number; isolationGeneration: number; frame: NativeWorkspaceFrame;
  page: "overview" | "rules" | "circle-picker" | "circle-create" | "circle-people";
  title: string; enabled: boolean; backEnabled: boolean;
  sections: readonly NativeDrawerSection[];
  tabs?: { label: string; options: readonly NativeDrawerOption[] };
  secondaryTabs?: { label: string; options: readonly NativeDrawerOption[] };
  search?: { id: string; query: string; label: string; live?: boolean; afterSection?: number };
  calendarDate?: { id: string; label: string; value: string; timeZone: string; enabled: boolean };
  launcher?: { view: "grid" | "list"; agents: readonly NativeWorkspaceAgent[] };
  circleEditor?: NativeWorkspaceCircleEditor;
  taskEditor?: Omit<NativeWorkspaceCircleEditor, "draft"> & { draft: NativeWorkspaceTaskDraft };
  wallet?: NativeWalletCollection;
  feedback?: NativePresentationFeedback;
  walletProfileEditor?: Omit<NativeWorkspaceCircleEditor, "draft"> & { draft: NativeWalletProfileDraft };
  memoryEditor?: Omit<NativeWorkspaceCircleEditor, "draft"> & { draft: NativeWorkspaceMemoryDraft; canToggleIdentifier: boolean; reviewing: boolean };
};
export type NativeWorkspaceAgent = { id: string; label: string; description: string; metricValue: string; metricLabel: string; artworkId: string; iconHex: string };
export type NativeWorkspaceTaskDraft = { title: string; date: string; time: string; notes: string };
export type NativeWorkspaceCircleDraft = { name: string; kind: "family" | "friends" | "other"; customTypeLabel?: string };
export type NativeWorkspaceMemoryDraft = { text: string; identifierApproved: boolean };
export type NativeWorkspaceCircleEditor = {
  destinationId: string; draft: NativeWorkspaceCircleDraft; draftRevision: number; acknowledgedEditRevision: number;
  busy: boolean; canSave: boolean; error: string | null; customTypes?: readonly string[];
};
export type NativeWorkspaceEdit = NativeWorkspaceIdentity & {
  destinationId: string; updateSequence: number; privacyGeneration: number; editRevision: number; composing: boolean; draft: NativeWorkspaceDraft;
};
export type NativeWorkspaceDraft = NativeWorkspaceCircleDraft | NativeWalletProfileDraft | NativeWorkspaceMemoryDraft | NativeWorkspaceTaskDraft;
export type NativeWorkspaceFinalEdit = NativeWorkspaceEdit & { baseDraftRevision: number };
export type NativeWorkspaceReceipt = NativeWorkspaceIdentity & {
  updateSequence: number; privacyGeneration: number; layoutRevision: number;
  phase: "active" | "retired"; settled: boolean;
};
export type NativeWorkspaceChoice = NativeWorkspaceIdentity & {
  updateSequence: number; privacyGeneration: number; sequence: number;
  domain?: "wallet-detail"; detailVisitId?: string; dismissed?: boolean;
  action: "row" | "back" | "task-save" | "task-cancel" | "circle-save" | "circle-cancel" | "wallet-save" | "wallet-cancel" | "memory-review" | "feedback-dismiss" | "feedback-action";
  rowId?: string; text?: string; editRevision?: number; actionToken?: NativeFeedbackActionToken;
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
function validCalendarDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;
}
function validCalendarTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}
export function validNativeWorkspace(value: NativeWorkspaceProjection): boolean {
  if (!value || !closed(value, ["documentId", "ownerEpoch", "ownerGeneration", "revision", "workspace", "appearance", "accentHex", "foregroundHex", "canvasHex",
    "updateSequence", "privacyGeneration", "isolationGeneration", "frame", "page", "title", "enabled", "backEnabled", "sections", "tabs", "secondaryTabs", "search", "circleEditor", "wallet", "walletProfileEditor", "memoryEditor", "taskEditor", "feedback", "launcher", "calendarDate"]) ||
    !id(value.documentId) || !id(value.ownerEpoch) || !seq(value.ownerGeneration) || !seq(value.revision) || !["referrals", "wallet", "memory", "consent", "tasks", "feed", "connect", "email", "launcher", "mail", "calendar", "finance", "career", "location", "setup"].includes(value.workspace) ||
    !seq(value.updateSequence) || !Number.isSafeInteger(value.privacyGeneration) || value.privacyGeneration < 0 || !Number.isSafeInteger(value.isolationGeneration) || value.isolationGeneration < 0 ||
    !["light", "dark"].includes(value.appearance) || ![value.accentHex, value.foregroundHex].every(v => /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(v)) ||
    value.canvasHex !== undefined && !/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value.canvasHex) ||
    !["overview", "rules", "circle-picker", "circle-create", "circle-people"].includes(value.page) || !text(value.title, 256) ||
    typeof value.enabled !== "boolean" || typeof value.backEnabled !== "boolean" || !Array.isArray(value.sections) || value.sections.length > 32) return false;
  if (value.workspace === "wallet" ? !value.wallet || !validNativeWalletCollection(value.wallet) || value.page !== "overview" || value.circleEditor !== undefined || !value.canvasHex : value.wallet !== undefined) return false;
  if ((value.workspace === "memory" || value.workspace === "consent") && (value.page !== "overview" || !value.canvasHex || value.circleEditor !== undefined || value.walletProfileEditor !== undefined)) return false;
  if (value.feedback !== undefined) {
    const f = value.feedback;
    if (!f || !closed(f, ["id", "message", "tone", "dismissible", "actionToken", "actionLabel"]) || !id(f.id) || !text(f.message, 2048) ||
      !["normal", "loading", "success", "error", "warning", "info"].includes(f.tone) || typeof f.dismissible !== "boolean" ||
      !((f.actionToken === null && f.actionLabel === null) ||
        (f.actionToken === "open-conversation" || f.actionToken === "open-information-request" || f.actionToken === "undo-feed-removal") && text(f.actionLabel, 48))) return false;
  }
  const frame = value.frame;
  if (!frame || !closed(frame, ["x", "y", "width", "height", "viewportWidth", "viewportHeight", "layoutRevision", "contentInset", "bottomContentInset"]) ||
    !seq(frame.layoutRevision) || !Object.values(frame).every(Number.isFinite) || frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0 ||
    frame.viewportWidth <= 0 || frame.viewportHeight <= 0 || frame.viewportWidth > 10000 || frame.viewportHeight > 10000 ||
    frame.x + frame.width > frame.viewportWidth + 1 || frame.y + frame.height > frame.viewportHeight + 1 ||
    frame.contentInset !== undefined && (frame.contentInset < 0 || frame.contentInset > 64 || frame.contentInset * 2 >= frame.width) ||
    frame.bottomContentInset !== undefined && (frame.bottomContentInset < 0 || frame.bottomContentInset >= frame.height)) return false;
  const ids = new Set<string>(); let count = 0, avatars = 0, avatarBytes = 0;
  const insert = (key: unknown) => id(key) && !ids.has(key) && !!ids.add(key);
  const admitAvatar = (avatar: NonNullable<NativeDrawerRow["avatar"]>) => {
    if (!avatar || !closed(avatar, ["initials", "jpeg", "verified"]) || ++avatars > 48 ||
        typeof avatar.initials !== "string" || avatar.initials.length > 8 ||
        avatar.verified !== undefined && (value.workspace !== "connect" || typeof avatar.verified !== "boolean")) return false;
    if (avatar.jpeg !== undefined) {
      if (typeof avatar.jpeg !== "string" || avatar.jpeg.length > 40_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(avatar.jpeg)) return false;
      avatarBytes += avatar.jpeg.length;
    }
    return avatarBytes <= 1_920_000;
  };
  for (const section of value.sections) {
    if (!section || !closed(section, ["id", "title", "rows"]) || !insert(section.id) || section.title !== undefined && !text(section.title, 256) || !Array.isArray(section.rows)) return false;
    for (const row of section.rows) {
      if (++count > 200 || !row || !closed(row, ["id", "label", "detail", "formattedText", "avatar", "inlineActions", "milestone", "expanded", "symbol", "artworkId", "iconHex", "chevron", "trailing", "enabled", "destructive", "selected", "pending", "readOnly", "toggle", "options"]) ||
        !insert(row.id) || !text(row.label, 4096) || row.detail !== undefined && !text(row.detail, 4096) || row.trailing !== undefined && !text(row.trailing, 32) ||
        row.symbol !== undefined && !id(row.symbol) || row.artworkId !== undefined && !id(row.artworkId) || row.iconHex !== undefined && !/^#[\da-f]{6}$/i.test(row.iconHex) ||
        typeof row.enabled !== "boolean" || [row.chevron, row.destructive, row.selected, row.pending, row.readOnly].some(v => v !== undefined && typeof v !== "boolean")) return false;
      if (row.toggle !== undefined && typeof row.toggle !== "boolean") return false;
      if (row.avatar !== undefined || row.inlineActions !== undefined || row.milestone !== undefined || row.expanded !== undefined) {
        if (!["feed", "connect"].includes(value.workspace) || row.formattedText || row.options || row.toggle) return false;
      }
      if (row.avatar !== undefined && !admitAvatar(row.avatar)) return false;
      if (row.inlineActions !== undefined) {
        if (!Array.isArray(row.inlineActions) || !row.inlineActions.length || row.inlineActions.length > 6) return false;
        for (const action of row.inlineActions) {
          if (!action || !closed(action, ["id", "label", "enabled", "pending", "tone", "symbol", "avatar", "placement"]) || !insert(action.id) || !text(action.label, 256) ||
              typeof action.enabled !== "boolean" || action.pending !== undefined && typeof action.pending !== "boolean" ||
              !["primary", "ghost", "danger", "success"].includes(action.tone) || action.symbol !== undefined && !id(action.symbol)) return false;
          if (action.avatar !== undefined && (value.workspace !== "connect" || !admitAvatar(action.avatar))) return false;
          if (action.placement !== undefined && (value.workspace !== "connect" || action.placement !== "menu")) return false;
        }
        if (row.inlineActions.filter((action: NativeWorkspaceInlineAction) => action.avatar !== undefined).length > 1) return false;
      }
      if (row.milestone !== undefined && (value.workspace !== "feed" || !Number.isInteger(row.milestone) || row.milestone < 0 || row.milestone > 4)) return false;
      if (row.expanded !== undefined && (value.workspace !== "feed" || typeof row.expanded !== "boolean")) return false;
      if (row.formattedText !== undefined) {
        const formatted = row.formattedText;
        if (value.workspace !== "memory" || !formatted || !closed(formatted, ["level", "runs"]) || row.options || row.toggle ||
            formatted.level !== undefined && (!Number.isInteger(formatted.level) || formatted.level < 1 || formatted.level > 6) ||
            !Array.isArray(formatted.runs) || !formatted.runs.length || formatted.runs.length > 128) return false;
        const links = new Set<string>(); let plain = "";
        for (const run of formatted.runs) {
          if (!run || !closed(run, ["text", "bold", "italic", "actionId"]) || !text(run.text, 4096) ||
              run.bold !== undefined && run.bold !== true || run.italic !== undefined && run.italic !== true) return false;
          plain += run.text;
          if (run.actionId !== undefined && !links.has(run.actionId)) {
            if (!insert(run.actionId) || links.size >= 50) return false;
            links.add(run.actionId);
          }
        }
        if (plain !== row.label || links.size > 0 && row.readOnly === true) return false;
      }
      if (row.options !== undefined || row.toggle === true) {
        if (row.readOnly || !Array.isArray(row.options) || row.options.length < 2 || row.options.length > 32) return false;
        for (const option of row.options) if (!option || !closed(option, ["id", "label", "selected"]) || !insert(option.id) || !text(option.label, 256) || typeof option.selected !== "boolean") return false;
        if (row.options.filter((option: NativeDrawerOption) => option.selected).length !== 1) return false;
        if (row.toggle && (row.options.length !== 2 || row.options[0]?.label !== "On" || row.options[1]?.label !== "Off")) return false;
      }
    }
  }
  if (value.wallet?.navigation) {
    const nav = value.wallet.navigation;
    const section = value.sections.find(section => section.id === nav.sectionId);
    const handles = [nav.allId, nav.previousId, nav.nextId, nav.addId];
    if (value.walletProfileEditor || !section || section.rows.length !== handles.length ||
        section.rows.some((row: NativeDrawerRow) => !handles.includes(row.id) || row.readOnly === true || row.options || row.toggle)) return false;
  }
  if (value.calendarDate !== undefined) {
    const d = value.calendarDate;
    if (value.workspace !== "calendar" || value.page !== "overview" || !d || !closed(d, ["id", "label", "value", "timeZone", "enabled"]) ||
      !insert(d.id) || !text(d.label, 64) || !text(d.timeZone, 128) || typeof d.enabled !== "boolean" ||
      !validCalendarDate(d.value) || !validCalendarTimeZone(d.timeZone)) return false;
  }
  if (value.launcher !== undefined) {
    const l = value.launcher;
    if (value.workspace !== "launcher" || value.page !== "overview" || !l || !closed(l, ["view", "agents"]) ||
      !["grid", "list"].includes(l.view) || !Array.isArray(l.agents) || l.agents.length > 32) return false;
    for (const a of l.agents) if (!a || !closed(a, ["id", "label", "description", "metricValue", "metricLabel", "artworkId", "iconHex"]) ||
      !insert(a.id) || !text(a.label, 64) || !text(a.description, 1024) || !text(a.metricValue, 64) || !text(a.metricLabel, 64) ||
      !/^roster-[a-z-]+$/.test(a.artworkId) || !/^#[\da-f]{6}$/i.test(a.iconHex)) return false;
  }
  if (value.wallet) {
    for (const key of [value.wallet.addId, value.wallet.closeId, ...value.wallet.cards.map(card => card.id), ...(value.wallet.accessId ? [value.wallet.accessId] : [])]) if (!insert(key)) return false;
  }
  if (value.secondaryTabs !== undefined && (value.workspace !== "connect" || !value.tabs)) return false;
  for (const tabs of [value.tabs, value.secondaryTabs]) {
    if (tabs === undefined) continue;
    if (!tabs || !closed(tabs, ["label", "options"]) || !text(tabs.label, 64) || !Array.isArray(tabs.options) ||
      tabs.options.length < 2 || tabs.options.length > 4 || tabs.options.filter(v => v.selected).length !== 1) return false;
    for (const option of tabs.options) if (!option || !closed(option, ["id", "label", "selected"]) || !insert(option.id) || !text(option.label, 64) || typeof option.selected !== "boolean") return false;
  }
  if (value.wallet?.view === "sharing" && (!value.wallet.sharedTabId || !value.tabs?.options.some(option => option.id === value.wallet?.sharedTabId && option.selected))) return false;
  if (value.wallet?.view === "cards" && value.wallet.sharedTabId !== undefined && value.tabs?.options.some(option => option.id === value.wallet?.sharedTabId && option.selected)) return false;
  if (value.search !== undefined && (!value.search || !closed(value.search, ["id", "query", "label", "live", "afterSection"]) || !insert(value.search.id) ||
    typeof value.search.query !== "string" || value.search.query.length > 256 || !text(value.search.label, 64) ||
    value.search.live !== undefined && typeof value.search.live !== "boolean" ||
    value.search.afterSection !== undefined && (value.workspace !== "memory" || !Number.isSafeInteger(value.search.afterSection) ||
      value.search.afterSection < 0 || value.search.afterSection > value.sections.length))) return false;
  if (value.circleEditor !== undefined) {
    const e = value.circleEditor;
    if (value.page !== "circle-create" || !e || !closed(e, ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error", "customTypes"]) ||
      !id(e.destinationId) || !validWorkspaceCircleDraft(e.draft) || !Number.isSafeInteger(e.draftRevision) || e.draftRevision < 0 ||
      !Number.isSafeInteger(e.acknowledgedEditRevision) || e.acknowledgedEditRevision < 0 || typeof e.busy !== "boolean" || typeof e.canSave !== "boolean" ||
      e.error !== null && (typeof e.error !== "string" || e.error.length > 1024) ||
      e.customTypes !== undefined && (value.workspace !== "connect" || !Array.isArray(e.customTypes) || e.customTypes.length > 3 || e.customTypes.some(label => !text(label, 32)))) return false;
  }
  if (value.walletProfileEditor !== undefined) {
    const e = value.walletProfileEditor;
    if (value.workspace !== "wallet" || !value.wallet?.selectedId || !e || !closed(e, ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error"]) ||
      !id(e.destinationId) || !validNativeWalletProfileDraft(e.draft) || !Number.isSafeInteger(e.draftRevision) || e.draftRevision < 0 ||
      !Number.isSafeInteger(e.acknowledgedEditRevision) || e.acknowledgedEditRevision < 0 || typeof e.busy !== "boolean" || typeof e.canSave !== "boolean" ||
      e.error !== null && (typeof e.error !== "string" || e.error.length > 1024)) return false;
  }
  if (value.taskEditor !== undefined) {
    const e = value.taskEditor;
    if (value.workspace !== "tasks" || value.page !== "overview" || value.circleEditor || value.walletProfileEditor || value.memoryEditor || !e ||
      !closed(e, ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error"]) ||
      !id(e.destinationId) || !validWorkspaceTaskDraft(e.draft) || !Number.isSafeInteger(e.draftRevision) || e.draftRevision < 0 ||
      !Number.isSafeInteger(e.acknowledgedEditRevision) || e.acknowledgedEditRevision < 0 || typeof e.busy !== "boolean" || typeof e.canSave !== "boolean" ||
      e.error !== null && (typeof e.error !== "string" || e.error.length > 1024)) return false;
  }
  if (value.memoryEditor !== undefined) {
    const e = value.memoryEditor;
    if (value.workspace !== "memory" || value.page !== "overview" || value.circleEditor !== undefined || value.walletProfileEditor !== undefined ||
      !e || !closed(e, ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "canToggleIdentifier", "reviewing", "error"]) ||
      !id(e.destinationId) || !validWorkspaceMemoryDraft(e.draft) || !Number.isSafeInteger(e.draftRevision) || e.draftRevision < 0 ||
      !Number.isSafeInteger(e.acknowledgedEditRevision) || e.acknowledgedEditRevision < 0 || typeof e.busy !== "boolean" || typeof e.canSave !== "boolean" || typeof e.canToggleIdentifier !== "boolean" || typeof e.reviewing !== "boolean" ||
      e.error !== null && (typeof e.error !== "string" || e.error.length > 1024)) return false;
  }
  // Match Foundation's escaped UTF-8 envelope, including text and actions.
  // Oversized rich pages keep their complete React presentation; no content
  // or callbacks are truncated to squeeze a partially rendered native page in.
  return !["feed", "connect"].includes(value.workspace) ||
    new TextEncoder().encode(JSON.stringify(value).replaceAll("/", "\\/")).byteLength <= 900_000;
}
export function validWorkspaceTaskDraft(value: unknown): value is NativeWorkspaceTaskDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as NativeWorkspaceTaskDraft;
  return closed(draft, ["title", "date", "time", "notes"]) && typeof draft.title === "string" && draft.title.length <= 240 &&
    typeof draft.notes === "string" && draft.notes.length <= 1200 && typeof draft.date === "string" && /^(?:|\d{4}-\d{2}-\d{2})$/.test(draft.date) &&
    typeof draft.time === "string" && /^(?:|(?:[01]\d|2[0-3]):[0-5]\d)$/.test(draft.time);
}
export function validWorkspaceMemoryDraft(value: unknown): value is NativeWorkspaceMemoryDraft {
  const draft = value as NativeWorkspaceMemoryDraft;
  return !!draft && typeof draft === "object" && !Array.isArray(draft) && closed(draft, ["text", "identifierApproved"]) &&
    typeof draft.text === "string" && draft.text.length <= 50_000 && typeof draft.identifierApproved === "boolean";
}
export function validWorkspaceCircleDraft(value: unknown): value is NativeWorkspaceCircleDraft {
  const draft = value as NativeWorkspaceCircleDraft;
  return !!draft && typeof draft === "object" && !Array.isArray(draft) && closed(draft, ["name", "kind", "customTypeLabel"]) &&
    typeof draft.name === "string" && draft.name.length <= 80 && ["family", "friends", "other"].includes(draft.kind) &&
    (draft.customTypeLabel === undefined || typeof draft.customTypeLabel === "string" && draft.customTypeLabel.length <= 32);
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
  if (choice.domain === undefined) {
    if (isolated || choice.detailVisitId !== undefined || choice.dismissed !== undefined) return false;
    if (choice.action === "row" && state.calendarDate && state.calendarDate.id === choice.rowId) return state.workspace === "calendar" &&
      state.calendarDate.enabled && choice.actionToken === undefined && validCalendarDate(choice.text);
    if (choice.action === "task-save" || choice.action === "task-cancel") return state.workspace === "tasks" && !!state.taskEditor &&
      !state.taskEditor.busy && (choice.action === "task-cancel" || state.taskEditor.canSave) && choice.rowId === undefined && choice.text === undefined &&
      choice.actionToken === undefined && Number.isSafeInteger(choice.editRevision) && (choice.editRevision ?? -1) >= 0;
    if (choice.action === "memory-review") return state.workspace === "memory" && !!state.memoryEditor &&
      state.memoryEditor.canSave && !state.memoryEditor.busy && choice.rowId === undefined && choice.text === undefined &&
      choice.actionToken === undefined && Number.isSafeInteger(choice.editRevision) && (choice.editRevision ?? -1) >= 0;
    if (choice.action === "feedback-dismiss") return choice.actionToken === undefined && choice.text === undefined &&
      typeof choice.rowId === "string" && choice.rowId === state.feedback?.id && state.feedback.dismissible;
    if (choice.action === "feedback-action") return choice.text === undefined && choice.actionToken !== undefined &&
      typeof choice.rowId === "string" && choice.rowId === state.feedback?.id && choice.actionToken === state.feedback.actionToken;
    return choice.actionToken === undefined;
  }
  const wallet = state.wallet;
  if (choice.domain !== "wallet-detail" || state.workspace !== "wallet" || !wallet?.selectedId ||
    !wallet.detailVisitId || wallet.detailVisitId !== choice.detailVisitId) return false;
  if (choice.action !== "feedback-action" && choice.actionToken !== undefined) return false;
  if (choice.dismissed) return choice.action === "row" && choice.actionToken === undefined && choice.rowId === wallet.closeId && !wallet.detailBusy && choice.text === undefined;
  if (choice.action === "feedback-dismiss") return choice.actionToken === undefined && typeof choice.rowId === "string" && choice.rowId === state.feedback?.id && state.feedback?.dismissible === true && choice.text === undefined;
  if (choice.action === "feedback-action") return typeof choice.rowId === "string" && choice.rowId === state.feedback?.id &&
    choice.actionToken !== undefined && choice.actionToken === state.feedback.actionToken && choice.text === undefined;
  if (choice.action === "wallet-save" || choice.action === "wallet-cancel") return !!state.walletProfileEditor && choice.rowId === undefined && choice.text === undefined;
  if (choice.action !== "row" || !choice.rowId) return false;
  if (choice.rowId === wallet.closeId) return !wallet.detailBusy && choice.text === undefined;
  if (state.search?.id === choice.rowId) return typeof choice.text === "string" && choice.text.length <= 256;
  return choice.text === undefined && state.sections.some(section => section.rows.some(row => row.id === choice.rowId && row.enabled && !row.pending && !row.readOnly));
}
