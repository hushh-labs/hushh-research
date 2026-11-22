"use client";

import {
  useEffect,
  useRef,
  type RefObject,
} from "react";

import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { useCopyConfirmation } from "@/components/agent/chat-markdown-link";
import { useAnimatedStreamText } from "@/components/agent/workspace/use-animated-stream-text";
import { Brain, Check, Copy } from "@/components/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

export type AgentThoughtProcessSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  text: string;
  isStreaming: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

function ThoughtProcessBody({
  text,
  isStreaming,
  scrollerRef,
  titleSlot,
  descriptionSlot,
}: {
  text: string;
  isStreaming: boolean;
  scrollerRef: RefObject<HTMLDivElement | null>;
  titleSlot: React.ReactNode;
  descriptionSlot: React.ReactNode;
}) {
  const animated = useAnimatedStreamText(text, isStreaming);
  const displayedText = animated.displayedText;
  const { copied, copy } = useCopyConfirmation(text);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !isStreaming || !stickToBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [displayedText, isStreaming, scrollerRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--app-card-border-standard)] px-5 py-3.5 pr-14">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full border border-[color:var(--app-card-border-standard)] bg-foreground/[0.04] text-foreground dark:bg-white/[0.06]",
              isStreaming &&
                "border-[color:var(--app-accent)]/30 bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]",
            )}
          >
            <Brain className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {titleSlot}
              {isStreaming ? (
                <span
                  data-testid="agent-thought-streaming-badge"
                  className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--app-accent)]/12 px-2 py-0.5 text-[11px] font-semibold leading-4 text-[color:var(--app-accent)]"
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-[color:var(--app-accent)] motion-safe:animate-pulse"
                  />
                  Live
                </span>
              ) : null}
            </div>
            {descriptionSlot}
          </div>
        </div>
        {text.trim() ? (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? "Thought process copied" : "Copy thought process"}
            title={copied ? "Copied" : "Copy"}
            data-testid="agent-thought-copy"
            className="relative grid size-8 shrink-0 place-items-center rounded-full text-[color:var(--app-secondary-label)] transition-[color,background-color,transform] duration-[140ms] ease-[var(--ease-out)] motion-reduce:transition-none active:scale-[0.96] hover:bg-foreground/[0.05] hover:text-[color:var(--app-label)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
          >
            {copied ? (
              <Check className="size-4 text-[color:var(--app-accent)]" />
            ) : (
              <Copy className="size-4" />
            )}
            <MaterialRipple variant="none" effect="fade" disableHover />
          </button>
        ) : null}
      </div>

      <div
        ref={scrollerRef}
        tabIndex={-1}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 56;
        }}
        data-testid="agent-thought-process-body"
        data-agent-streaming-settle={
          isStreaming || animated.tailSettling ? "true" : undefined
        }
        data-agent-streaming-cursor={isStreaming ? "true" : undefined}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 text-[14px] leading-6 text-foreground/90 outline-none [-webkit-overflow-scrolling:touch]"
      >
        {displayedText.trim() ? (
          <AgentMarkdown
            text={displayedText}
            className="text-[14px] leading-6 text-foreground/90"
          />
        ) : (
          <p className="text-sm text-muted-foreground">Thinking through your request…</p>
        )}
      </div>
    </div>
  );
}

export function AgentThoughtProcessSheet({
  open,
  onOpenChange,
  text,
  isStreaming,
  returnFocusRef,
}: AgentThoughtProcessSheetProps) {
  const isMobile = useIsMobile();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const openedSessionRef = useRef<{
    owner: ReturnType<typeof snapshotValidatedAuthSessionOwner>;
    vaultEpoch: number;
  } | null>(null);

  useEffect(() => {
    if (!open) {
      openedSessionRef.current = null;
      return;
    }
    const owner = snapshotValidatedAuthSessionOwner();
    const vaultEpoch = snapshotVaultSessionEpoch();
    openedSessionRef.current = { owner, vaultEpoch };
    const timer = window.setInterval(() => {
      const snap = openedSessionRef.current;
      if (!snap) return;
      const ownerValid = snap.owner
        ? isValidatedAuthSessionOwnerCurrent(snap.owner)
        : snapshotValidatedAuthSessionOwner() === null;
      if (!ownerValid || !isVaultSessionEpochCurrent(snap.vaultEpoch)) {
        onOpenChange(false);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [onOpenChange, open]);

  const subtitle = isStreaming
    ? "Streaming reasoning for this reply"
    : "Summary shared by the model for this reply";

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} modal>
        <SheetContent
          side="bottom"
          contentDragDismiss={false}
          showDragHandle
          data-testid="agent-thought-process-sheet"
          data-presentation="sheet"
          className="flex max-h-[calc(82dvh-var(--app-safe-area-top-effective,0px)-var(--kb-height,0px))] min-h-[16rem] flex-col gap-0 overflow-hidden p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            scrollerRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef?.current?.focus({ preventScroll: true });
          }}
        >
          <ThoughtProcessBody
            text={text}
            isStreaming={isStreaming}
            scrollerRef={scrollerRef}
            titleSlot={
              <SheetTitle className="truncate text-[15px] font-semibold leading-5 text-foreground">
                Thought process
              </SheetTitle>
            }
            descriptionSlot={
              <SheetDescription className="truncate text-xs leading-4 text-muted-foreground">
                {subtitle}
              </SheetDescription>
            }
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent
        data-testid="agent-thought-process-sheet"
        data-presentation="dialog"
        srDescription={subtitle}
        className="flex max-h-[min(78dvh,42rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          scrollerRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef?.current?.focus({ preventScroll: true });
        }}
      >
        <ThoughtProcessBody
          text={text}
          isStreaming={isStreaming}
          scrollerRef={scrollerRef}
          titleSlot={
            <DialogTitle className="truncate text-[15px] font-semibold leading-5 text-foreground">
              Thought process
            </DialogTitle>
          }
          descriptionSlot={
            <DialogDescription className="truncate text-xs leading-4 text-muted-foreground">
              {subtitle}
            </DialogDescription>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
