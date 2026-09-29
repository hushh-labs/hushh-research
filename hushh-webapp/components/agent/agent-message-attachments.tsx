"use client";

import { useRef, useState } from "react";

import { ChevronRight, FileText } from "@/components/icons";
import { AgentTextAttachmentViewer } from "@/components/agent/agent-text-attachment-viewer";
import {
  formatTextAttachmentSize,
  type AgentTextAttachment,
} from "@/lib/agent/large-text-attachment";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

/**
 * Pasted text sent with a user turn, shown as a compact chip inside the user
 * bubble. The body never renders in the transcript; opening the chip reads it
 * in the text viewer (a bottom sheet on a phone, a panel beside the chat on a
 * desktop), so a long paste never takes over the conversation.
 */
export function AgentMessageAttachments({
  attachments,
}: {
  attachments?: readonly AgentTextAttachment[];
}) {
  if (!attachments?.length) return null;
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="agent-message-attachments">
      {attachments.map((attachment, index) => (
        <AgentMessageAttachmentChip key={`${attachment.name}-${index}`} attachment={attachment} />
      ))}
    </div>
  );
}

function AgentMessageAttachmentChip({ attachment }: { attachment: AgentTextAttachment }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="w-full min-w-0" data-testid="agent-message-attachment">
      <button
        ref={triggerRef}
        type="button"
        data-text-attachment-trigger=""
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="relative flex min-h-11 w-full min-w-0 items-center gap-2 rounded-2xl border border-white/25 bg-white/15 px-3 py-2 text-left transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{attachment.name}</span>
          <span className="block text-xs opacity-80">{formatTextAttachmentSize(attachment)}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 opacity-80" aria-hidden="true" />
        <MaterialRipple variant="none" effect="glass" />
      </button>
      <AgentTextAttachmentViewer
        open={open}
        onOpenChange={setOpen}
        name={attachment.name}
        text={attachment.text}
        returnFocusRef={triggerRef}
      />
    </div>
  );
}
