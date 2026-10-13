"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useNativeContentPane } from "@/lib/capacitor/use-native-content-pane";
import type { NativeContentPaneIdentity } from "@/lib/capacitor/native-chrome";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NativeChatChrome } from "./native-chat-chrome";
import { ShellActionSurface } from "./shell-action-surface";
import { ArrowLeftIcon, X } from "@/components/icons";

export type NativeFeatureLayer = "profile-pane" | "chat-attachment" | "chat-drive-review";
type ContentEvents = Pick<ComponentProps<typeof DialogContent>, "onOpenAutoFocus" | "onCloseAutoFocus" | "onEscapeKeyDown" | "onKeyDown">;

/** Reuse the v2 bounded Back lease (its profile-back ID is a compatibility
 * identifier). The feature supplies the layer and callback; native never
 * derives an operation or route from the title, body or rendered DOM. */
export function NativeFeatureBack({ owner, context, layer, label = "Back to Chat", onBack, onReady, contentPane, eligible = true }: {
  owner: string | null; context: string; layer: NativeFeatureLayer; label?: string;
  onBack: () => void; onReady?: () => void;
  contentPane?: NativeContentPaneIdentity; eligible?: boolean;
}) {
  const back = useRef<HTMLButtonElement>(null);
  return <NativeChatChrome kind="profile-back" label={label} owner={owner} context={context} eligible={eligible} contentPane={contentPane}
    interactionLayer={layer} focusRef={back} onActivate={onBack} onPresentationReady={onReady}
    className="flex size-11 shrink-0 items-center justify-center">
    <ShellActionSurface ref={back} aria-label={label} onClick={onBack}><ArrowLeftIcon className="size-5" /></ShellActionSurface>
  </NativeChatChrome>;
}

/** App-owned content layer in the existing WebView. The feature owns Back and
 * dismissal; no URL/operation is derived from the rendered DOM. */
export function NativeFeaturePage({ open, title, owner, context, onBack, onReady, children, layer = "profile-pane", authoredHeader = false,
  bodyClassName, pane = false, onClose, backLabel, closeLabel = "Close Profile", onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onKeyDown, ...attributes }: {
  open: boolean; title: string; owner: string | null; context: string; onBack: () => void; onReady?: () => void; children: ReactNode;
  layer?: NativeFeatureLayer;
  /** Rich editors keep their existing Title/Cancel/Done row, not a second header. */
  authoredHeader?: boolean;
  bodyClassName?: string;
  /** Keep nested Profile content in the same full-height pane geometry. */
  pane?: boolean;
  onClose?: () => void;
  backLabel?: string;
  closeLabel?: string;
  "data-testid"?: string;
  "data-presentation"?: string;
} & ContentEvents) {
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const paneState = useNativeContentPane(node, owner, pane);
  const [readyControls, setReadyControls] = useState({ context: "", back: false, close: false });
  const readinessContext = JSON.stringify([context, paneState.identity]);
  const ready = !pane || paneState.phase === "web" || paneState.phase === "native" &&
    readyControls.context === readinessContext && readyControls.back && (!onClose || readyControls.close);
  const bindContent = useCallback((next: HTMLDivElement | null) => { content.current = next; setNode(next); }, []);
  const controlReady = (kind: "back" | "close") => setReadyControls(previous => ({
    context: readinessContext, back: previous.context === readinessContext && previous.back || kind === "back",
    close: previous.context === readinessContext && previous.close || kind === "close",
  }));
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady;
  useLayoutEffect(() => { if (pane && open && ready) onReadyRef.current?.(); }, [pane, open, ready, readinessContext]);
  return <Dialog open={open} onOpenChange={next => { if (!next) onBack(); }} modal>
    <DialogContent {...attributes} aria-label={pane ? "Profile pane" : undefined} data-native-feature-pane={pane && paneState.phase !== "web" ? "profile" : undefined}
      data-native-pane-ready={ready} style={ready ? undefined : { visibility: "hidden" }} ref={bindContent} tabIndex={-1} showCloseButton={false} nativeLayer={layer} className="native-feature-page translate-x-0 translate-y-0" overlayClassName={pane ? "native-feature-page-overlay native-feature-pane-overlay" : "native-feature-page-overlay"}
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
        <NativeFeatureBack owner={owner} context={context} layer={layer} label={backLabel ?? (layer === "profile-pane" ? "Back in Profile" : "Back to Chat")}
          contentPane={paneState.identity} eligible={!pane || paneState.phase === "native"}
          onBack={onBack} onReady={pane ? () => controlReady("back") : onReady} />
        <DialogTitle ref={heading} tabIndex={-1} className="ui-text-navigation-title min-w-0 flex-1 whitespace-normal break-words">{title}</DialogTitle>
        {onClose ? <NativeChatChrome kind="close" label={closeLabel} owner={owner} context={context} eligible={paneState.phase === "native"}
          contentPane={paneState.identity} onPresentationReady={() => controlReady("close")}
          interactionLayer={layer} focusRef={close} onActivate={onClose} className="flex size-11 shrink-0 items-center justify-center">
          <ShellActionSurface ref={close} aria-label={closeLabel} onClick={onClose} className="!size-11"><X className="size-5" /></ShellActionSurface>
        </NativeChatChrome> : null}
      </header>}
      <div data-native-feature-scroll-root="true" className={bodyClassName ? `native-feature-page-body ${bodyClassName}` : "native-feature-page-body"}>{children}</div>
    </DialogContent>
  </Dialog>;
}
