"use client";

import { forwardRef, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Cpu, Send, StopSquare } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { BOTTOM_CHROME_COLUMN_CLASSNAME } from "@/components/app-ui/bottom-chrome-column";

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
export function PuppyComposer({ busy, stopping, disabled, onSend, onStop }: {
  busy: boolean;
  stopping: boolean;
  disabled: boolean;
  onSend: (message: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = editor.current;
    if (!field) return;
    field.style.height = "0px";
    const ceiling = Number.parseFloat(getComputedStyle(field).maxHeight);
    field.style.height = `${Math.max(44, Math.min(field.scrollHeight, Number.isFinite(ceiling) ? ceiling : 160))}px`;
  }, [draft]);
  const submit = () => {
    if (disabled || busy || !draft.trim()) return;
    onSend(draft);
    setDraft("");
  };
  return (
    <div className="shrink-0 pt-3">
      <div data-testid="puppy-chat-composer"
        className="bottom-chrome-surface agent-chat-composer-surface agent-chat-composer-compact flex min-w-0 items-end gap-2">
        <textarea ref={editor} value={draft} disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); submit();
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
            <ShellActionSurface type="button" data-agent-composer-action="send" onClick={submit}
              disabled={disabled || !draft.trim()} aria-label="Send to Puppy One" title="Send"
              className="text-[color:var(--app-accent-fg)] disabled:text-muted-foreground">
              <Send className="size-4" aria-hidden />
            </ShellActionSurface>
          )}
        </div>
      </div>
    </div>
  );
}
