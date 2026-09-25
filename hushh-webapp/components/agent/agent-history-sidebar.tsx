"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Unplug as PlugIcon,
  CheckIcon as Check,
  MessageSquareIcon as MessageSquare,
  DotsThreeIcon as MoreHorizontal,
  Loader2Icon as Loader2,
  PanelLeftCloseIcon as PanelLeftClose,
  PanelLeftOpenIcon as PanelLeftOpen,
  PencilIcon as Pencil,
  PlusIcon as Plus,
  SearchIcon as Search,
  TrashIcon as Trash2,
  XIcon as X,
} from "@/components/icons";

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
import { SearchClearButton } from "@/components/app-ui/search-clear-button";
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
  mode?: "desktop" | "mobile";
  hideCloseButton?: boolean;
  /**
   * Which agent is on screen beside this list.
   *
   * Every row here belongs to One. Puppy One keeps its transcript on the
   * owner's machine and contributes none, so with Puppy showing a list headed
   * only "Chats" reads either as "my on-device chats are saved into One's
   * cloud history" or as "the local chat I am having is one of these rows".
   * Neither is true, and the list is not hidden in Puppy mode because the
   * desktop aside is a 288px flex sibling: unmounting it would slide the whole
   * workspace sideways on every toggle, and it is the only route back to a One
   * conversation.
   */
  surface?: "one" | "puppy";
  onClose?: () => void;
  onToggleCollapsed?: () => void;
  onOpenConnectors?: (trigger: HTMLButtonElement) => void;
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
  return title || "New chat";
}

function displayConversationLabel(conversation: AgentChatConversation): string {
  const label = conversationLabel(conversation)
    .replace(/\bpkm\b/giu, "personal details")
    .replace(/\s+/g, " ")
    .trim();

  return label ? `${label.slice(0, 1).toUpperCase()}${label.slice(1)}` : "New chat";
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

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const now = Date.now();
  const diffMs = now - timestamp;
  if (diffMs < 0) return "now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "1d";
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type ConversationGroupKey = "today" | "yesterday" | "previous7" | "previous30" | "earlier";

const GROUP_LABELS: Record<ConversationGroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7: "Last 7 days",
  previous30: "Last 30 days",
  earlier: "Older",
};

