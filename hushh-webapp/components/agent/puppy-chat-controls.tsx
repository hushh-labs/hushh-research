"use client";

import { forwardRef, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Cpu, Send, StopSquare } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { BOTTOM_CHROME_COLUMN_CLASSNAME } from "@/components/app-ui/bottom-chrome-column";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { useAgentDockHost } from "@/components/agent/agent-dock";
import { useNativeDockPort } from "@/components/agent/native-dock-port";

/** Stays above the transcript, directly below the shared app bar. */
export function PuppyControlRibbon({ children, accessory }: {
  children: ReactNode;
  accessory?: ReactNode;
}) {
  return (
    <div role="group" aria-label="Puppy controls" data-puppy-controls
      className={`mx-auto ${BOTTOM_CHROME_COLUMN_CLASSNAME} grid min-h-14 min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] content-center items-start gap-2 border-b border-border/40 py-1`}>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      {accessory ? <div className="contents">{accessory}</div> : null}
    </div>
  );
}

export const PUPPY_MACHINE_LABEL = "This machine";

export const PuppyMachineTrigger = forwardRef<HTMLButtonElement, ComponentProps<typeof ShellActionSurface>>(
  function PuppyMachineTrigger(props, ref) {
    return (
      <ShellActionSurface {...props} ref={ref} type="button" variant="pill"
        title="Resources and scheduled work" className="h-11 px-3 text-xs font-medium sm:px-3 sm:text-sm">
        <Cpu className="size-4 shrink-0" aria-hidden />
        {PUPPY_MACHINE_LABEL}
      </ShellActionSurface>
    );
  },
);

/** Uses One's composer geometry; the existing relay hook retains send authority. */
export function PuppyComposer({ busy, stopping, disabled, onSend, onStop, embedded = false, active = true }: {
  busy: boolean;
  stopping: boolean;
  disabled: boolean;
  onSend: (message: string) => void;
  onStop: () => void;
  embedded?: boolean;
  active?: boolean;
}) {
  const [editorState, setEditorState] = useState({ text: "", revision: 0 });
  const draft = editorState.text;
  const setDraft = (text: string) => setEditorState(previous => ({ text, revision: previous.revision + 1 }));
  const editor = useRef<HTMLTextAreaElement>(null);
  const dockHost = useAgentDockHost();
  useLayoutEffect(() => {
    const field = editor.current;
    if (!field) return;
    field.style.height = "0px";
    const ceiling = Number.parseFloat(getComputedStyle(field).maxHeight);
    field.style.height = `${Math.max(44, Math.min(field.scrollHeight, Number.isFinite(ceiling) ? ceiling : 160))}px`;
  }, [draft, dockHost]);
  const submit = (text = draft) => {
    if (!active || disabled || busy || !text.trim()) return;
    onSend(text);
    setDraft("");
  };
  const context = useId();
  useNativeDockPort("text", embedded && active ? {
    projection: { context: `puppy-relay-${context}`, mode: "text", text: draft,
      placeholder: "Message Puppy One", editorLabel: "Message Puppy",
      expanded: false, editable: !disabled, sendEnabled: !disabled && !busy && !!draft.trim(),
      micEnabled: false, cancelEnabled: busy && !stopping, recording: false, recordingReady: false,
      supportsHold: false, muted: false, attachmentRevision: 0, editorRevision: editorState.revision, attachments: [] },
    // Native edits retain their revision; app/web changes replace the editor.
    onEdit: text => { if (!disabled) setEditorState(previous => ({ ...previous, text })); },
    onAction: event => {
      if (event.action === "cancel" && busy && !stopping) onStop();
      else if (event.action === "send") submit(event.text);
    },
  } : null);
  return (
      <AgentBarSurface embedded={embedded} data-testid="puppy-chat-composer"
        className={`agent-chat-composer-surface agent-chat-composer-compact flex min-w-0 shrink-0 items-end gap-2${embedded ? "" : " mt-3"}`}>
        <textarea ref={editor} value={draft} disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); submit(event.currentTarget.value);
            }
          }}
          rows={1} placeholder="Message Puppy One" aria-label="Message Puppy One"
          className="agent-chat-composer-field min-w-0 flex-1 resize-none overflow-y-auto overscroll-contain border-0 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60 [overflow-wrap:anywhere]"
        />
        <div className="agent-chat-composer-actions flex shrink-0 items-center">
          {busy ? (
            <ShellActionSurface type="button" data-agent-composer-action="stop" onClick={onStop}
              disabled={stopping} aria-label="Stop" title="Stop"
              className="text-[color:var(--app-accent-fg)]">
              <StopSquare className="size-3.5" aria-hidden />
            </ShellActionSurface>
          ) : (
            <ShellActionSurface type="button" data-agent-composer-action="send" onClick={() => submit(editor.current?.value ?? draft)}
              disabled={disabled || !draft.trim()} aria-label="Send to Puppy One" title="Send"
              className="text-[color:var(--app-accent-fg)] disabled:text-muted-foreground">
              <Send className="size-4" aria-hidden />
            </ShellActionSurface>
          )}
        </div>
      </AgentBarSurface>
  );
}
