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
  collapsed: boolean;
  loading?: boolean;
  disabled?: boolean;
  actionPendingId?: string | null;
  className?: string;
  onToggleCollapsed: () => void;
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
  collapsed,
  loading = false,
  disabled = false,
  actionPendingId,
  className,
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
          "flex shrink-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm transition-[width] duration-200 ease-out",
          collapsed ? "w-full lg:w-14" : "w-full lg:w-72",
          className
        )}
        aria-label="Agent chat history"
      >
        <div
          className={cn(
            "flex items-center gap-2 border-b border-border/70 p-2",
            collapsed && "lg:flex-col"
          )}
        >
          <Button
            type="button"
            variant="secondary"
            className={cn(
              "min-w-0",
              collapsed ? "h-9 w-9 px-0" : "flex-1 justify-start px-3"
            )}
            onClick={onCreateNew}
            disabled={disabled}
            aria-label="Create new Agent chat"
            title="Create new chat"
          >
            <Plus className="h-4 w-4" />
            {!collapsed ? <span className="truncate">Create New Chat</span> : null}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand chat history" : "Collapse chat history"}
            title={collapsed ? "Expand chat history" : "Collapse chat history"}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-2",
            collapsed && "max-lg:flex max-lg:gap-1 max-lg:overflow-x-auto"
          )}
        >
          {loading ? (
            <div
              className={cn(
                "rounded-md bg-muted/40",
                collapsed ? "h-9 w-9 shrink-0" : "h-10 w-full"
              )}
            />
          ) : null}

          {!loading && conversations.length === 0 ? (
            <div
              className={cn(
                "grid place-items-center rounded-md border border-dashed border-border/70 text-center text-xs text-muted-foreground",
                collapsed ? "h-9 w-9 shrink-0" : "min-h-24 px-3"
              )}
            >
              {collapsed ? <MessageSquare className="h-4 w-4" /> : "No chats yet"}
            </div>
          ) : null}

          <div className={cn("space-y-1", collapsed && "max-lg:flex max-lg:space-y-0")}>
            {conversations.map((conversation) => {
              const title = conversationLabel(conversation);
              const active = conversation.id === activeConversationId;
              const pending = actionPendingId === conversation.id;
              const isRenaming = renamingId === conversation.id;

              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group rounded-md transition-colors",
                    active && "bg-primary/10 text-primary",
                    !active && "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  {isRenaming && !collapsed ? (
                    <form
                      onSubmit={submitRename}
                      className="flex items-center gap-1 rounded-md bg-background p-1"
                    >
                      <Input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        className="h-8 min-w-0 flex-1 text-sm"
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
                          "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                          collapsed && "w-9 flex-none justify-center px-0"
                        )}
                        onClick={() => onSelectConversation(conversation.id)}
                        disabled={disabled || pending}
                        aria-current={active ? "page" : undefined}
                        title={title}
                      >
                        <MessageSquare className="h-4 w-4 shrink-0" />
                        {!collapsed ? <span className="truncate">{title}</span> : null}
                      </button>
                      {!collapsed ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="mr-1 opacity-70 transition-opacity group-hover:opacity-100"
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
                      ) : null}
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
