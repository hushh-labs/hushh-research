"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspace, useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";
import type { NativeWorkspaceChoice, NativeWorkspaceTaskDraft } from "@/lib/capacitor/native-workspace";
import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";
import { groupByDate, type DueReceiptItem } from "./todo-list-presentation";

export type NativeTodoModel = {
  owner: string | null; current: () => boolean; ready: boolean; loading: boolean;
  pending: TodoItem[]; completed: TodoItem[]; receipts: DueReceiptItem[];
  editorId: string | null; editorCurrent: (id: string) => boolean;
  draft: NativeWorkspaceTaskDraft; readDraft: () => NativeWorkspaceTaskDraft; inputRevision: () => number;
  changeDraft: (draft: NativeWorkspaceTaskDraft, expected?: number) => boolean;
  openEditor: () => void; closeEditor: () => void;
  saving: string | null; doneToday: number; totalToday: number;
  errors: readonly { label: string; retry: () => void }[];
  overflowHref: string | null;
  save: (draft: { title: string; date: string | null; time: string | null; notes: string | null }) => Promise<boolean>;
  toggle: (task: TodoItem, complete: boolean) => Promise<void>;
  remove: (task: TodoItem) => Promise<void>;
};

/** Feature values and callbacks only. Admission, retirement, feedback and draft
 * ordering belong to the same workspace boundary as Memory and Wallet. */
