"use client";

import { useRef, type ComponentProps, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NativeChatChrome } from "./native-chat-chrome";
import { ShellActionSurface } from "./shell-action-surface";
import { ArrowLeftIcon } from "@/components/icons";

export type NativeFeatureLayer = "profile-pane" | "chat-attachment" | "chat-drive-review";
type ContentEvents = Pick<ComponentProps<typeof DialogContent>, "onOpenAutoFocus" | "onCloseAutoFocus" | "onEscapeKeyDown" | "onKeyDown">;

/** Reuse the v2 bounded Back lease (its profile-back ID is a compatibility
 * identifier). The feature supplies the layer and callback; native never
 * derives an operation or route from the title, body or rendered DOM. */
export function NativeFeatureBack({ owner, context, layer, label = "Back to Chat", onBack, onReady }: {
  owner: string | null; context: string; layer: NativeFeatureLayer; label?: string;
  onBack: () => void; onReady?: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  return <NativeChatChrome kind="profile-back" label={label} owner={owner} context={context} eligible
    interactionLayer={layer} focusRef={back} onActivate={onBack} onPresentationReady={onReady}
    className="flex size-11 shrink-0 items-center justify-center">
    <ShellActionSurface ref={back} aria-label={label} onClick={onBack}><ArrowLeftIcon className="size-5" /></ShellActionSurface>
  </NativeChatChrome>;
}

/** App-owned content layer in the existing WebView. The feature owns Back and
 * dismissal; no URL/operation is derived from the rendered DOM. */
export function NativeFeaturePage({ open, title, owner, context, onBack, onReady, children, layer = "profile-pane", authoredHeader = false,
  bodyClassName, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onKeyDown, ...attributes }: {
  open: boolean; title: string; owner: string | null; context: string; onBack: () => void; onReady?: () => void; children: ReactNode;
  layer?: NativeFeatureLayer;
  /** Rich editors keep their existing Title/Cancel/Done row, not a second header. */
  authoredHeader?: boolean;
  bodyClassName?: string;
  "data-testid"?: string;
  "data-presentation"?: string;
} & ContentEvents) {
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  return <Dialog open={open} onOpenChange={next => { if (!next) onBack(); }} modal>
    <DialogContent {...attributes} ref={content} tabIndex={-1} showCloseButton={false} nativeLayer={layer} className="native-feature-page translate-x-0 translate-y-0" overlayClassName="native-feature-page-overlay"
      onOpenAutoFocus={event => {
        event.preventDefault();
        // The destination is prepared beneath its native menu. Focusing the
        // temporary DOM Back would pin that slot to web and prevent admission.
        if (onOpenAutoFocus) onOpenAutoFocus(event);
        else (heading.current ?? content.current)?.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={event => { event.preventDefault(); onCloseAutoFocus?.(event); }}
      onEscapeKeyDown={event => {
        onEscapeKeyDown?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault(); onBack();
      }}
      onKeyDown={onKeyDown}
      onPointerDownOutside={event => event.preventDefault()}>
      {!authoredHeader && <header className="native-feature-page-header">
        <NativeFeatureBack owner={owner} context={context} layer={layer} label={layer === "profile-pane" ? "Back in Profile" : "Back to Chat"}
          onBack={onBack} onReady={onReady} />
        <DialogTitle ref={heading} tabIndex={-1} className="ui-text-navigation-title min-w-0 flex-1 whitespace-normal break-words">{title}</DialogTitle>
      </header>}
      <div data-native-feature-scroll-root="true" className={bodyClassName ? `native-feature-page-body ${bodyClassName}` : "native-feature-page-body"}>{children}</div>
    </DialogContent>
  </Dialog>;
}
