"use client";

import * as React from "react";
import { NativeChatChrome } from "./native-chat-chrome";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { ShellActionSurfaceBase, type ShellActionSurfaceProps } from "./shell-action-surface-base";
export { SHELL_ICON_BUTTON_CLASSNAME, SHELL_PILL_TRIGGER_CLASSNAME } from "./shell-action-surface-base";

type NativeMapAction = { kind: "map-close" | "map-locate" | "map-check-in"; owner: string | null; context: string; label: string; value?: "idle" | "active"; onActivate: () => void };

/** Semantic platform adapter. Moving controls and ordinary callers keep the
 * renderer-neutral primitive; native operations always use an authored port. */
export const ShellActionSurface = React.forwardRef<HTMLButtonElement, ShellActionSurfaceProps & { nativeAction?: NativeMapAction }>(
  function ShellActionSurface({ nativeAction, ...props }, ref) {
    const button = React.useRef<HTMLButtonElement>(null);
    React.useImperativeHandle(ref, () => button.current!, []);
    const [native] = React.useState(() => customNativePresentationEnabled());
    const surface = <ShellActionSurfaceBase {...props} ref={button} />;
    if (!native || !nativeAction) return surface;
    const shared = { owner: nativeAction.owner, context: nativeAction.context, eligible: true, enabled: !props.disabled, focusRef: button,
      label: nativeAction.label, onActivate: nativeAction.onActivate, className: "relative inline-flex shrink-0 pointer-events-auto" };
    const bounded = <span className={nativeAction.kind === "map-check-in" ? "inline-flex h-11 w-[112px] items-center justify-center" : "inline-flex size-14 items-center justify-center"}>{surface}</span>;
    if (nativeAction.kind === "map-check-in") return <NativeChatChrome {...shared} kind="map-check-in" value={nativeAction.value ?? "idle"}>{bounded}</NativeChatChrome>;
    if (nativeAction.kind === "map-close") return <NativeChatChrome {...shared} kind="map-close">{bounded}</NativeChatChrome>;
    return <NativeChatChrome {...shared} kind="map-locate">{bounded}</NativeChatChrome>;
  },
);
