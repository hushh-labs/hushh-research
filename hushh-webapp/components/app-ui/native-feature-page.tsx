"use client";

import { useRef, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NativeChatChrome } from "./native-chat-chrome";
import { ShellActionSurface } from "./shell-action-surface";
import { ArrowLeftIcon } from "@/components/icons";

/** App-owned content layer in the existing WebView. The feature owns Back and
 * dismissal; no URL/operation is derived from the rendered DOM. */
export function NativeFeaturePage({ open, title, owner, context, onBack, onReady, children }: {
  open: boolean; title: string; owner: string | null; context: string; onBack: () => void; onReady?: () => void; children: ReactNode;
}) {
  const back = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  return <Dialog open={open} onOpenChange={next => { if (!next) onBack(); }} modal>
    <DialogContent showCloseButton={false} nativeLayer="profile-pane" className="native-feature-page translate-x-0 translate-y-0" overlayClassName="native-feature-page-overlay"
      onOpenAutoFocus={event => {
        event.preventDefault();
        // The destination is prepared beneath its native menu. Focusing the
        // temporary DOM Back would pin that slot to web and prevent admission.
        heading.current?.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={event => event.preventDefault()}
      onEscapeKeyDown={event => { event.preventDefault(); onBack(); }}
      onPointerDownOutside={event => event.preventDefault()}>
      <header className="native-feature-page-header">
        <NativeChatChrome kind="profile-back" label="Back in Profile" owner={owner} context={context} eligible={open}
          focusRef={back} onActivate={onBack} onPresentationReady={onReady} className="flex size-11 shrink-0 items-center justify-center">
          <ShellActionSurface ref={back} aria-label="Back in Profile" onClick={onBack}><ArrowLeftIcon className="size-5" /></ShellActionSurface>
        </NativeChatChrome>
        <DialogTitle ref={heading} tabIndex={-1} className="ui-text-navigation-title truncate">{title}</DialogTitle>
      </header>
      <div className="native-feature-page-body">{children}</div>
    </DialogContent>
  </Dialog>;
}
