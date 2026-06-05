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

  const renamingConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === renamingId) || null,
    [conversations, renamingId]
  );

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

  return (
    <>
      <aside
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-white/10 bg-[#101216] text-zinc-200 transition-[width] duration-200 ease-out",
          collapsed ? "w-16" : "w-72",
          className
        )}
        aria-label="Agent chat history"
        data-collapsed={collapsed ? "true" : "false"}
      >
        <div className="flex items-center gap-2 border-b border-white/10 p-3">
          {collapsed ? (
            <div className="flex w-full flex-col items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-lg border border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-primary/60"
                onClick={onToggleCollapsed}
                aria-label="Expand chat history"
                title="Expand chat history"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-lg text-zinc-300 hover:bg-white/[0.07] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-primary/60"
                onClick={onCreateNew}
                disabled={disabled}
                aria-label="Create new Agent chat"
                title="New chat"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                className="h-11 min-w-0 flex-1 justify-start gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm font-medium text-zinc-100 shadow-sm transition-colors hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-primary/60"
                onClick={onCreateNew}
                disabled={disabled}
                aria-label="Create new Agent chat"
                title="Create new chat"
              >
                <Plus className="h-4 w-4" />
                <span className="truncate">New chat</span>
              </Button>
              {onToggleCollapsed ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="hidden h-10 w-10 rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-primary/60 lg:inline-flex"
                  onClick={onToggleCollapsed}
                  aria-label="Collapse chat history"
                  title="Collapse chat history"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </Button>
              ) : null}
            </>
          )}
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 lg:hidden"
              onClick={onClose}
              aria-label="Close chat history"
              title="Close chat history"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent">
          {collapsed ? (
            <div className="h-4" aria-hidden="true" />
          ) : (
            <div className="px-2 pb-2 pt-1 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
              Chats
            </div>
          )}
          {loading ? (
            <div className="h-10 w-full rounded-lg bg-white/[0.05]" />
          ) : null}

          {!collapsed && !loading && conversations.length === 0 ? (
            <div className="grid min-h-24 place-items-center rounded-lg border border-dashed border-white/10 px-3 text-center text-xs text-zinc-500">
              No chats yet
            </div>
          ) : null}

          <div className="space-y-1">
            {conversations.map((conversation) => {
              const title = conversationLabel(conversation);
              const active = conversation.id === activeConversationId;
              const pending = actionPendingId === conversation.id;
              const isRenaming = renamingId === conversation.id;

              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group rounded-lg transition-colors",
                    active && "bg-primary/15 text-zinc-50 ring-1 ring-primary/20",
                    !active && "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
                  )}
                >
                  {isRenaming ? (
                    <form
                      onSubmit={submitRename}
                      className="flex items-center gap-1 rounded-lg bg-[#151820] p-1"
                    >
                      <Input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        className="h-8 min-w-0 flex-1 border-white/10 bg-black/20 text-sm text-zinc-100"
                        maxLength={160}
                        autoFocus
                        disabled={pending}
                        aria-label="Rename chat"
                      />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="icon-xs"
                        disabled={pending || !normalizeTitle(renameValue)}
                        aria-label="Save chat name"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={cancelRename}
                        disabled={pending}
                        aria-label="Cancel rename"
                      >
                        <X className="h-3.5 w-3.5" />
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
                        <MessageSquare className="h-4 w-4 shrink-0 opacity-75" />
                        {collapsed ? null : <span className="truncate">{title}</span>}
                      </button>
                      {collapsed ? null : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="mr-1 text-zinc-500 opacity-0 transition-opacity hover:bg-white/[0.07] hover:text-zinc-100 group-hover:opacity-100 focus-visible:opacity-100"
                              disabled={disabled || pending}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => event.stopPropagation()}
                              aria-label={`Open actions for ${title}`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" sideOffset={6} className="z-[520]">
                            <DropdownMenuItem onSelect={() => startRename(conversation)}>
                              <Pencil className="h-4 w-4" />
                              Rename chat
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setDeleteTarget(conversation)}
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete chat
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
