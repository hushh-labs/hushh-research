"use client";

/**
 * "Take One with you": the history sidebar's Get the app prompt.
 *
 * Desktop shows a floating card above the sidebar footer; smaller screens get
 * a bottom sheet. Either is a modal dialog (focus contained, Escape and an
 * outside press close it, focus returns to the control that opened it) and
 * neither touches the conversation behind it. Nothing navigates until a store
 * link is chosen, and only published listings from `OFFICIAL_APP_LINKS` are
 * ever offered.
 */
import { useMemo, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Smartphone, XIcon as X } from "@/components/icons";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  OFFICIAL_APP_LINKS,
  appDownloadPlatform,
  appDownloadTargets,
  type AppDownloadTarget,
} from "@/lib/app-download/official-app-links";
import { HushhMark } from "@/lib/morphy-ux/ui/hushh-mark";
import { cn } from "@/lib/utils";

export const GET_APP_TITLE = "Take One with you";
export const GET_APP_DESCRIPTION =
  "Download Hussh One for iOS or Android and pick up where you left off.";

/** A small, theme-aware phone showing One's own chat, not a screenshot. */
function OnePhonePreview() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto h-[9.5rem] w-full overflow-hidden rounded-[20px] bg-[color:var(--one-chat-get-app-stage)]"
    >
      <div className="absolute left-1/2 top-4 w-[11.5rem] -translate-x-1/2 rounded-t-[26px] border-[5px] border-b-0 border-[color:var(--one-chat-get-app-bezel)] bg-[color:var(--one-chat-canvas)] px-3 pb-3 pt-2 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.45)]">
        <div className="flex items-center justify-between text-[8px] font-semibold tabular-nums text-foreground/80">
          <span>9:41</span>
          <span className="h-1.5 w-6 rounded-full bg-foreground/25" />
        </div>
        <div className="mt-2 flex flex-col items-center gap-0.5">
          <HushhMark aria-hidden="true" className="h-[18px] w-[18px]" />
          <span className="text-[9px] font-semibold text-foreground">One</span>
        </div>
        <div className="mt-2.5 space-y-1.5">
          <div className="w-[82%] rounded-[10px] rounded-bl-[4px] bg-[color:var(--one-chat-bubble)] px-2 py-1.5">
            <div className="h-1 w-full rounded-full bg-foreground/25" />
            <div className="mt-1 h-1 w-3/4 rounded-full bg-foreground/25" />
          </div>
          <div className="ml-auto w-[58%] rounded-[10px] rounded-br-[4px] bg-[color:var(--app-accent)] px-2 py-1.5">
            <div className="h-1 w-full rounded-full bg-white/70" />
          </div>
        </div>
      </div>
    </div>
  );
}

function GetAppBody({
  targets,
  titleSlot,
  descriptionSlot,
}: {
  targets: AppDownloadTarget[];
  titleSlot: ReactNode;
  descriptionSlot: ReactNode;
}) {
  return (
    <>
      <OnePhonePreview />
      <div className="px-1 pt-4">
        {titleSlot}
        {descriptionSlot}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {targets.length ? (
          targets.map((target) => (
            <a
              key={target.store}
              href={target.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`agent-get-app-link-${target.store}`}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] px-4 text-[15px] font-medium text-[color:var(--app-accent-fg)] transition-colors hover:bg-[color:var(--app-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
            >
              <Smartphone className="h-4 w-4" aria-hidden="true" />
              {targets.length > 1 ? `Get it on ${target.label}` : "Get the app"}
            </a>
          ))
        ) : (
          <>
            <button
              type="button"
              disabled
              aria-describedby="agent-get-app-unavailable"
              data-testid="agent-get-app-cta"
              className="inline-flex min-h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-full bg-[color:var(--one-chat-field-strong)] px-4 text-[15px] font-medium text-foreground/45"
            >
              <Smartphone className="h-4 w-4" aria-hidden="true" />
              Get the app
            </button>
            <p
              id="agent-get-app-unavailable"
              className="text-center text-[12px] text-[color:var(--one-chat-meta)]"
            >
              Store links aren&apos;t available yet.
            </p>
          </>
        )}
      </div>
    </>
  );
}

export function AgentGetAppPrompt({
  open,
  onOpenChange,
  presentation,
  anchorRect,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `card` floats above the desktop sidebar footer; `sheet` rises from the bottom. */
  presentation: "card" | "sheet";
  /** The opening control's rect, so the card sits just above it. */
  anchorRect?: DOMRect | null;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const targets = useMemo(
    () =>
      appDownloadTargets(
        OFFICIAL_APP_LINKS,
        typeof navigator === "undefined" ? "other" : appDownloadPlatform(navigator.userAgent),
      ),
    [],
  );
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    const target = returnFocusRef.current;
    if (target?.isConnected && !target.closest("[inert], [hidden]")) {
      target.focus({ preventScroll: true });
    }
  };

  if (presentation === "sheet") {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          data-one-chat-surface
          data-testid="agent-get-app-sheet"
          onCloseAutoFocus={restoreFocus}
          className="gap-0 px-5 pb-[calc(1.25rem+var(--app-safe-area-bottom-effective,0px))] pt-2 sm:mx-auto sm:max-w-md"
        >
          <GetAppBody
            targets={targets}
            titleSlot={
              <SheetTitle className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">
                {GET_APP_TITLE}
              </SheetTitle>
            }
            descriptionSlot={
              <SheetDescription className="mt-1 text-[15px] leading-6 text-[color:var(--one-chat-meta)]">
                {GET_APP_DESCRIPTION}
              </SheetDescription>
            }
          />
        </SheetContent>
      </Sheet>
    );
  }

  // Just above the control that opened it, inside the viewport.
  const style: CSSProperties = anchorRect
    ? {
        left: Math.max(12, Math.round(anchorRect.left)),
        bottom: Math.max(12, Math.round(window.innerHeight - anchorRect.top + 10)),
      }
    : { left: 12, bottom: 12 };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-one-chat-surface
          data-testid="agent-get-app-card"
          onCloseAutoFocus={restoreFocus}
          style={style}
          className={cn(
            "fixed z-(--z-sheet) w-[min(21rem,calc(100vw-1.5rem))] rounded-[28px] bg-[color:var(--one-chat-raised)] p-3 pb-4 text-foreground",
            "border border-[color:var(--one-chat-divider)] shadow-[0_28px_70px_-28px_rgba(0,0,0,0.45),0_2px_10px_rgba(0,0,0,0.06)] outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            "origin-bottom-left duration-150 motion-reduce:animate-none",
          )}
        >
          <GetAppBody
            targets={targets}
            titleSlot={
              <DialogPrimitive.Title className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">
                {GET_APP_TITLE}
              </DialogPrimitive.Title>
            }
            descriptionSlot={
              <DialogPrimitive.Description className="mt-1 text-[15px] leading-6 text-[color:var(--one-chat-meta)]">
                {GET_APP_DESCRIPTION}
              </DialogPrimitive.Description>
            }
          />
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-5 top-5 grid size-9 place-items-center rounded-full bg-[color:var(--one-chat-raised)]/90 text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.12)] backdrop-blur transition-colors after:absolute after:-inset-1 hover:bg-[color:var(--one-chat-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
