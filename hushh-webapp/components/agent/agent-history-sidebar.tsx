"use client";

import { FormEvent, useMemo, useState, type ReactNode } from "react";
import { useShortcutIconMotion } from "@/lib/morphy-ux/hooks/use-shortcut-icon-motion";
import {
  ConnectorsShortcutIcon,
  CheckIcon as Check,
  DownloadAppIcon,
  MessageSquareIcon as MessageSquare,
  DotsThreeIcon as MoreHorizontal,
  Loader2Icon as Loader2,
  PanelLeftOpenIcon as PanelLeftOpen,
  PencilIcon as Pencil,
  PlusIcon as Plus,
  SearchIcon as Search,
  Trash2,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SearchClearButton } from "@/components/app-ui/search-clear-button";
import { SidePanelMotionBody } from "@/components/app-ui/side-panel-motion";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { AnimatedMenuCrossIcon } from "@/components/agent/animated-menu-cross-icon";
import { HusshOneLockup } from "@/components/brand/hussh-one-lockup";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";
import { parseChatTimestamp } from "@/lib/agent/chat-time-separators";
import { cn } from "@/lib/utils";

type AgentHistorySidebarProps = {
  conversations: AgentChatConversation[];
  activeConversationId: string | null;
  loading?: boolean;
  disabled?: boolean;
  /** Local draft reset can remain available while saved history is locked. */
  createNewDisabled?: boolean;
  actionPendingId?: string | null;
  className?: string;
  collapsed?: boolean;
  mode?: "desktop" | "mobile";
  hideCloseButton?: boolean;
  closeControl?: ReactNode;
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
  /** Persistent head-orchestrator stream ("One") pinned above focused Chats. */
  pinnedOneConversationId?: string | null;
  oneStreamActive?: boolean;
  pendingOneActionCount?: number;
  onSelectOneStream?: () => void;
  onCreateNew: () => void;
  onSelectConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => Promise<void> | void;
  onCategorizeConversation?: (
    conversationId: string,
    category: string | null,
  ) => Promise<void> | void;
  onDeleteConversation: (conversationId: string) => Promise<void> | void;
};

export const STANDARD_CHAT_CATEGORIES = [
  "Personal",
  "Finance",
  "Connections",
  "Work",
] as const;

const FINANCE_CUES =
  /\b(?:plaid|bank|banks|account|accounts|cashflow|cash\s+flow|liabilit(?:y|ies)|portfolio|net\s+worth|investment|investments|stock|stocks|market|wallet|stripe|payout|payouts|tariff|pricing|receipt|receipts|tax|taxes|budget|spending|expense|expenses)\b/i;
const CONNECTIONS_CUES =
  /\b(?:connection|connections|circle|circles|shared\s+with\s+me|share\s+with|information\s+request|request\s+.*\bfrom\b|access\s+request|consent|grant|grants|trusted|people|invite)\b/i;
const WORK_CUES =
  /\b(?:gmail|email|emails|inbox|calendar|schedule|meeting|meetings|drive|document|documents|deck|slide|slides|project|projects|client|clients|advisory|brief|report|task|tasks|todo|mcp|slack|github|jira|notion)\b/i;

export function normalizeCategoryLabel(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 32);
  return cleaned || null;
}

export function resolveConversationCategory(
  conversation: Pick<AgentChatConversation, "title" | "category">,
): string {
  const explicit = normalizeCategoryLabel(conversation.category);
  if (explicit) return explicit;
  const title = normalizeTitle(conversation.title || "");
  if (CONNECTIONS_CUES.test(title)) return "Connections";
  if (FINANCE_CUES.test(title)) return "Finance";
  if (WORK_CUES.test(title)) return "Work";
  return "Personal";
}

export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

export function isPinnedOneStreamConversation(
  conversation: Pick<AgentChatConversation, "title">,
): boolean {
  return normalizeTitle(conversation.title).toLowerCase() === "one";
}

function conversationLabel(conversation: AgentChatConversation): string {
  const title = normalizeTitle(conversation.title);
  return title || "New chat";
}

export function displayConversationLabel(conversation: AgentChatConversation): string {
  const label = conversationLabel(conversation)
    .replace(/\bpkm\b/giu, "personal details")
    .replace(/\s+/g, " ")
    .trim();

  return label ? `${label.slice(0, 1).toUpperCase()}${label.slice(1)}` : "New chat";
}