const GROUP_ORDER: ConversationGroupKey[] = [
  "today",
  "yesterday",
  "previous7",
  "previous30",
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
  const yesterday = new Date(startOfToday);
  yesterday.setDate(yesterday.getDate() - 1);
  const startOfYesterdayMs = yesterday.getTime();
  if (timestamp >= startOfYesterdayMs) return "yesterday";
  const previous7 = new Date(startOfToday);
  previous7.setDate(previous7.getDate() - 7);
  if (timestamp >= previous7.getTime()) return "previous7";
  const previous30 = new Date(startOfToday);
  previous30.setDate(previous30.getDate() - 30);
  if (timestamp >= previous30.getTime()) return "previous30";
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
  mode = "desktop",
  hideCloseButton = false,
  surface = "one",
  onClose,
  onToggleCollapsed,
  onOpenConnectors,
  onCreateNew,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
}: AgentHistorySidebarProps) {
  const isMobileMode = mode === "mobile";
  // Neutral on the default path, owned when the other agent is on screen.
  const listTitle = surface === "puppy" ? "Puppy chats" : "Chats";
  const puppyFootnote =
    surface === "puppy" ? (
      <p className="mt-1 text-[12px] text-muted-foreground">
        Puppy One&apos;s chats stay on your machine.
      </p>
    ) : null;
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
      displayConversationLabel(conversation).toLowerCase().includes(trimmedQuery),
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
    setRenameValue(displayConversationLabel(renamingConversation));
  }, [renamingConversation]);

  const startRename = (conversation: AgentChatConversation) => {
    setRenamingId(conversation.id);
    setRenameValue(displayConversationLabel(conversation));
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

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    setDeleteTarget(null);
    void Promise.resolve(onDeleteConversation(targetId)).catch(() => undefined);
  };

  const renderConversationItem = (conversation: AgentChatConversation) => {
    const title = displayConversationLabel(conversation);
    const active = conversation.id === activeConversationId;
    const pending = actionPendingId === conversation.id;
    const isRenaming = renamingId === conversation.id;
    const timeLabel = formatRelativeTime(conversationTimestamp(conversation));

    if (collapsed && !isMobileMode) {
      return (
        <div
          key={conversation.id}
          role="listitem"
          className="relative flex justify-center py-0.5"
        >
          <button
            type="button"
            className={cn(
              "relative grid h-9 w-9 place-items-center rounded-xl transition-[transform,opacity] motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              active
                ? "bg-[color:var(--app-accent)] text-white shadow-sm"
                : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            )}
            onClick={() => onSelectConversation(conversation.id)}
            disabled={disabled || pending}
            aria-current={active ? "page" : undefined}
            title={title}
          >
            <MessageSquare
              className="h-4 w-4"
              strokeWidth={active ? 2 : 1.8}
              aria-hidden="true"
            />
          </button>
        </div>
      );
    }

    return (
      <div
        key={conversation.id}
        role="listitem"
        className={cn(
          "group relative rounded-xl transition-[transform,opacity] motion-reduce:transition-none duration-150",
          active
            ? "bg-[color:var(--app-accent)] text-white shadow-sm"
            : "text-foreground/80 hover:bg-foreground/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
        )}
      >
        {isRenaming ? (
          <form
            onSubmit={submitRename}
            className="flex items-center gap-1 rounded-xl bg-background/90 p-1 ring-1 ring-black/10 dark:bg-[#141720] dark:ring-white/15"
          >
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-xs font-medium text-foreground focus-visible:ring-0"
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
              className="h-6 w-6 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-500 dark:text-emerald-400"
              disabled={pending || !normalizeTitle(renameValue)}
              aria-label="Save chat name"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="h-6 w-6 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
              onClick={cancelRename}
              disabled={pending}
              aria-label="Cancel rename"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </form>
        ) : (
          <div className="relative flex items-center min-w-0">
            <button
              type="button"
              className={cn(
                "flex h-9 min-w-0 flex-1 items-center rounded-xl pl-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/60",
                isMobileMode ? "pr-8" : "pr-7",
                active ? "font-semibold text-white" : "font-medium text-foreground/80 group-hover:text-foreground"
              )}
              onClick={() => onSelectConversation(conversation.id)}
              disabled={disabled || pending}
              aria-current={active ? "page" : undefined}
              title={title}
            >
              <span className="truncate text-[13px] leading-tight flex-1">
                {title}
              </span>

              {timeLabel ? (
                <span
                  className={cn(
                    "shrink-0 text-[11px] tabular-nums font-normal transition-opacity duration-150",
                    active ? "text-white/80" : "text-muted-foreground/50",
                    !isMobileMode && "group-hover:opacity-0 group-focus-within:opacity-0"
                  )}
                >
                  {timeLabel}
                </span>
              ) : null}
            </button>

            <div
              className={cn(
                "absolute right-1 top-1/2 -translate-y-1/2",
                !isMobileMode && !pending && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150",
                isMobileMode && "opacity-100"
              )}
            >
              {pending ? (
                <span role="status" aria-label={`Deleting ${title}`} className="grid h-7 w-7 place-items-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                </span>
              ) : <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "h-7 w-7 rounded-lg focus-visible:opacity-100",
                      active
                        ? "text-white/80 hover:bg-white/20 hover:text-white"
                        : "text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground dark:hover:bg-white/[0.1]"
                    )}
                    disabled={disabled || pending}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Open actions for ${title}`}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="z-[560]">
                  <DropdownMenuItem
                    className="cursor-pointer rounded-[10px] hover:!bg-[color:var(--app-accent)] hover:!text-[color:var(--app-accent-fg)] hover:[&_svg]:!stroke-[color:var(--app-accent-fg)] hover:[&_svg]:!text-[color:var(--app-accent-fg)] focus:!bg-[color:var(--app-accent)] focus:!text-[color:var(--app-accent-fg)] focus:[&_svg]:!stroke-[color:var(--app-accent-fg)] focus:[&_svg]:!text-[color:var(--app-accent-fg)]"
                    onSelect={() => startRename(conversation)}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    Rename chat
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    className="cursor-pointer rounded-[10px] hover:!bg-[color:var(--app-destructive)] hover:!text-[color:var(--app-destructive-fg)] hover:[&_svg]:!stroke-[color:var(--app-destructive-fg)] hover:[&_svg]:!text-[color:var(--app-destructive-fg)] focus:!bg-[color:var(--app-destructive)] focus:!text-[color:var(--app-destructive-fg)] focus:[&_svg]:!stroke-[color:var(--app-destructive-fg)] focus:[&_svg]:!text-[color:var(--app-destructive-fg)]"
                    onSelect={() => setDeleteTarget(conversation)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Delete chat
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <aside
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-hidden text-foreground",
          isMobileMode
            ? "chrome-glass-surface rounded-br-[28px] bg-background/95 shadow-[18px_0_42px_rgba(0,0,0,0.25)] border-r border-black/[0.06] dark:border-white/[0.08] dark:bg-[#0A0A0C]/95"
            : "border-r border-black/[0.06] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--app-accent-soft)_22%,var(--background)),var(--background))] backdrop-blur-xl dark:border-white/[0.08] dark:bg-[#070709]",
          collapsed && !isMobileMode ? "w-16" : "w-72",
          className
        )}
        aria-label="Agent chat history"
        data-collapsed={collapsed ? "true" : "false"}
      >
        {isMobileMode ? (
          <div className="border-b border-border/65 px-3 py-3 dark:border-white/10">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-[16px] font-semibold tracking-[-0.01em] text-foreground">
                  {listTitle}
                </h2>
                {conversations.length > 0 ? (
                  <span className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-muted-foreground dark:bg-white/[0.08]">
                    {conversations.length}
                  </span>
                ) : null}
              </div>
              {onClose && !hideCloseButton ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                  onClick={onClose}
                  aria-label="Close chat history"
                  title="Close chats"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            {puppyFootnote}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-chat-new-button
              className="mt-2.5 flex h-9 w-full items-center justify-between rounded-xl border-black/[0.08] bg-foreground/[0.035] px-3 text-[13px] font-medium text-foreground transition-[transform,opacity] motion-reduce:transition-none duration-150 hover:border-black/15 hover:bg-foreground/[0.06] hover:shadow-xs active:scale-[0.98] dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-white/20 dark:hover:bg-white/[0.07]"
              onClick={onCreateNew}
              disabled={disabled}
              aria-label="Create new chat"
              title="Create new chat"
            >
              <div className="flex items-center gap-2">
                <Plus className="h-3.5 w-3.5 text-muted-foreground/80 group-hover:text-foreground" strokeWidth={2.2} aria-hidden="true" />
                <span className="font-medium text-[13px]">New chat</span>
              </div>
            </Button>
          </div>
        ) : (
          <div className="border-b border-black/[0.05] p-3 dark:border-white/[0.06]">
            {collapsed && !isMobileMode ? (
              <div className="flex w-full flex-col items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-xl border border-black/10 bg-black/[0.035] text-muted-foreground hover:bg-black/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
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
                  className="h-9 w-9 rounded-xl bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)] hover:bg-[color:var(--app-accent)]/20 focus-visible:ring-2 focus-visible:ring-primary/60"
                  onClick={onCreateNew}
                  disabled={disabled}
                  aria-label="Create new chat"
                  title="New chat"
                >
                  <Plus className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[13.5px] font-semibold tracking-tight text-foreground">
                      {listTitle}
                    </h2>
                    {conversations.length > 0 ? (
                      <span className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-muted-foreground dark:bg-white/[0.08]">
                        {conversations.length}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {onToggleCollapsed ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="hidden h-8 w-8 rounded-lg text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.08] lg:inline-flex"
                        onClick={onToggleCollapsed}
                        aria-label="Collapse chat history"
                        title="Collapse chat history"
                      >
                        <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                    {onClose ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                        onClick={onClose}
                        aria-label="Close chat history"
                        title="Close chat history"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                {puppyFootnote}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-chat-new-button
                  className="group relative flex h-9 w-full items-center justify-between rounded-xl border-black/[0.08] bg-foreground/[0.035] px-3 text-[13px] font-medium text-foreground transition-[transform,opacity] motion-reduce:transition-none duration-150 hover:border-black/15 hover:bg-foreground/[0.06] hover:shadow-xs active:scale-[0.98] dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-white/20 dark:hover:bg-white/[0.07]"
                  onClick={onCreateNew}
                  disabled={disabled}
                  aria-label="Create new chat"
                  title="Create new chat"
                >
                  <div className="flex items-center gap-2">
                    <Plus className="h-3.5 w-3.5 text-muted-foreground/80 group-hover:text-foreground" strokeWidth={2.2} aria-hidden="true" />
                    <span className="font-medium text-[13px]">New chat</span>
                  </div>
                  <kbd className="rounded border border-black/10 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 dark:border-white/10 dark:bg-black/40">
                    ⌘N
                  </kbd>
                </Button>
              </div>
            )}
          </div>
        )}

        {!collapsed ? (
          <div className="px-3 pt-2.5 pb-1">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70"
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
                className="h-9 rounded-xl border border-black/[0.06] bg-foreground/[0.035] pl-8 pr-8 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus-visible:border-[color:var(--app-accent)]/50 focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-[color:var(--app-accent)]/30 dark:border-white/[0.07] dark:bg-white/[0.04] dark:focus-visible:bg-[#0c0c0e]"
              />
              <SearchClearButton
                visible={searchQuery.length > 0}
                label="Clear chat search"
                onClear={() => setSearchQuery("")}
              />
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-5 pt-1.5 scrollbar-thin scrollbar-thumb-black/10 dark:scrollbar-thumb-white/10 scrollbar-track-transparent">
          {collapsed ? <div className="h-2" aria-hidden="true" /> : null}

          {loading ? (
            <div className="space-y-2 py-2">
              <div className="h-9 w-full animate-pulse rounded-xl bg-foreground/[0.04] dark:bg-white/[0.05]" />
              <div className="h-9 w-full animate-pulse rounded-xl bg-foreground/[0.04] dark:bg-white/[0.05]" />
              <div className="h-9 w-full animate-pulse rounded-xl bg-foreground/[0.04] dark:bg-white/[0.05]" />
            </div>
          ) : null}

          {!collapsed && !loading && conversations.length === 0 ? (
            <div className="my-3 flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 bg-foreground/[0.015] px-4 py-8 text-center dark:border-white/10 dark:bg-white/[0.02]">
              <div className="mb-2.5 grid h-10 w-10 place-items-center rounded-xl bg-foreground/[0.04] text-muted-foreground dark:bg-white/[0.06]">
                <MessageSquare className="h-5 w-5 opacity-70" strokeWidth={1.8} aria-hidden="true" />
              </div>
              <p className="text-[13px] font-semibold text-foreground/80">No chats yet</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                Start a new chat to begin your conversation with One.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3.5 h-8 gap-1.5 rounded-lg border-black/10 bg-background/50 text-xs font-medium hover:bg-foreground/[0.06] dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
                onClick={onCreateNew}
                disabled={disabled}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Start new chat</span>
              </Button>
            </div>
          ) : null}

          {!collapsed &&
          !loading &&
          conversations.length > 0 &&
          filteredConversations.length === 0 ? (
            <div className="my-3 flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 bg-foreground/[0.015] px-4 py-7 text-center dark:border-white/10 dark:bg-white/[0.02]">
              <div className="mb-2 grid h-9 w-9 place-items-center rounded-xl bg-foreground/[0.04] text-muted-foreground dark:bg-white/[0.06]">
                <Search className="h-4 w-4 opacity-70" aria-hidden="true" />
              </div>
              <p className="text-[13px] font-semibold text-foreground/80">No matches found</p>
              <p className="mt-0.5 max-w-[210px] truncate text-[11.5px] text-muted-foreground">
                No chats match &ldquo;{searchQuery.trim()}&rdquo;
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery("")}
              >
                Clear search
              </Button>
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
            <div className="space-y-4">
              {groupedConversations.map((group) => (
                <div key={group.key}>
                  <div className="px-2 pb-1 pt-2 text-[11px] font-medium tracking-wide text-muted-foreground/70">
                    {group.label}
                  </div>
                  <div
                    className="space-y-0.5"
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
        {onOpenConnectors ? (
          <div className="shrink-0 border-t border-border/60 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <Button
              type="button"
              variant="ghost"
              size="compact"
              className={cn(
                "group min-h-11 w-full rounded-xl text-[13px] font-medium text-foreground focus-visible:ring-2 focus-visible:ring-primary/60",
                collapsed && !isMobileMode ? "justify-center px-0" : "justify-start px-3",
              )}
              onClick={(event) => onOpenConnectors(event.currentTarget)}
              aria-label="Open Connectors"
              title={collapsed && !isMobileMode ? "Connectors" : undefined}
            >
              <PlugIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {collapsed && !isMobileMode ? null : <span className="ml-2 truncate">Connectors</span>}
            </Button>
          </div>
        ) : null}
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
