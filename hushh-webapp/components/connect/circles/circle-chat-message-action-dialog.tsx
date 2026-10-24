"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ApiError } from "@/lib/services/api-client";
import { MAX_CHAT_TEXT } from "@/lib/circle-chat/crypto";
import { CircleChatService, type ChatMutation, type ChatMutationResult, type CircleChatSession } from "@/lib/services/circle-chat-service";
import type { CircleMessageAction, OpenChatMessage } from "./circle-chat-message";

/** A retry retains the exact sealed mutation; it never allocates a new message key. */
export function CircleChatMessageActionDialog({ session, message, action, messagesLane = false, onClose, onResult, onAccessError, onRestoreFocus }: {
  session: CircleChatSession; message: OpenChatMessage; action: CircleMessageAction;
  messagesLane?: boolean;
  onClose: () => void; onResult: (result: ChatMutationResult) => Promise<void>; onAccessError: (error: unknown) => void;
  onRestoreFocus?: () => void;
}) {
  const [text, setText] = useState(message.content?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const sealed = useRef<ChatMutation | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const edit = action === "edit";
  const close = () => { if (!saving.current) onClose(); };
  const submit = async () => {
    if (saving.current || edit && (!text.trim() || text.trim() === message.content?.text)) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      if (action !== "me") sealed.current ??= await CircleChatService.sealMutation(session, message,
        edit ? { ...message.content!, text: text.trim() } : { text: "This message was deleted.", ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}) });
      if (!active.current) return;
      const result = edit ? await CircleChatService.edit(session, message, sealed.current!)
        : await CircleChatService.delete(session, message, action, sealed.current ?? undefined);
      if (!active.current) return;
      await onResult(result);
      if (active.current) onClose();
    } catch (caught) {
      if (!active.current) return;
      onAccessError(caught);
      setError(caught instanceof ApiError && [404, 409].includes(caught.status)
        ? "This message changed. Close and open it again."
        : "Couldn’t save this change. Check your connection and try again.");
    } finally { saving.current = false; if (active.current) setBusy(false); }
  };
  const feedback = <>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{busy ? <p role="status" className="text-sm text-muted-foreground">{edit ? "Saving…" : "Deleting…"}</p> : null}</>;
  const controls = <>{edit ? <Button variant="outline" className="min-h-11" disabled={busy} onClick={close}>Cancel</Button> : <AlertDialogCancel className="min-h-11" disabled={busy} onClick={close}>Cancel</AlertDialogCancel>}
    <Button className="min-h-11" variant={edit ? "default" : "destructive"} disabled={busy || edit && (!text.trim() || text.trim() === message.content?.text)} onClick={() => void submit()}>{edit ? "Save changes" : "Delete message"}</Button></>;
  if (edit) return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent data-profile-type-scale="circles" data-messages-type-scale={messagesLane || undefined} className="motion-reduce:animate-none" onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus?.(); }} onEscapeKeyDown={(event) => { if (saving.current) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Edit message</DialogTitle><DialogDescription>Update the text. Attachments stay with the message.</DialogDescription></DialogHeader>
      <Textarea aria-label="Edit message text" value={text} maxLength={MAX_CHAT_TEXT} disabled={busy} onChange={(event) => { setText(event.target.value); sealed.current = null; setError(null); }} className="min-h-24" />
      {feedback}<DialogFooter>{controls}</DialogFooter>
    </DialogContent>
  </Dialog>;
  return <AlertDialog open onOpenChange={(open) => { if (!open) close(); }}>
    <AlertDialogContent data-profile-type-scale="circles" data-messages-type-scale={messagesLane || undefined} className="motion-reduce:animate-none" onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus?.(); }} onEscapeKeyDown={(event) => { if (saving.current) event.preventDefault(); }}>
      <AlertDialogHeader><AlertDialogTitle>{action === "everyone" ? "Delete for everyone?" : "Delete for you?"}</AlertDialogTitle>
        <AlertDialogDescription>{action === "everyone" ? "This removes the message from this chat for all members. Members may have already saved a copy." : "This removes the message from your chat. Other members will still see it."}</AlertDialogDescription></AlertDialogHeader>
      {feedback}<AlertDialogFooter>{controls}</AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
