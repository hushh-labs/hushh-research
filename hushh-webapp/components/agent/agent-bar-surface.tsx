"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BOTTOM_CHROME_COLUMN_CLASSNAME } from "@/components/app-ui/bottom-chrome-column";
import { cn } from "@/lib/utils";
import { useAgentDockSurface } from "./agent-dock";
import { useNativeDockPorts } from "./native-dock-port";

type VoiceSeat = { host: HTMLDivElement | null; press: { current: ComponentPropsWithRef<"div">["onPointerDown"] } };
const VoiceSeatContext = createContext<VoiceSeat | undefined>(undefined);

/** The shell owns the presentation lifetime; changing the voice backend must
 * not replace Chat's portal target, textarea, selection or undo history. Voice
 * owners project only their controls here, and retain their own panels/actions. */
export function RetainedAgentBar({ children }: { children: ReactNode }) {
  const [seat, setSeat] = useState<HTMLDivElement | null>(null);
  const press = useRef<ComponentPropsWithRef<"div">["onPointerDown"]>(undefined);
  return <VoiceSeatContext.Provider value={{ host: seat, press }}>
    <div data-agent-bar-shell className="flex w-full min-w-0 flex-col gap-2">
      {children}
      <AgentBarSurface retained data-testid="one-voice-agent-bar" data-agent-dock="one-agent-dock" role="group" aria-label="One private agent"
        onPointerDown={event => press.current?.(event)}>
        <div ref={setSeat} className="flex w-full min-w-0 items-center" />
      </AgentBarSurface>
    </div>
  </VoiceSeatContext.Provider>;
}

/** One presentation for voice capture and Chat input; no routing or microphone authority. */
export function AgentBarSurface({ className, children, embedded = false, retained = false, ...props }: ComponentPropsWithRef<"div"> & { embedded?: boolean; retained?: boolean }) {
  const voiceSeat = useContext(VoiceSeatContext);
  const dock = useAgentDockSurface();
  const composerVisible = dock?.composerVisible ?? false;
  const suppressed = dock?.suppressed ?? false;
  const attachHost = dock?.setHost;
  const native = useNativeDockPorts();
  const nativeOwned = native?.owned === true;
  useLayoutEffect(() => {
    if (!voiceSeat || embedded || retained) return;
    const handler = props.onPointerDown;
    voiceSeat.press.current = handler;
    return () => { if (voiceSeat.press.current === handler) voiceSeat.press.current = undefined; };
  });
  // This is an explicitly authored presentation slot, not DOM-derived action
  // mapping. Embedded Chat always renders into the retained composer seat.
  if (!embedded && !retained && voiceSeat !== undefined) {
    return voiceSeat.host ? createPortal(<div {...props} data-testid={undefined} data-agent-dock={undefined} role={undefined} aria-label={undefined} onPointerDown={undefined}
      className={cn("flex w-full min-w-0 items-center", className)}>{children}</div>, voiceSeat.host) : null;
  }
  return (
    <div
      {...props}
      data-agent-dock-surface={dock ? (composerVisible ? "text" : "voice") : undefined}
      data-agent-dock-embedded={embedded || undefined}
      hidden={suppressed || props.hidden}
      inert={suppressed || props.inert || nativeOwned}
      aria-hidden={nativeOwned ? true : props["aria-hidden"]}
      style={embedded && nativeOwned ? { ...props.style, visibility: "hidden", height: native?.height } : props.style}
      className={cn(
        !embedded && !nativeOwned && "bottom-chrome-surface",
        "pointer-events-auto relative flex min-h-11 items-center overflow-hidden rounded-full",
        dock && "min-h-[3.25rem] rounded-[1.5rem]",
        BOTTOM_CHROME_COLUMN_CLASSNAME,
        className,
        suppressed && "hidden",
        dock && nativeOwned && "!bg-transparent !shadow-none !ring-0",
      )}
    >
      {dock ? <>
        <div data-agent-dock-voice hidden={composerVisible || nativeOwned} inert={composerVisible || nativeOwned} className="flex w-full min-w-0 items-center">{children}</div>
        {nativeOwned && !composerVisible ? <div aria-hidden style={{ height: native?.height }} className="w-full" /> : null}
        <div ref={attachHost} data-agent-dock-composer hidden={!composerVisible} inert={!composerVisible} className="w-full min-w-0" />
      </> : children}
    </div>
  );
}
