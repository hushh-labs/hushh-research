"use client";

import { useRef } from "react";
import { Plus } from "@/components/icons";
import { NativeChatChrome } from "./native-chat-chrome";
import { ShellActionSurface } from "./shell-action-surface";

/** Authored stationary Add affordance. The existing callback owns the action;
 * this adapter only chooses the platform control and confirms its binding.
 * Callers must reserve this slot in stationary shell chrome, not a scroller. */
export function NativeAddAction({ owner, context, label, enabled, onActivate, onPresentationReady }: {
  owner: string | null; context: string; label: string; enabled: boolean;
  onActivate: () => void; onPresentationReady?: () => void;
}) {
  const focus = useRef<HTMLButtonElement | null>(null);
  return <NativeChatChrome kind="add" label={label} owner={owner} context={context} eligible={enabled}
    className="h-11 w-11 shrink-0" focusRef={focus} onActivate={onActivate} onPresentationReady={onPresentationReady}>
    <ShellActionSurface ref={focus} type="button" variant="icon" aria-label={label} disabled={!enabled}
      onClick={onActivate} className="!h-11 !w-11">
      <Plus aria-hidden="true" className="size-5" />
    </ShellActionSurface>
  </NativeChatChrome>;
}