export function conversationTimestamp(conversation: AgentChatConversation): number {
  // ADK session times are epoch seconds; `Date.parse` read them as NaN, so
  // every chat grouped as "Older" with no time beside it.
  const candidate =
    conversation.last_message_at ??
    conversation.updated_at ??
    conversation.created_at ??
    null;
  return parseChatTimestamp(candidate)?.getTime() ?? 0;
}

export function formatRelativeTime(timestamp: number): string {
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

export const GROUP_LABELS: Record<ConversationGroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7: "Last 7 days",
  previous30: "Last 30 days",
  earlier: "Older",
};

export const GROUP_ORDER: ConversationGroupKey[] = [
  "today",
  "yesterday",
  "previous7",
  "previous30",
  "earlier",
];

export function conversationGroupKey(
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
  createNewDisabled = disabled,
  actionPendingId,
  className,
  collapsed = false,
  mode = "desktop",
  hideCloseButton = false,
  closeControl,
  surface = "one",
  onClose,
  onToggleCollapsed,
  onOpenConnectors,
  onGetApp,
  getAppOpen = false,
  driveActivity,
  pinnedOneConversationId = null,
  oneStreamActive = false,
  pendingOneActionCount = 0,
  onSelectOneStream,
  onCreateNew,
  onSelectConversation,
  onRenameConversation,
  onCategorizeConversation,
  onDeleteConversation,
}: AgentHistorySidebarProps) {
  const shortcutInteraction = useShortcutIconMotion();
  const isMobileMode = mode === "mobile";
  const showPinnedOneStream = surface === "one" && Boolean(onSelectOneStream);
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
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [customCategoryTarget, setCustomCategoryTarget] =
    useState<AgentChatConversation | null>(null);
  const [customCategoryDraft, setCustomCategoryDraft] = useState("");

  const trimmedQuery = searchQuery.trim().toLowerCase();

  const chatConversations = useMemo(() => {
    if (!showPinnedOneStream) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.id !== pinnedOneConversationId &&
        !isPinnedOneStreamConversation(conversation),
    );
  }, [conversations, pinnedOneConversationId, showPinnedOneStream]);

  const categorySummary = useMemo(() => {
    const counts = new Map<string, number>();
    const customNames: string[] = [];
    for (const conversation of chatConversations) {
      const cat = resolveConversationCategory(conversation);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
      if (
        !STANDARD_CHAT_CATEGORIES.includes(
          cat as (typeof STANDARD_CHAT_CATEGORIES)[number],
        ) &&
        !customNames.includes(cat)
      ) {
        customNames.push(cat);
      }
    }
    const ordered = [
      ...STANDARD_CHAT_CATEGORIES.filter((cat) => (counts.get(cat) ?? 0) > 0),
      ...customNames.sort((a, b) => a.localeCompare(b)),
    ];
    return { counts, ordered, customNames };
  }, [chatConversations]);

  const effectiveActiveCategory =
    activeCategory === "All" || categorySummary.counts.has(activeCategory)
      ? activeCategory
      : "All";

  const filteredConversations = useMemo(() => {
    return chatConversations.filter((conversation) => {
      const category = resolveConversationCategory(conversation);
      if (
        effectiveActiveCategory !== "All" &&
        category !== effectiveActiveCategory
      ) {
        return false;
      }
      if (!trimmedQuery) return true;
      return (
        displayConversationLabel(conversation)
          .toLowerCase()
          .includes(trimmedQuery) ||
        category.toLowerCase().includes(trimmedQuery)
      );
    });
  }, [chatConversations, effectiveActiveCategory, trimmedQuery]);

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
    try {
      await onRenameConversation(renamingId, nextTitle);
      cancelRename();
    } catch {
      // The owning workspace reports the error. Preserve the editor and its
      // typed value so a transient failure can be retried without retyping.
    }
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    setDeleteTarget(null);
    void Promise.resolve(onDeleteConversation(targetId)).catch(() => undefined);
  };

  const assignCategory = (conversationId: string, category: string | null) => {
    if (!onCategorizeConversation) return;
    const normalized = category ? normalizeCategoryLabel(category) : null;
    void Promise.resolve(onCategorizeConversation(conversationId, normalized)).catch(
      () => undefined,
    );
  };

  const openCustomCategoryModal = (conversation: AgentChatConversation) => {
    setCustomCategoryTarget(conversation);
    setCustomCategoryDraft(
      conversation.category_source === "custom"
        ? normalizeCategoryLabel(conversation.category) ?? ""
        : "",
    );
  };

  const submitCustomCategory = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!customCategoryTarget) return;
    const nextCategory = normalizeCategoryLabel(customCategoryDraft);
    if (!nextCategory) return;
    const targetId = customCategoryTarget.id;
    setCustomCategoryTarget(null);
    setCustomCategoryDraft("");
    assignCategory(targetId, nextCategory);
  };

  const renderConversationItem = (conversation: AgentChatConversation) => {
    const title = displayConversationLabel(conversation);
    const active = conversation.id === activeConversationId;
    const pending = actionPendingId === conversation.id;
    const isRenaming = renamingId === conversation.id;
    const timeLabel = formatRelativeTime(conversationTimestamp(conversation));
    const resolvedCategory = resolveConversationCategory(conversation);
    const isCustomCategory = conversation.category_source === "custom";
    const menuCategoryChoices = Array.from(
      new Set([
        ...STANDARD_CHAT_CATEGORIES,
        ...categorySummary.customNames,
        ...(isCustomCategory ? [resolvedCategory] : []),
      ]),
    );

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
        data-agent-history-row
        data-state={active ? "active" : undefined}
        role="listitem"
        className={cn(
          "group relative rounded-[12px] transition-colors motion-reduce:transition-none duration-150",
          isMobileMode
            ? active
              ? "text-foreground"
              : "text-foreground/85 hover:text-foreground"
            : active
              ? "bg-[color:var(--one-chat-row-active)] text-foreground"
              : "text-foreground/80 hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground",
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
              className={cn("h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-xs font-normal text-foreground focus-visible:ring-0", isMobileMode && "h-11 text-[13px]")}
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
              className={isMobileMode ? "h-11 w-11 text-[color:var(--app-accent)] hover:bg-[color:var(--one-chat-field)]" : "h-6 w-6 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-500 dark:text-emerald-400"}
              disabled={pending || !normalizeTitle(renameValue)}
              aria-label="Save chat name"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={cn("h-6 w-6 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground", isMobileMode && "h-11 w-11")}
              onClick={cancelRename}
              disabled={pending}
              aria-label="Cancel rename"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </form>
        ) : (
          // Age follows the title in its text flow, not a second trailing
          // column. Only the action target reserves space at the row edge.
          <div className={cn("relative flex min-w-0 items-center", !isMobileMode && "pr-1")}>
            <button
              type="button"
              className={cn(
                "block min-w-0 flex-1 rounded-[12px] pl-3 pr-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60",
                isMobileMode && "relative isolate overflow-hidden",
                // Keep the complete title readable on touch without relying on hover.
                isMobileMode ? "min-h-11 py-2" : "min-h-9 py-2",
                active ? "font-medium text-foreground" : "font-normal text-foreground/85 group-hover:text-foreground"
              )}
              onClick={() => onSelectConversation(conversation.id)}
              disabled={disabled || pending}
              aria-current={active ? "page" : undefined}
              title={title}
            >
              <span className="flex min-w-0 items-baseline gap-2">
              <span data-agent-history-row-title
                className={cn("min-w-0 flex-1 whitespace-normal wrap-break-word leading-tight", isMobileMode ? "text-[13px]" : "text-[14px]")}>
                {title}
              </span>

              {timeLabel ? (
                <time
                  data-agent-history-row-description
                  dateTime={new Date(conversationTimestamp(conversation)).toISOString()}
                  className={cn(
                    "shrink-0 whitespace-nowrap align-baseline text-[11px] tabular-nums font-normal text-[color:var(--one-chat-meta)]",
                    // Opacity preserves inline geometry on hover and focus.
                    !isMobileMode &&
                      "opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100 group-has-[[data-state=open]]:opacity-100",
                  )}
                >
                  {timeLabel}
                </time>
              ) : null}
              </span>
              {isCustomCategory ? (
                <span
                  data-testid="agent-history-row-category"
                  className="mt-1 inline-flex max-w-full items-center truncate rounded-full bg-[color:var(--app-accent)]/[0.09] px-1.5 py-px text-[10px] font-medium leading-tight text-[color:var(--app-accent)] dark:bg-white/[0.09] dark:text-foreground/80"
                >
                  {resolvedCategory}
                </span>
              ) : null}
              {isMobileMode ? <MaterialRipple variant="none" effect="fade" disabled={disabled || pending} disableHover className="z-10" /> : null}
            </button>

            <div
              className={cn(
                isMobileMode ? "w-11 shrink-0" : "w-8 shrink-0",
                // Touch keeps it visible; desktop reveals it with the time,
                // on hover or keyboard focus (focusing the row shows it before
                // Tab reaches it), and holds it while the menu is open.
                !isMobileMode && !pending &&
                  "opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100 group-has-[[data-state=open]]:opacity-100",
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
                    variant="plain"
                    size="icon-xs"
                    showRipple={false}
                    className={cn(
                      "group/row-actions bg-transparent p-0 text-foreground/65 hover:bg-transparent hover:opacity-100 focus-visible:border-transparent focus-visible:opacity-100 focus-visible:ring-0 data-[state=open]:bg-transparent",
                      isMobileMode ? "flex h-11 w-11 items-center justify-end pr-1" : "grid h-8 w-8 place-items-center",
                    )}
                    disabled={disabled || pending}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Open actions for ${title}`}
                  >
                    <span
                      data-agent-history-row-action-pill
                      className={cn(
                        "grid place-items-center rounded-[8px] transition-colors duration-150 motion-reduce:transition-none group-hover/row-actions:bg-foreground/[0.07] group-hover/row-actions:text-foreground group-focus-visible/row-actions:ring-2 group-focus-visible/row-actions:ring-[color:var(--app-accent)]/50 group-data-[state=open]/row-actions:bg-foreground/[0.10] group-data-[state=open]/row-actions:text-foreground",
                        isMobileMode ? "size-8" : "size-7",
                      )}
                    >
                      <MoreHorizontal className="size-4" weight="bold" aria-hidden="true" />
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  data-one-chat-surface
                  data-app-pane-material={isMobileMode ? "profile" : undefined}
                  // Beside the row on desktop, as in the reference; in the
                  // phone drawer there is no room to the right, so below it.
                  side={isMobileMode ? "bottom" : "right"}
                  align={isMobileMode ? "end" : "start"}
                  sideOffset={isMobileMode ? 6 : 10}
                  alignOffset={isMobileMode ? 0 : -6}
                  collisionPadding={12}
                  // Drawer menus share Profile's material even through a portal.
                  className="w-max min-w-0 max-w-[calc(100vw-24px)] rounded-[17px] border-0 bg-[color:var(--one-chat-menu,var(--popover))] p-1 text-foreground shadow-[0_12px_32px_-10px_rgba(0,0,0,0.22),0_2px_8px_rgba(0,0,0,0.06)] dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7),0_2px_8px_rgba(0,0,0,0.4)]"
                >
                  {/* Bring the labels closer while keeping both 44px tap targets. */}
                  <DropdownMenuItem
                    className="h-11 cursor-pointer gap-3 rounded-[14px] px-3 pt-2.5 pb-0.5 text-[15px] focus:!bg-[color:var(--one-chat-row-active)] focus:!text-foreground [&_svg]:!size-[18px]"
                    onSelect={() => startRename(conversation)}
                  >
                    <Pencil aria-hidden="true" />
                    Rename
                  </DropdownMenuItem>
                  {onCategorizeConversation ? (
                    <>
                      <DropdownMenuSeparator className="my-1 bg-[color:var(--one-chat-divider)]" />
                      <DropdownMenuLabel className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--one-chat-meta)]">
                        Category
                      </DropdownMenuLabel>
                      {menuCategoryChoices.map((choice) => {
                        const selected = resolvedCategory === choice;
                        return (
                          <DropdownMenuItem
                            key={choice}
                            className="h-9 cursor-pointer justify-between gap-3 rounded-[12px] px-3 text-[13.5px] focus:!bg-[color:var(--one-chat-row-active)] focus:!text-foreground"
                            onSelect={() => assignCategory(conversation.id, choice)}
                          >
                            <span className="truncate">{choice}</span>
                            {selected ? (
                              <Check className="size-3.5 shrink-0 text-[color:var(--app-accent)]" aria-hidden="true" />
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                      <DropdownMenuItem
                        className="h-9 cursor-pointer gap-2 rounded-[12px] px-3 text-[13.5px] text-[color:var(--app-accent)] focus:!bg-[color:var(--one-chat-row-active)] focus:!text-[color:var(--app-accent)]"
                        onSelect={() => openCustomCategoryModal(conversation)}
                      >
                        <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                        <span>Custom topic…</span>
                      </DropdownMenuItem>
                      {isCustomCategory ? (
                        <DropdownMenuItem
                          className="h-9 cursor-pointer gap-2 rounded-[12px] px-3 text-[13px] text-muted-foreground focus:!bg-[color:var(--one-chat-row-active)] focus:!text-foreground"
                          onSelect={() => assignCategory(conversation.id, null)}
                        >
                          <span>Automatic category</span>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuSeparator className="my-1 bg-[color:var(--one-chat-divider)]" />
                    </>
                  ) : null}
                  <DropdownMenuItem
                    variant="destructive"
                    // Inherit the row color even when it transitions on focus.
                    className="h-11 cursor-pointer gap-3 rounded-[14px] px-3 pt-0.5 pb-2.5 text-[15px] data-[variant=destructive]:*:[svg]:!text-inherit focus:!bg-[color:var(--one-chat-row-active)] [&_svg]:!size-[18px]"
                    onSelect={() => setDeleteTarget(conversation)}
                  >
                    <Trash2 inheritColor aria-hidden="true" />
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
  const categoryFilterBar =
    chatConversations.length > 0 && categorySummary.ordered.length > 0 ? (
      <div
        data-testid="agent-history-category-bar"
        role="tablist"
        aria-label="Chat categories"
        className={cn(
          "flex min-w-0 w-full items-center gap-1.5 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          isMobileMode ? "px-[var(--page-inline-gutter-standard)]" : "px-3",
        )}
      >
        {["All", ...categorySummary.ordered].map((categoryName) => {
          const selected = effectiveActiveCategory === categoryName;
          const count =
            categoryName === "All"
              ? chatConversations.length
              : (categorySummary.counts.get(categoryName) ?? 0);
          return (
            <button
              key={categoryName}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`agent-history-category-${categoryName.toLowerCase().replace(/\s+/g, "-")}`}
              onClick={() => setActiveCategory(categoryName)}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium leading-none outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/50",
                selected
                  ? "bg-foreground text-background shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-white dark:text-zinc-950"
                  : "border border-[color:var(--one-chat-divider)] bg-transparent text-[color:var(--one-chat-meta)] hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground",
              )}
            >
              <span>{categoryName}</span>
              <span
                className={cn(
                  "text-[10px] tabular-nums",
                  selected ? "opacity-75" : "opacity-60",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    ) : null;

  // Quiet list rows, as in the reference: no pill outline or glass, only a
  // hover fill. The shared control keeps its focus ring and ripple.
  const footerButtonClassName = cn(
    "h-11 min-h-11 w-full rounded-[12px] border-transparent bg-transparent text-[14px] font-medium text-foreground shadow-none hover:bg-[color:var(--one-chat-row-hover)] sm:text-[14px]",
    railMode ? "justify-center px-0 sm:px-0" : "justify-start gap-3 px-3 sm:gap-3 sm:px-3",
    isMobileMode && "text-[13px] sm:text-[13px]",
  );

  return (
    <>
      <aside
        data-one-chat-surface
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-hidden text-foreground",
          // The modal drawer's outer frame owns its inset and material.
          // The persistent desktop column keeps the workspace surface.
          isMobileMode
            ? "bg-[color:var(--one-chat-sidebar)]"
            : "border-r border-[color:var(--one-chat-divider)] bg-[color:var(--one-chat-sidebar)]",
          railMode ? "w-16" : "w-60",
          className
        )}
        aria-label="Agent chat history"
        data-collapsed={collapsed ? "true" : "false"}
        data-agent-history-sidebar={isMobileMode ? "drawer" : "persistent"}
      >
        {isMobileMode ? (
          <div data-stationary-panel-chrome data-agent-history-header data-agent-history-header-layout="aligned" className="flex h-[var(--agent-chat-header-row-height)] shrink-0 items-center gap-3 px-[var(--agent-chat-header-inline-gutter)]">
              {onClose && !hideCloseButton ? (
                <span data-agent-history-close>{closeControl ?? <ShellActionSurface
                  variant="icon" className="size-11 text-foreground" onClick={onClose}
                  aria-label="Close chat history" title="Close chat history"
                ><AnimatedMenuCrossIcon isOpen /></ShellActionSurface>}</span>
              ) : null}
              <div className="flex min-w-0 items-center gap-2">
                <h2 data-agent-history-title className="truncate text-[20px] font-semibold leading-[23px] tracking-[-0.025em] text-foreground">
                  {listTitle}
                </h2>
                {chatConversations.length > 0 ? (
                  <span className="rounded-full bg-[color:var(--one-chat-field)] px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-[color:var(--one-chat-meta)]">
                    {chatConversations.length}
                  </span>
                ) : null}
              </div>
          </div>
        ) : null}
        <SidePanelMotionBody>
        {isMobileMode ? (
          <>
            {showPinnedOneStream ? (
              <div data-agent-history-controls className="px-4 pb-2.5 pt-1">
                <button
                  type="button"
                  data-testid="agent-history-pinned-one"
                  data-state={oneStreamActive ? "active" : undefined}
                  className={cn(
                    "group/one relative isolate flex min-h-11 w-full items-center justify-between gap-3 overflow-hidden rounded-[14px] border px-3.5 py-2 text-left outline-none transition-[background-color,border-color,box-shadow] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60",
                    oneStreamActive
                      ? "border-black/[0.08] bg-white shadow-[0_2px_8px_-2px_rgba(0,0,0,0.07),0_0_0_0.5px_rgba(0,0,0,0.03),inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.12] dark:bg-white/[0.10] dark:shadow-[0_2px_10px_-2px_rgba(0,0,0,0.45),inset_0_0.5px_0_rgba(255,255,255,0.16)]"
                      : "border-black/[0.05] bg-black/[0.025] hover:border-black/[0.09] hover:bg-black/[0.045] dark:border-white/[0.07] dark:bg-white/[0.04] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.07]",
                  )}
                  onClick={() => onSelectOneStream?.()}
                  disabled={disabled}
                  aria-current={oneStreamActive ? "page" : undefined}
                  aria-label={pendingOneActionCount > 0 ? `One (${pendingOneActionCount} waiting)` : "One"}
                >
                  <HusshOneLockup variant="drawer" active={oneStreamActive} className="relative z-10" />
                  <span className="relative z-10 flex shrink-0 items-center gap-2">
                    <span className="text-[12px] font-normal leading-4 text-[color:var(--one-chat-meta)]">
                      Main chat
                    </span>
                    {pendingOneActionCount > 0 ? (
                      <span
                        data-testid="agent-history-pinned-one-badge"
                        className="shrink-0 rounded-full bg-[color:var(--app-accent)] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white"
                      >
                        {pendingOneActionCount}
                      </span>
                    ) : oneStreamActive ? (
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-[color:var(--app-accent)]"
                      />
                    ) : null}
                  </span>
                  <MaterialRipple variant="none" effect="glass" disableHover />
                </button>
              </div>
            ) : null}
            <div data-agent-history-controls className="px-4 pb-1">
              {showPinnedOneStream ? (
                <div
                  data-agent-history-chats-label
                  className="border-t border-[color:var(--one-chat-divider)] px-2 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--one-chat-meta)]"
                >
                  Chats
                </div>
              ) : null}
              {puppyFootnote}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-chat-new-button
                className="flex h-11 w-full items-center justify-start gap-2 rounded-[12px] border-0 bg-transparent px-3 text-[15px] font-medium text-foreground shadow-none transition-[transform,background-color] motion-reduce:transition-none duration-150 hover:bg-[color:var(--one-chat-row-hover)] active:bg-[color:var(--one-chat-row-active)] dark:bg-transparent dark:hover:bg-[color:var(--one-chat-row-hover)]"
                onClick={onCreateNew}
                disabled={createNewDisabled}
                aria-label="Create new chat"
                title="Create new chat"
              >
                <Plus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span data-agent-history-row-title>New chat</span>
              </Button>
            </div>
            <div data-agent-history-controls className="pb-1 pt-1.5">{searchField}</div>
            {categoryFilterBar}
          </>
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
            {showPinnedOneStream ? (
              <button
                type="button"
                data-testid="agent-history-pinned-one"
                data-state={oneStreamActive ? "active" : undefined}
                className={cn(
                  "relative isolate grid h-10 w-10 place-items-center overflow-hidden rounded-[12px] border transition-[background-color,border-color,box-shadow] duration-[180ms] motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60",
                  oneStreamActive
                    ? "border-black/[0.08] bg-white text-[color:var(--app-accent)] shadow-[0_2px_6px_rgba(0,0,0,0.06)] dark:border-white/[0.14] dark:bg-white/[0.12]"
                    : "border-black/[0.05] bg-black/[0.03] text-foreground/80 hover:bg-black/[0.06] hover:text-foreground dark:border-white/[0.08] dark:bg-white/[0.05]",
                )}
                onClick={() => onSelectOneStream?.()}
                disabled={disabled}
                aria-current={oneStreamActive ? "page" : undefined}
                aria-label="Open One"
                title="One"
              >
                <HusshOneLockup variant="rail" active={oneStreamActive} />
                {pendingOneActionCount > 0 ? (
                  <span className="absolute right-1 top-1 size-2 rounded-full bg-[color:var(--app-accent)]" aria-hidden="true" />
                ) : null}
                <MaterialRipple variant="none" effect="glass" disableHover />
              </button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-11 w-11 rounded-xl text-muted-foreground hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
              onClick={onCreateNew}
              disabled={createNewDisabled}
              aria-label="Create new chat"
              title="New chat"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <>
            {showPinnedOneStream ? (
              <div className="shrink-0 px-3 pb-2 pt-[calc(var(--agent-chat-header-safe-top,0px)+0.75rem)]">
                <button
                  type="button"
                  data-testid="agent-history-pinned-one"
                  data-state={oneStreamActive ? "active" : undefined}
                  className={cn(
                    "group/one relative isolate flex min-h-11 w-full items-center justify-between gap-3 overflow-hidden rounded-[14px] border px-3.5 py-2 text-left outline-none transition-[background-color,border-color,box-shadow] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60",
                    oneStreamActive
                      ? "border-black/[0.08] bg-white shadow-[0_2px_8px_-2px_rgba(0,0,0,0.07),0_0_0_0.5px_rgba(0,0,0,0.03),inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.12] dark:bg-white/[0.10] dark:shadow-[0_2px_10px_-2px_rgba(0,0,0,0.45),inset_0_0.5px_0_rgba(255,255,255,0.16)]"
                      : "border-black/[0.05] bg-black/[0.025] hover:border-black/[0.09] hover:bg-black/[0.045] dark:border-white/[0.07] dark:bg-white/[0.04] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.07]",
                  )}
                  onClick={() => onSelectOneStream?.()}
                  disabled={disabled}
                  aria-current={oneStreamActive ? "page" : undefined}
                  aria-label={pendingOneActionCount > 0 ? `One (${pendingOneActionCount} waiting)` : "One"}
                >
                  <HusshOneLockup variant="drawer" active={oneStreamActive} className="relative z-10" />
                  <span className="relative z-10 flex shrink-0 items-center gap-2">
                    <span className="text-[12px] font-normal leading-4 text-[color:var(--one-chat-meta)]">
                      Main chat
                    </span>
                    {pendingOneActionCount > 0 ? (
                      <span
                        data-testid="agent-history-pinned-one-badge"
                        className="shrink-0 rounded-full bg-[color:var(--app-accent)] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white"
                      >
                        {pendingOneActionCount}
                      </span>
                    ) : oneStreamActive ? (
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-[color:var(--app-accent)]"
                      />
                    ) : null}
                  </span>
                  <MaterialRipple variant="none" effect="glass" disableHover />
                </button>
                <div
                  data-agent-history-chats-label
                  className="mt-2.5 border-t border-[color:var(--one-chat-divider)] px-1 pb-0 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--one-chat-meta)]"
                >
                  Chats
                </div>
              </div>
            ) : null}
            {/* Search first, scoped directly to Chats, then New chat beside it. */}
            <div className={cn("flex shrink-0 items-center gap-2 px-3", showPinnedOneStream ? "py-1" : "h-[var(--agent-chat-header-height,4rem)] pt-[var(--agent-chat-header-safe-top,0px)]")}>
              {searchField}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-chat-new-button
                className="h-11 w-11 shrink-0 rounded-full text-muted-foreground hover:bg-[color:var(--one-chat-row-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
                onClick={onCreateNew}
                disabled={createNewDisabled}
                aria-label="Create new chat"
                title="New chat"
              >
                <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              </Button>
            </div>
            {categoryFilterBar}
          </>
        )}

        {!isMobileMode && !railMode && puppyFootnote ? <div className="px-4">{puppyFootnote}</div> : null}

        <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3 pt-0.5 scrollbar-thin scrollbar-thumb-black/10 dark:scrollbar-thumb-white/10 scrollbar-track-transparent", isMobileMode ? "px-[var(--page-inline-gutter-standard)]" : "px-2.5")}>
          {railMode ? <div className="h-2" aria-hidden="true" /> : null}

          {!railMode && surface === "one" ? driveActivity : null}

          {loading ? (
            <div className="space-y-2 py-2" aria-label="Loading chats" role="status">
              <div className="h-10 w-full animate-pulse rounded-[12px] bg-[color:var(--one-chat-field)] motion-reduce:animate-none" />
              <div className="h-10 w-full animate-pulse rounded-[12px] bg-[color:var(--one-chat-field)] motion-reduce:animate-none" />
              <div className="h-10 w-full animate-pulse rounded-[12px] bg-[color:var(--one-chat-field)] motion-reduce:animate-none" />
            </div>
          ) : null}

          {!railMode && !loading && chatConversations.length === 0 ? (
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
                className="mt-3.5 h-11 gap-1.5 rounded-full border-[color:var(--one-chat-divider)] bg-transparent px-3.5 text-xs font-medium hover:bg-[color:var(--one-chat-row-hover)] dark:border-[color:var(--one-chat-divider)] dark:bg-transparent"
                onClick={onCreateNew}
                disabled={createNewDisabled}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Start new chat</span>
              </Button>
            </div>
          ) : null}

          {!railMode &&
          !loading &&
          chatConversations.length > 0 &&
          filteredConversations.length === 0 ? (
            <div className="my-3 flex flex-col items-center justify-center rounded-2xl border border-dashed border-[color:var(--one-chat-divider)] px-4 py-7 text-center">
              <div className="mb-2 grid h-9 w-9 place-items-center rounded-xl bg-[color:var(--one-chat-field)] text-muted-foreground">
                <Search className="h-4 w-4 opacity-70" aria-hidden="true" />
              </div>
              <p className="text-[13px] font-semibold text-foreground/80">No matches found</p>
              <p className="mt-0.5 max-w-[210px] truncate text-[11.5px] text-muted-foreground">
                {searchQuery.trim()
                  ? `No chats match “${searchQuery.trim()}”`
                  : `No chats in ${effectiveActiveCategory}`}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 h-8 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSearchQuery("");
                  setActiveCategory("All");
                }}
              >
                {searchQuery.trim() ? "Clear search" : "Show all chats"}
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
                    data-agent-history-section-label
                    className={cn(
                      "px-3 pb-1 pt-1.5 font-normal text-[color:var(--one-chat-meta)]",
                      isMobileMode ? "text-[12px]" : "text-[13.5px]",
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
            className={cn("shrink-0 space-y-0.5 border-t border-[color:var(--one-chat-divider)] py-2", isMobileMode ? "px-[var(--page-inline-gutter-standard)]" : "px-2.5")}
          >
            {onGetApp ? (
              <ShellActionSurface
                variant="pill"
                type="button"
                wrapperClassName="w-full"
                data-testid="agent-history-get-app"
                className={footerButtonClassName}
                contentClassName={isMobileMode ? "gap-[var(--app-side-pane-row-gap)] sm:gap-[var(--app-side-pane-row-gap)]" : undefined}
                onClick={(event) => onGetApp(event.currentTarget)}
                aria-label="Get the app"
                aria-haspopup="dialog"
                aria-expanded={getAppOpen}
                title={railMode ? "Get the app" : undefined}
                {...shortcutInteraction}
              >
                <DownloadAppIcon className={cn("shrink-0 text-foreground", isMobileMode ? "size-[22px]" : "size-[18px]")} aria-hidden="true" />
                {railMode ? null : <span data-agent-history-row-title className="truncate">Get the app</span>}
              </ShellActionSurface>
            ) : null}
            {onOpenConnectors ? (
              <ShellActionSurface
                variant="pill"
                type="button"
                wrapperClassName="w-full"
                className={footerButtonClassName}
                contentClassName={isMobileMode ? "gap-[var(--app-side-pane-row-gap)] sm:gap-[var(--app-side-pane-row-gap)]" : undefined}
                onClick={(event) => onOpenConnectors(event.currentTarget)}
                aria-label="Open Connectors"
                title={railMode ? "Connectors" : undefined}
              >
                <ConnectorsShortcutIcon className={cn("shrink-0 text-foreground", isMobileMode ? "size-[22px]" : "size-[18px]")} aria-hidden="true" />
                {railMode ? null : <span data-agent-history-row-title className="truncate">Connectors</span>}
              </ShellActionSurface>
            ) : null}
          </div>
        ) : null}
        </SidePanelMotionBody>
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

      <Dialog
        open={Boolean(customCategoryTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setCustomCategoryTarget(null);
            setCustomCategoryDraft("");
          }
        }}
      >
        <DialogContent className="sm:max-w-[360px]" srDescription="Assign a custom category topic to this chat.">
          <DialogHeader>
            <DialogTitle>Custom category</DialogTitle>
            <DialogDescription>
              Organize this conversation under your own topic.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitCustomCategory} className="space-y-4">
            <Input
              value={customCategoryDraft}
              onChange={(event) => setCustomCategoryDraft(event.target.value)}
              placeholder="e.g. Advisory, Travel, Family"
              aria-label="Category name"
              maxLength={32}
              autoFocus
              autoComplete="off"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCustomCategoryTarget(null);
                  setCustomCategoryDraft("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!normalizeCategoryLabel(customCategoryDraft)}
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
