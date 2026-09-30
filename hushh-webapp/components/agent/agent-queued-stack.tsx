"use client";

import { Check, Pencil, Trash2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { QueuedAgentPrompt } from "@/lib/agent/agent-chat-prompt-queue";
import { cn } from "@/lib/utils";

/**
 * Messages the person sent while One was working, above the composer.
 *
 * Grid: 8 pt outer padding and row rhythm, 4 pt between rows. A row is 40 pt
 * tall and its 32 pt actions sit 4 pt from the right edge, so the glyph lands
 * 12 pt from the edge, mirroring the 12 pt text inset on the left. The stack
 * lives inside the composer's own width box, so its side insets are the
 * composer's by construction.
 */
export function AgentQueuedStack({
  prompts,
  editingId,
  editingText,
  onEditStart,
  onEditChange,
  onEditSave,
  onEditCancel,
  onRemove,
}: {
  prompts: readonly QueuedAgentPrompt[];
  editingId: string | null;
  editingText: string;
  onEditStart: (prompt: QueuedAgentPrompt) => void;
  onEditChange: (text: string) => void;
  onEditSave: (id: string) => void;
  onEditCancel: () => void;
  onRemove: (id: string) => void;
}) {
  if (prompts.length === 0) return null;
  const joining = prompts.some((prompt) => prompt.placement === "joining");
  return (
    <section
      data-testid="agent-chat-prompt-queue"
      aria-label="Queued messages"
      aria-live="polite"
      className="mb-2 rounded-[20px] bg-foreground/[0.045] p-2"
    >
      <header
        data-testid="agent-chat-prompt-queue-header"
        className="flex h-6 items-center justify-between gap-3 px-2 text-[12px] font-medium leading-4 text-muted-foreground"
      >
        <span className="tabular-nums">{prompts.length} queued</span>
        <span className="min-w-0 truncate">
          {joining ? "One reads these at its next step" : "Sends when this reply ends"}
        </span>
      </header>
      <ol className="mt-1 flex flex-col gap-1">
        {prompts.map((prompt, index) => {
          const editing = editingId === prompt.id;
          const label = prompt.text || prompt.attachments?.[0]?.name || "Message";
          return (
            <li
              key={prompt.id}
              data-testid="agent-chat-queued-row"
              data-placement={prompt.placement ?? "waiting"}
              className="motion-step-enter flex min-h-10 min-w-0 items-center gap-2 rounded-[12px] bg-background/80 pl-3 pr-1"
            >
              <span
                aria-hidden="true"
                data-testid="agent-chat-queued-marker"
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-[var(--motion-duration-md)]",
                  prompt.placement === "joining"
                    ? "bg-[color:var(--app-accent)]"
                    : "bg-foreground/25",
                )}
              />
              {editing ? (
                <input
                  autoFocus
                  aria-label={`Edit queued message ${index + 1}`}
                  className="h-8 min-w-0 flex-1 bg-transparent text-[14px] leading-5 text-foreground outline-none"
                  value={editingText}
                  onChange={(event) => onEditChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      onEditSave(prompt.id);
                    }
                    if (event.key === "Escape") onEditCancel();
                  }}
                />
              ) : (
                <span
                  data-testid="agent-chat-queued-text"
                  className="min-w-0 flex-1 truncate text-[14px] leading-5 text-foreground"
                >
                  {label}
                </span>
              )}
              {!editing && prompt.text && prompt.attachments?.[0] ? (
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {prompt.attachments[0].name}
                </span>
              ) : null}
              {!editing && prompt.driveSearchSelection ? (
                <span className="shrink-0 text-[12px] text-muted-foreground">Drive file</span>
              ) : null}
              <span className="flex shrink-0 items-center">
                {editing ? (
                  <>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 rounded-full"
                      aria-label={`Save queued message ${index + 1}`}
                      onClick={() => onEditSave(prompt.id)}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 rounded-full text-muted-foreground"
                      aria-label="Cancel editing"
                      onClick={onEditCancel}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    {prompt.text ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                        aria-label={`Edit queued message ${index + 1}`}
                        onClick={() => onEditStart(prompt)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 rounded-full text-muted-foreground hover:text-destructive"
                      aria-label={`Remove queued message ${index + 1}`}
                      onClick={() => onRemove(prompt.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Under a message that joined One's running reply: where it landed. */
export function QueuedJoinedCaption() {
  return (
    <p
      data-testid="agent-message-queued-joined"
      className="mt-1 px-1 text-right text-[11px] font-medium leading-4 text-muted-foreground"
    >
      Joined this reply
    </p>
  );
}
