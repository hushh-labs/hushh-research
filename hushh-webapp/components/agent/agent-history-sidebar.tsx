"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Check,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";
import { cn } from "@/lib/utils";

type AgentHistorySidebarProps = {
  conversations: AgentChatConversation[];
  activeConversationId: string | null;
  loading?: boolean;
  disabled?: boolean;
  actionPendingId?: string | null;
  className?: string;
  collapsed?: boolean;
  onClose?: () => void;
  onToggleCollapsed?: () => void;
  onCreateNew: () => void;
  onSelectConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => Promise<void> | void;
  onDeleteConversation: (conversationId: string) => Promise<void> | void;
};

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

function conversationLabel(conversation: AgentChatConversation): string {
  const title = normalizeTitle(conversation.title);
  return title || "New Agent chat";
}

function conversationTimestamp(conversation: AgentChatConversation): number {
  const candidate =
    conversation.last_message_at ||
    conversation.updated_at ||
    conversation.created_at ||
    null;
  if (!candidate) return 0;
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

type ConversationGroupKey = "today" | "yesterday" | "previous7" | "earlier";

const GROUP_LABELS: Record<ConversationGroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7: "Previous 7 days",
  earlier: "Earlier",
};

const GROUP_ORDER: ConversationGroupKey[] = [
  "today",
  "yesterday",
  "previous7",
  "earlier",
];

function conversationGroupKey(
  timestamp: number,
  now: number,
): ConversationGroupKey {
  if (!timestamp) return "earlier";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  if (timestamp >= startOfTodayMs) return "today";
  const startOfYesterdayMs = startOfTodayMs - 24 * 60 * 60 * 1000;
  if (timestamp >= startOfYesterdayMs) return "yesterday";
  const startOfPrevious7Ms = startOfTodayMs - 7 * 24 * 60 * 60 * 1000;
  if (timestamp >= startOfPrevious7Ms) return "previous7";
  return "earlier";
}

