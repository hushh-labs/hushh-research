"use client";

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { Loader2, Send } from "@/components/icons";
import { ShellActionSurface } from "./shell-action-surface";

/** Shared text-entry behavior for connection and Circle conversations. */
export function ConversationComposer({ value, onChange, onSend, maxLength, label = "Message", placeholder = "Message…",
  busy = false, locked = false, sendDisabled = false, sendLabel = "Send message", visible = true, leadingAction,
  trailingAction, emptyAction, showSend = true, editorRef }: {
  value: string; onChange: (value: string) => void; onSend: () => void; maxLength: number;
  label?: string; placeholder?: string; busy?: boolean; locked?: boolean; sendDisabled?: boolean;
  sendLabel?: string; visible?: boolean; leadingAction?: ReactNode; trailingAction?: ReactNode;
  emptyAction?: ReactNode; showSend?: boolean; editorRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const internalEditor = useRef<HTMLTextAreaElement>(null);
  const editor = editorRef ?? internalEditor;
  useLayoutEffect(() => {
    if (!editor.current || !visible) return;
    editor.current.style.height = "auto";
    editor.current.style.height = `${Math.min(128, Math.max(44, editor.current.scrollHeight))}px`;
  }, [editor, value, visible]);
  return <form data-conversation-composer className="flex min-w-0 items-end gap-2" onSubmit={(event) => {
    event.preventDefault();
    if (busy || sendDisabled) return;
    editor.current?.focus({ preventScroll: true });
    onSend();
  }}>
    {leadingAction}
    <InputGroup className="min-h-11 min-w-0 flex-1 rounded-3xl bg-background shadow-none">
      <InputGroupTextarea ref={editor} aria-label={label} placeholder={placeholder} value={value} maxLength={maxLength}
        rows={1} readOnly={busy || locked} aria-readonly={busy || locked}
        className="min-h-11 max-h-[max(2.75rem,min(8rem,calc(100dvh-var(--kb-height,0px)-var(--app-safe-area-top-effective,0px)-12rem)))] min-w-0 overflow-y-auto overscroll-contain px-4 py-2.5 text-base leading-6 [overflow-wrap:anywhere] [scroll-margin-bottom:calc(var(--kb-height,0px)+3rem)] md:text-base"
        onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && window.matchMedia("(pointer: fine)").matches) {
            event.preventDefault();
            if (!busy && !sendDisabled) event.currentTarget.form?.requestSubmit();
          }
        }} />
    </InputGroup>
    {trailingAction}
    {showSend ? <ShellActionSurface type="submit" rippleEffect="fill" className="size-11 border-0 bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] shadow-none hover:bg-[color:var(--app-accent-hover)] hover:text-[color:var(--app-accent-fg)]"
      aria-label={sendLabel} disabled={busy || sendDisabled}>
      {busy ? <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" /> : <Send aria-hidden="true" className="size-5" />}
    </ShellActionSurface> : emptyAction}
  </form>;
}