export function NativeTodoWorkspace({ model, fallback }: { model: NativeTodoModel; fallback: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const failed = presentation.status.phase === "web" && (presentation.status.reason === "unsupported" || presentation.status.reason === "failure");
  if (!customNativePresentationEnabled() || !model.owner || !model.ready || failed) return presentation.status.held ? <div aria-busy="true" /> : fallback;
  return <NativeTodoBody model={model} presentation={presentation} />;
}

function NativeTodoBody({ model, presentation }: { model: NativeTodoModel; presentation: ReturnType<typeof useNativeWorkspacePresentation> }) {
  const router = useRouter();
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const contentFrame = useRef<HTMLDivElement>(null);
  const editing = model.editorId;
  const [selection, setSelection] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [page, setPage] = useState(0);
  const saving = useRef(false), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const latest = useRef({ model, pathname });
  useLayoutEffect(() => { latest.current = { model, pathname }; });
  const current = () => mounted.current && latest.current.pathname === "/one/todos" && latest.current.model.current();
  const handles = useMemo(() => {
    const map = new Map<string, string>();
    return (key: string) => { let id = map.get(key); if (!id) { id = crypto.randomUUID(); map.set(key, id); } return id; };
  }, [model.owner]);
  const closeEditor = () => { if (!saving.current) latest.current.model.closeEditor(); };
  const back = () => {
    if (saving.current || latest.current.model.saving) return true;
    if (confirmDelete) { setConfirmDelete(false); return true; }
    if (editing) { closeEditor(); return true; }
    if (selection) { setSelection(null); return true; }
    return false;
  };
  useBackLayer("/one/todos", confirmDelete ? 3 : editing || selection ? 2 : 0, back);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const action = (key: string, label: string, callback: () => unknown, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = handles(key); actions.set(id, () => { if (current()) return callback() as void | Promise<unknown>; });
    return { id, label, enabled: model.saving === null, ...extra };
  };
  const read = (key: string, label: string, detail?: string): NativeDrawerRow => ({ id: handles(key), label, ...(detail ? { detail } : {}), enabled: true, readOnly: true });
  const sections: NativeDrawerSection[] = [];
  const section = (key: string, rows: NativeDrawerRow[], title?: string) => { if (rows.length) sections.push({ id: `tasks-${key}`, ...(title ? { title } : {}), rows }); };
  const selected = [...model.pending, ...model.completed].find(task => task.id === selection);
  const open = (href: string) => { if (href.startsWith("/")) router.push(href); else window.open(href, "_blank", "noopener,noreferrer"); };
  let title = "Your tasks";
  if (editing) title = "Add item";
  else if (selected) {
    title = confirmDelete ? "Delete item?" : "Task";
    section("detail", [read("title", selected.title, [selected.date, selected.time, selected.sourceAgent && TODO_SOURCE_LABELS[selected.sourceAgent]].filter(Boolean).join(" · ")),
      ...(selected.notes ? [read("notes", selected.notes)] : [])]);
    if (confirmDelete) section("confirm", [read("delete-info", "This removes the item from your to-do list.", "Calendar events and emails stay in place."),
      action("delete-confirm", "Delete", async () => { setConfirmDelete(false); setSelection(null); await model.remove(selected); }, { destructive: true }),
      action("delete-cancel", "Cancel", () => setConfirmDelete(false))]);
    else section("actions", [action("toggle", selected.status === "done" ? "Mark as not completed" : "Mark as completed", () => model.toggle(selected, selected.status !== "done"), { symbol: "checkmark.circle" }),
      ...(selected.link ? [action("open", selected.sourceAgent === "calendar" && !selected.link.startsWith("/") ? "Join" : "Open", () => open(selected.link!), { chevron: true })] : []),
      action("delete", "Delete item", () => setConfirmDelete(true), { destructive: true, symbol: "trash" })]);
  } else {
    section("summary", [action("add", "Add item", model.openEditor, { enabled: !model.loading && model.saving === null, symbol: "plus" }),
      ...(model.totalToday > 0 ? [read("today", `${model.doneToday} of ${model.totalToday} done today`)] : [])]);
    section("errors", model.errors.flatMap((error, i) => [read(`error-${i}`, error.label), action(`retry-${i}`, "Retry", error.retry)]));
    if (model.loading) section("loading", [read("loading", "Loading your list…")]);
    else {
      section("completed-toggle", model.completed.length ? [action("completed", "Completed", () => { setCompletedOpen(value => !value); setPage(0); }, { trailing: String(model.completed.length), selected: completedOpen, symbol: "checkmark.circle" })] : []);
      const visible = completedOpen ? model.completed : model.pending;
      // One bounded window, including receipts; no record is silently truncated.
      const index = Math.min(page, Math.max(0, Math.ceil(visible.length / 24) - 1));
      for (const [i, group] of groupByDate(visible.slice(index * 24, (index + 1) * 24)).entries()) section(`group-${i}`, group.tasks.map(task => action(`task-${task.id}`, task.title,
        () => { setConfirmDelete(false); setSelection(task.id); }, { detail: [task.time, task.sourceAgent && TODO_SOURCE_LABELS[task.sourceAgent], task.notes].filter(Boolean).join(" · ") || undefined, chevron: true, pending: model.saving === task.id })), `${group.label}${group.overdue ? " · Overdue" : ""}`);
      if (!visible.length && !model.receipts.length && !model.errors.length) section("empty", [read("empty", completedOpen ? "No completed tasks" : model.completed.length ? "No pending tasks" : "No tasks yet", "Add an item to get started.")]);
      section("paging", [
        ...(index > 0 ? [action("previous", "Previous tasks", () => setPage(index - 1))] : []),
        ...((index + 1) * 24 < visible.length ? [action("next", "More tasks", () => setPage(index + 1))] : [])]);
      if (!completedOpen) section("receipts", model.receipts.slice(0, 24).map(receipt => action(`receipt-${receipt.id}`, receipt.merchantName, () => open(receipt.href),
        { detail: [receipt.statusLabel, receipt.amount, receipt.date, receipt.title].filter(Boolean).join(" · "), chevron: true })), "Receipts & Due Payments");
      if (model.receipts.length > 24) section("more-receipts", [action("more-receipts", "View all receipts", () => open(model.receipts[0]!.href))]);
      if (model.overflowHref) section("requests", [action("requests", "View all pending requests", () => open(model.overflowHref!), { chevron: true })]);
    }
  }
  const editor = editing ? {
    destinationId: editing, draft: model.draft, current: () => latest.current.model.editorCurrent(editing), inputRevision: model.inputRevision, mutationPending: () => saving.current || latest.current.model.saving !== null,
    changeDraft: model.changeDraft, busy: model.saving !== null, canSave: !!model.draft.title.trim(), error: null,
    save: async () => {
      if (!current() || saving.current) return false;
      saving.current = true;
      const value = latest.current.model.readDraft();
      try { return await latest.current.model.save({ title: value.title.trim(), date: value.date || null, time: value.time || null, notes: value.notes.trim() || null }); }
      finally { saving.current = false; }
    },
    onSaved: closeEditor, onCancel: closeEditor,
  } : undefined;
  const active = pathname === "/one/todos";
  const phase = useNativeWorkspace({ owner: model.owner!, content: { workspace: "tasks", page: "overview", title, enabled: active, backEnabled: false, sections }, actions, current,
    editor, editorKind: "task", presentationOwner: presentation.owner, contentFrame, active, back });
  return <AppPageShell as="main" ref={contentFrame} width="reading" aria-busy={phase !== "native"} data-native-todo-workspace={phase}
    nativeTest={{ routeId: "/one/todos", marker: phase === "native" ? "native-route-one-todos" : "native-todo-admission", authState: "authenticated",
      dataState: phase === "blocked" ? "error" : phase !== "native" ? "booting" : model.loading ? "loading" : model.pending.length || model.completed.length ? "loaded" : "empty-valid" }} />;
}
