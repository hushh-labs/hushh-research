"use client";

import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import type { NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import { useNativeDrawerPresentation } from "@/lib/capacitor/use-native-drawer-presentation";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";
import { conversationGroupKey, conversationTimestamp, displayConversationLabel, formatRelativeTime, GROUP_LABELS, GROUP_ORDER, normalizeTitle } from "./agent-history-sidebar";

type HistoryPort = {
  owner: string | null;
  vaultEpoch: number;
  ready: boolean;
  disabled?: boolean;
  open: boolean;
  surface: "one" | "puppy";
  conversations: readonly AgentChatConversation[];
  selected: string | null;
  pending: string | null;
  loading: boolean;
  create: () => void;
  select: (id: string) => void;
  rename: (id: string, title: string) => void | Promise<void>;
  remove: (id: string) => void | Promise<void>;
  setOpen: (open: boolean) => void;
  openConnectors?: () => void;
  openDriveReview?: () => void;
  openTodoList?: () => void;
};

/** Explicit private port: IDs are presentation handles, never DOM inference or
 * native routing. Existing workspace callbacks retain all operation authority. */
export function nativeHistoryProjection(port: HistoryPort, handles = new Map<string, string>()): { sections: NativeDrawerSection[]; actions: NativeDrawerActions } {
  const actions: NativeDrawerActions = { rows: new Map(), open: () => port.setOpen(true), close: () => port.setOpen(false) };
  const rows = new Map<string, (typeof port.conversations)[number][]>();
  const now = Date.now();
  for (const conversation of [...port.conversations].sort((a, b) => conversationTimestamp(b) - conversationTimestamp(a))) {
    const group = conversationGroupKey(conversationTimestamp(conversation), now);
    rows.set(group, [...rows.get(group) ?? [], conversation]);
  }
  const callbacks = new Map(actions.rows);
  callbacks.set("new", () => port.create());
  const enabled = port.ready && !port.disabled;
  const sections: NativeDrawerSection[] = [{ id: "create", rows: [{ id: "new", label: "New chat", symbol: "plus", enabled }] }];
  for (const key of GROUP_ORDER) {
    const group = rows.get(key);
    if (!group) continue;
    sections.push({ id: `group-${key}`, title: GROUP_LABELS[key], rows: group.map(conversation => {
      const key = `${port.surface}:${conversation.id}`;
      let id = handles.get(key);
      if (!id) { id = `chat-${crypto.randomUUID()}`; handles.set(key, id); }
      const renameActionId = `${id}-rename`, deleteActionId = `${id}-delete`;
      callbacks.set(id, () => port.select(conversation.id));
      callbacks.set(renameActionId, choice => {
        const title = normalizeTitle(choice.text ?? "");
        if (!title || title.length > 160) return;
        return port.rename(conversation.id, title);
      });
      callbacks.set(deleteActionId, () => port.remove(conversation.id));
      const detail = formatRelativeTime(conversationTimestamp(conversation));
      return { id, label: displayConversationLabel(conversation), ...(detail ? { detail } : {}), renameActionId, deleteActionId,
        enabled, selected: conversation.id === port.selected, pending: conversation.id === port.pending };
    }) });
  }
  const footer: NativeDrawerSection["rows"][number][] = [];
  if (port.surface === "one" && port.openTodoList) {
    callbacks.set("todos", port.openTodoList);
    footer.push({ id: "todos", label: "To-do List", symbol: "checklist", enabled });
  }
  if (port.surface === "one" && port.openConnectors) {
    callbacks.set("connectors", port.openConnectors);
    footer.push({ id: "connectors", label: "Connectors", symbol: "puzzlepiece.extension", enabled });
  }
  if (port.surface === "one" && port.openDriveReview) {
    callbacks.set("drive-review", port.openDriveReview);
    footer.push({ id: "drive-review", label: "Drive sharing", symbol: "folder", enabled });
  }
  if (footer.length) sections.push({ id: "footer", rows: footer });
  return { sections, actions: { ...actions, rows: callbacks } };
}

export function useNativeHistoryPresentation(port: HistoryPort): "web" | "preparing" | "native" | "blocked" {
  return useNativeDrawerPresentation({ family: "history", owner: port.owner, vaultEpoch: port.vaultEpoch,
    ready: port.ready, open: port.open, title: port.surface === "puppy" ? "Puppy chats" : "Chats",
    searchable: true, loading: port.loading, project: handles => nativeHistoryProjection(port, handles) });
}