export function AgentHistorySidebar({
  conversations,
  activeConversationId,
  loading = false,
  disabled = false,
  actionPendingId,
  className,
  collapsed = false,
  onClose,
  onToggleCollapsed,
  onCreateNew,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
}: AgentHistorySidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AgentChatConversation | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const renamingConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === renamingId) || null,
    [conversations, renamingId]
  );

  const trimmedQuery = searchQuery.trim().toLowerCase();

  const filteredConversations = useMemo(() => {
    if (!trimmedQuery) return conversations;
    return conversations.filter((conversation) =>
      conversationLabel(conversation).toLowerCase().includes(trimmedQuery),
    );
  }, [conversations, trimmedQuery]);

  const groupedConversations = useMemo(() => {
    const now = Date.now();
    const sorted = [...filteredConversations].sort(
      (a, b) => conversationTimestamp(b) - conversationTimestamp(a),
    );
    const buckets = new Map<ConversationGroupKey, AgentChatConversation[]>();
    for (const conversation of sorted) {
      const key = conversationGroupKey(conversationTimestamp(conversation), now);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(conversation);
      } else {
        buckets.set(key, [conversation]);
      }
    }
    return GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({
      key,
      label: GROUP_LABELS[key],
      items: buckets.get(key) as AgentChatConversation[],
    }));
  }, [filteredConversations]);

  useEffect(() => {
    if (!renamingConversation) return;
    setRenameValue(conversationLabel(renamingConversation));
  }, [renamingConversation]);

  const startRename = (conversation: AgentChatConversation) => {
    setRenamingId(conversation.id);
    setRenameValue(conversationLabel(conversation));
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renamingId) return;
    const nextTitle = normalizeTitle(renameValue);
    if (!nextTitle) return;
    await onRenameConversation(renamingId, nextTitle);
    cancelRename();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await onDeleteConversation(deleteTarget.id);
    setDeleteTarget(null);
  };

  const renderConversationItem = (conversation: AgentChatConversation) => {
    const title = conversationLabel(conversation);
    const active = conversation.id === activeConversationId;
    const pending = actionPendingId === conversation.id;
    const isRenaming = renamingId === conversation.id;

    return (
      <div
        key={conversation.id}
        role="listitem"
        className={cn(
          "group rounded-lg transition-colors",
          active && "bg-primary/10 text-[#1d1d1f] ring-1 ring-primary/20 dark:bg-primary/15 dark:text-zinc-50",
          !active && "text-[rgba(0,0,0,0.54)] hover:bg-black/[0.045] hover:text-[#1d1d1f] dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
        )}
      >
        {isRenaming ? (
          <form
            onSubmit={submitRename}
            className="flex items-center gap-1 rounded-lg bg-black/[0.04] p-1 dark:bg-[#151820]"
          >
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              className="h-8 min-w-0 flex-1 border-black/10 bg-white/90 text-sm text-[#1d1d1f] dark:border-white/10 dark:bg-black/20 dark:text-zinc-100"
              maxLength={160}
              autoFocus
              disabled={pending}
              aria-label="Rename chat"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button
              type="submit"
              variant="ghost"
              size="icon-xs"
              disabled={pending || !normalizeTitle(renameValue)}
              aria-label="Save chat name"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={cancelRename}
              disabled={pending}
              aria-label="Cancel rename"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </form>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center">
            <button
              type="button"
              className={cn(
                "flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/60",
                collapsed ? "justify-center px-0" : "px-2"
              )}
              onClick={() => onSelectConversation(conversation.id)}
              disabled={disabled || pending}
              aria-current={active ? "page" : undefined}
              title={title}
            >
              <MessageSquare className="h-4 w-4 shrink-0 opacity-75" aria-hidden="true" />
              {collapsed ? null : <span className="truncate">{title}</span>}
            </button>
            {collapsed ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="mr-1 text-[rgba(0,0,0,0.42)] opacity-0 transition-opacity hover:bg-black/[0.05] hover:text-[#1d1d1f] group-hover:opacity-100 focus-visible:opacity-100 dark:text-zinc-500 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100"
                    disabled={disabled || pending}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Open actions for ${title}`}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="z-[520]">
                  <DropdownMenuItem onSelect={() => startRename(conversation)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    Rename chat
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleteTarget(conversation)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Delete chat
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <aside
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-black/10 bg-white/92 text-[#1d1d1f] shadow-[inset_-1px_0_0_rgba(255,255,255,0.55)] backdrop-blur-xl transition-[width] duration-200 ease-out dark:border-white/10 dark:bg-[#101216] dark:text-zinc-200 dark:shadow-none",
          collapsed ? "w-16" : "w-72",
          className
        )}
        aria-label="Agent chat history"
        data-collapsed={collapsed ? "true" : "false"}
      >
        <div className="flex items-center gap-2 border-b border-black/10 p-3 dark:border-white/10">
          {collapsed ? (
            <div className="flex w-full flex-col items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-lg border border-black/10 bg-black/[0.035] text-[rgba(0,0,0,0.62)] hover:bg-black/[0.06] hover:text-[#1d1d1f] focus-visible:ring-2 focus-visible:ring-primary/60 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-100 dark:hover:bg-white/[0.08]"
                onClick={onToggleCollapsed}
                aria-label="Expand chat history"
                title="Expand chat history"
              >
                <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-lg text-[rgba(0,0,0,0.54)] hover:bg-black/[0.05] hover:text-[#1d1d1f] focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-zinc-300 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100"
                onClick={onCreateNew}
                disabled={disabled}
                aria-label="Create new Agent chat"
                title="New chat"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                className="h-11 min-w-0 flex-1 justify-start gap-2 rounded-lg border border-black/10 bg-black/[0.035] px-3 text-sm font-medium text-[#1d1d1f] shadow-sm shadow-black/[0.03] transition-colors hover:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-primary/60 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-100 dark:shadow-none dark:hover:bg-white/[0.08]"
                onClick={onCreateNew}
                disabled={disabled}
                aria-label="Create new Agent chat"
                title="Create new chat"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="truncate">New chat</span>
              </Button>
              {onToggleCollapsed ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="hidden h-10 w-10 rounded-lg text-[rgba(0,0,0,0.46)] hover:bg-black/[0.05] hover:text-[#1d1d1f] focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100 lg:inline-flex"
                  onClick={onToggleCollapsed}
                  aria-label="Collapse chat history"
                  title="Collapse chat history"
                >
                  <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                </Button>
              ) : null}
            </>
          )}
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-lg text-[rgba(0,0,0,0.46)] hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100 lg:hidden"
              onClick={onClose}
              aria-label="Close chat history"
              title="Close chat history"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        {!collapsed ? (
          <div className="border-b border-black/10 px-3 py-2 dark:border-white/10">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgba(0,0,0,0.4)] dark:text-zinc-500"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search chats"
                aria-label="Search chats"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="h-9 border-black/10 bg-black/[0.025] pl-8 text-sm text-[#1d1d1f] placeholder:text-[rgba(0,0,0,0.4)] dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent">
          {collapsed ? <div className="h-4" aria-hidden="true" /> : null}

          {loading ? (
            <div className="h-10 w-full rounded-lg bg-black/[0.04] dark:bg-white/[0.05]" />
          ) : null}

          {!collapsed && !loading && conversations.length === 0 ? (
            <div className="grid min-h-24 place-items-center rounded-lg border border-dashed border-black/10 px-3 text-center text-xs text-[rgba(0,0,0,0.46)] dark:border-white/10 dark:text-zinc-500">
              No chats yet
            </div>
          ) : null}

          {!collapsed &&
          !loading &&
          conversations.length > 0 &&
          filteredConversations.length === 0 ? (
            <div className="grid min-h-24 place-items-center rounded-lg border border-dashed border-black/10 px-3 text-center text-xs text-[rgba(0,0,0,0.46)] dark:border-white/10 dark:text-zinc-500">
              No chats match &ldquo;{searchQuery.trim()}&rdquo;
            </div>
          ) : null}

          {collapsed ? (
            <div
              className="space-y-1"
              role="list"
              aria-label="Conversation history"
            >
              {filteredConversations.map((conversation) =>
                renderConversationItem(conversation),
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {groupedConversations.map((group) => (
                <div key={group.key}>
                  <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.16em] text-[rgba(0,0,0,0.42)] dark:text-zinc-500">
                    {group.label}
                  </div>
                  <div
                    className="space-y-1"
                    role="list"
                    aria-label={`${group.label} conversations`}
                  >
                    {group.items.map((conversation) =>
                      renderConversationItem(conversation),
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the selected Agent conversation and its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deleteTarget && actionPendingId === deleteTarget.id)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={Boolean(deleteTarget && actionPendingId === deleteTarget.id)}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
