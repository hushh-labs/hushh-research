"use client";

import { FormEvent, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Unplug as PlugIcon,
  CheckIcon as Check,
  Download as DownloadIcon,
  MessageSquareIcon as MessageSquare,
  DotsThreeIcon as MoreHorizontal,
  Loader2Icon as Loader2,
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
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";
import { parseChatTimestamp } from "@/lib/agent/chat-time-separators";
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
  /** Opens the Get the app prompt. Omitted inside the installed app. */
  onGetApp?: (trigger: HTMLButtonElement) => void;
  /** Whether the Get the app prompt is showing, for its control's state. */
  getAppOpen?: boolean;
  /** Feed-style background activity, kept separate from conversation search. */
  driveActivity?: ReactNode;
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
  // ADK session times are epoch seconds; `Date.parse` read them as NaN, so
  // every chat grouped as "Older" with no time beside it.
  const candidate =
    conversation.last_message_at ??
    conversation.updated_at ??
    conversation.created_at ??
    null;
  return parseChatTimestamp(candidate)?.getTime() ?? 0;
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
  onGetApp,
  getAppOpen = false,
  driveActivity,
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
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      );
    }

    return (
      <div
        key={conversation.id}
        role="listitem"
        className={cn(
          "group relative rounded-[12px] transition-colors motion-reduce:transition-none duration-150",
          active
            ? "bg-[color:var(--one-chat-row-active)] text-foreground"
            : "text-foreground/80 hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground"
        )}
      >
        {isRenaming ? (
          <form
            onSubmit={submitRename}
            className="flex items-center gap-1 rounded-[12px] bg-[color:var(--one-chat-raised)] p-1 ring-1 ring-[color:var(--one-chat-divider)]"
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
          // Title, time and the actions control sit on one line, as in the
          // reference: the time stays put and the dots appear beside it.
          <div className={cn("relative flex min-w-0 items-center", isMobileMode ? "pr-1" : "group-hover:pr-1 group-focus-within:pr-1")}>
            <button
              type="button"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-[12px] pl-3 pr-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60",
                // 44px rows in the touch drawer (Apple's minimum hit target).
                isMobileMode ? "h-11" : "h-9",
                active ? "font-medium text-foreground" : "font-normal text-foreground/85 group-hover:text-foreground"
              )}
              onClick={() => onSelectConversation(conversation.id)}
              disabled={disabled || pending}
              aria-current={active ? "page" : undefined}
              title={title}
            >
              <span className={cn("flex-1 truncate leading-tight", isMobileMode ? "text-[15px]" : "text-[14px]")}>
                {title}
              </span>

              {timeLabel ? (
                <span
                  className={cn(
                    "shrink-0 text-[12.5px] tabular-nums font-normal text-[color:var(--one-chat-meta)]",
                    // Desktop shows a row's age only on hover or focus (and
                    // while its menu is open), and until then it takes no
                    // room, so the title runs the full row. Touch keeps it.
                    !isMobileMode &&
                      "hidden group-hover:inline group-focus-within:inline group-has-[[data-state=open]]:inline",
                  )}
                >
                  {timeLabel}
                </span>
              ) : null}
            </button>

            <div
              className={cn(
                "shrink-0",
                // Touch keeps it visible; desktop reveals it with the time,
                // on hover or keyboard focus (focusing the row shows it before
                // Tab reaches it), and holds it while the menu is open.
                !isMobileMode && !pending &&
                  "hidden group-hover:block group-focus-within:block group-has-[[data-state=open]]:block",
              )}
            >
              {pending ? (
                <span role="status" aria-label={`Deleting ${title}`} className="grid h-8 w-8 place-items-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                </span>
              ) : <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="h-8 w-8 rounded-full text-foreground/70 hover:bg-[color:var(--one-chat-row-active)] hover:text-foreground focus-visible:opacity-100 data-[state=open]:bg-[color:var(--one-chat-row-active)] data-[state=open]:text-foreground"
                    disabled={disabled || pending}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Open actions for ${title}`}
                  >
                    <MoreHorizontal className="size-[18px]" weight="bold" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  data-one-chat-surface
                  // Beside the row on desktop, as in the reference; in the
                  // phone drawer there is no room to the right, so below it.
                  side={isMobileMode ? "bottom" : "right"}
                  align={isMobileMode ? "end" : "start"}
                  sideOffset={isMobileMode ? 6 : 10}
                  alignOffset={isMobileMode ? 0 : -6}
                  collisionPadding={12}
                  // Opaque and borderless, lifted by a soft shadow only, as in
                  // the reference. The fallback keeps it opaque even if the
                  // chat tokens are missing, so rows can never show through.
                  className="min-w-[12.5rem] rounded-[20px] border-0 bg-[color:var(--one-chat-menu,var(--popover))] p-1.5 text-foreground shadow-[0_16px_44px_-10px_rgba(0,0,0,0.22),0_2px_8px_rgba(0,0,0,0.06)] dark:shadow-[0_18px_48px_-8px_rgba(0,0,0,0.75),0_2px_8px_rgba(0,0,0,0.4)]"
                >
                  <DropdownMenuItem
                    className="h-11 cursor-pointer gap-3 rounded-[14px] px-3 text-[15px] focus:!bg-[color:var(--one-chat-row-active)] focus:!text-foreground [&_svg]:!size-[18px]"
                    onSelect={() => startRename(conversation)}
                  >
                    <Pencil aria-hidden="true" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    className="h-11 cursor-pointer gap-3 rounded-[14px] px-3 text-[15px] focus:!bg-[color:var(--one-chat-row-active)] [&_svg]:!size-[18px]"
                    onSelect={() => setDeleteTarget(conversation)}
                  >
                    <Trash2 aria-hidden="true" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>}
            </div>
          </div>
        )}
      </div>
    );
  };

  const railMode = collapsed && !isMobileMode;
  const searchField = (
    <div className="relative min-w-0 flex-1">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--one-chat-meta)]"
        aria-hidden="true"
      />
      <Input
        type="search"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        // Short, as in the reference: "Search chats" was cut to "Search ch"
        // in the narrower column. The accessible name keeps the full phrase.
        placeholder="Search"
        aria-label="Search chats"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "rounded-full border border-[color:var(--one-chat-search-border)] bg-[color:var(--one-chat-search-bg)] pl-9 pr-9 text-[14px] text-foreground shadow-none placeholder:text-[color:var(--one-chat-meta)] focus-visible:border-[color:var(--app-accent)]/50 focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/25",
          isMobileMode ? "h-11" : "h-9",
        )}
      />
      <SearchClearButton
        visible={searchQuery.length > 0}
        label="Clear chat search"
        onClear={() => setSearchQuery("")}
      />
    </div>
  );
  // Quiet list rows, as in the reference: no pill outline or glass, only a
  // hover fill. The shared control keeps its focus ring and ripple.
  const footerButtonClassName = cn(
    "h-11 min-h-11 w-full rounded-[12px] border-transparent bg-transparent text-[14px] font-medium text-foreground shadow-none hover:bg-[color:var(--one-chat-row-hover)] sm:text-[14px]",
    railMode ? "justify-center px-0 sm:px-0" : "justify-start gap-3 px-3 sm:gap-3 sm:px-3",
  );

  return (
    <>
      <aside
        data-one-chat-surface
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-hidden text-foreground",
          // Opaque in the drawer: the panel slides with a transform, and WebKit
          // (iOS WKWebView) takes that transformed panel as the backdrop root, so
          // a translucent glass surface blurred nothing and showed the chat
          // through the drawer on iOS while Chromium's blur hid it on web.
          // The drawer runs the full viewport height, flush to the leading edge
          // (founder direction, 2026-09-28), so only the trailing corners round
          // and the surface pads the safe areas itself: under the status bar and
          // home indicator it is panel, never a gap.
          isMobileMode
            ? "rounded-r-[24px] border-r border-[color:var(--one-chat-divider)] bg-[color:var(--one-chat-sidebar)] pt-[var(--app-safe-area-top-effective,0px)] pb-[var(--app-safe-area-bottom-effective,0px)] shadow-[0_24px_56px_-16px_rgba(0,0,0,0.22),0_2px_8px_rgba(0,0,0,0.06)] dark:shadow-[0_24px_56px_-16px_rgba(0,0,0,0.7)]"
            // Persistent desktop column (Muse-style two-column layout): one
            // surface with the chat, separated by a hairline, never a scrim.
            : "border-r border-[color:var(--one-chat-divider)] bg-[color:var(--one-chat-sidebar)]",
          railMode ? "w-16" : "w-60",
          className
        )}
        aria-label="Agent chat history"
        data-collapsed={collapsed ? "true" : "false"}
        data-agent-history-sidebar={isMobileMode ? "drawer" : "persistent"}
      >
        {isMobileMode ? (
          <div className="px-4 pb-1 pt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-[22px] font-bold leading-7 tracking-[-0.022em] text-foreground">
                  {listTitle}
                </h2>
                {conversations.length > 0 ? (
                  <span className="rounded-full bg-[color:var(--one-chat-field)] px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-[color:var(--one-chat-meta)]">
                    {conversations.length}
                  </span>
                ) : null}
              </div>
              {onClose && !hideCloseButton ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  // 32px glyph well, 44px hit area (the ::after extends it 6px each side).
                  className="relative h-8 w-8 rounded-lg text-muted-foreground after:absolute after:-inset-1.5 hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground"
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
              className="mt-3 flex h-11 w-full items-center justify-start gap-2 rounded-[12px] border-transparent bg-[color:var(--one-chat-field)] px-3 text-[15px] font-medium text-foreground shadow-none transition-[transform,background-color] motion-reduce:transition-none duration-150 hover:bg-[color:var(--one-chat-field-strong)] dark:border-transparent dark:bg-[color:var(--one-chat-field)] dark:hover:bg-[color:var(--one-chat-field-strong)]"
              onClick={onCreateNew}
              disabled={disabled}
              aria-label="Create new chat"
              title="Create new chat"
            >
              <Plus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>New chat</span>
            </Button>
          </div>
        ) : railMode ? (
          <div className="flex w-full flex-col items-center gap-2 p-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl text-muted-foreground hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
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
              className="h-9 w-9 rounded-xl text-muted-foreground hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
              onClick={onCreateNew}
              disabled={disabled}
              aria-label="Create new chat"
              title="New chat"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          // Search first, level with the chat header, then New chat beside it.
          <div className="flex h-[var(--agent-chat-header-height,4rem)] shrink-0 items-center gap-2 px-3 pt-[var(--agent-chat-header-safe-top,0px)]">
            {searchField}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-chat-new-button
              className="h-10 w-10 shrink-0 rounded-full text-muted-foreground hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
              onClick={onCreateNew}
              disabled={disabled}
              aria-label="Create new chat"
              title="New chat"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
            </Button>
          </div>
        )}

        {isMobileMode ? <div className="px-4 pb-1 pt-2">{searchField}</div> : null}
        {!isMobileMode && !railMode && puppyFootnote ? <div className="px-4">{puppyFootnote}</div> : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3 pt-0.5 scrollbar-thin scrollbar-thumb-black/10 dark:scrollbar-thumb-white/10 scrollbar-track-transparent">
          {railMode ? <div className="h-2" aria-hidden="true" /> : null}

          {!railMode && surface === "one" ? driveActivity : null}

          {loading ? (
            <div className="space-y-2 py-2" aria-label="Loading chats" role="status">
              <div className="h-10 w-full animate-pulse rounded-[12px] bg-[color:var(--one-chat-field)] motion-reduce:animate-none" />
              <div className="h-10 w-full animate-pulse rounded-[12px] bg-[color:var(--one-chat-field)] motion-reduce:animate-none" />
              <div className="h-10 w-full animate-pulse rounded-[12px] bg-[color:var(--one-chat-field)] motion-reduce:animate-none" />
            </div>
          ) : null}

          {!railMode && !loading && conversations.length === 0 ? (
            <div className="my-3 flex flex-col items-center justify-center rounded-2xl border border-dashed border-[color:var(--one-chat-divider)] px-4 py-8 text-center">
              <div className="mb-2.5 grid h-10 w-10 place-items-center rounded-xl bg-[color:var(--one-chat-field)] text-muted-foreground">
                <MessageSquare className="h-5 w-5 opacity-70" aria-hidden="true" />
              </div>
              <p className="text-[13px] font-semibold text-foreground/80">No chats yet</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                Start a new chat to begin your conversation with One.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3.5 h-9 gap-1.5 rounded-full border-[color:var(--one-chat-divider)] bg-transparent px-3.5 text-xs font-medium hover:bg-[color:var(--one-chat-row-hover)] dark:border-[color:var(--one-chat-divider)] dark:bg-transparent"
                onClick={onCreateNew}
                disabled={disabled}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Start new chat</span>
              </Button>
            </div>
          ) : null}

          {!railMode &&
          !loading &&
          conversations.length > 0 &&
          filteredConversations.length === 0 ? (
            <div className="my-3 flex flex-col items-center justify-center rounded-2xl border border-dashed border-[color:var(--one-chat-divider)] px-4 py-7 text-center">
              <div className="mb-2 grid h-9 w-9 place-items-center rounded-xl bg-[color:var(--one-chat-field)] text-muted-foreground">
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
                className="mt-2 h-8 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery("")}
              >
                Clear search
              </Button>
            </div>
          ) : null}

          {railMode ? (
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
                  <div
                    className={cn(
                      "px-3 pb-1 pt-1.5 font-normal text-[color:var(--one-chat-meta)]",
                      isMobileMode ? "text-[14px]" : "text-[13.5px]",
                    )}
                  >
                    {group.label}
                  </div>
                  <div
                    className="space-y-px"
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
        {onGetApp || onOpenConnectors ? (
          // Pinned below the list: it scrolls, these never do.
          <div
            data-agent-history-footer
            className="shrink-0 space-y-0.5 border-t border-[color:var(--one-chat-divider)] px-2.5 py-2"
          >
            {onGetApp ? (
              <ShellActionSurface
                variant="pill"
                type="button"
                wrapperClassName="w-full"
                data-testid="agent-history-get-app"
                className={footerButtonClassName}
                onClick={(event) => onGetApp(event.currentTarget)}
                aria-label="Get the app"
                aria-haspopup="dialog"
                aria-expanded={getAppOpen}
                title={railMode ? "Get the app" : undefined}
              >
                <DownloadIcon className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
                {railMode ? null : <span className="truncate">Get the app</span>}
              </ShellActionSurface>
            ) : null}
            {onOpenConnectors ? (
              <ShellActionSurface
                variant="pill"
                type="button"
                wrapperClassName="w-full"
                className={footerButtonClassName}
                onClick={(event) => onOpenConnectors(event.currentTarget)}
                aria-label="Open Connectors"
                title={railMode ? "Connectors" : undefined}
              >
                <PlugIcon className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
                {railMode ? null : <span className="truncate">Connectors</span>}
              </ShellActionSurface>
            ) : null}
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
