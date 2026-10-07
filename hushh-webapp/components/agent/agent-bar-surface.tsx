"use client";

import type { ComponentPropsWithRef } from "react";
import { BOTTOM_CHROME_COLUMN_CLASSNAME } from "@/components/app-ui/bottom-chrome-column";
import { cn } from "@/lib/utils";
import { useAgentDockSurface } from "./agent-dock";

/** One presentation for voice capture and Chat input; no routing or microphone authority. */
export function AgentBarSurface({ className, children, embedded = false, ...props }: ComponentPropsWithRef<"div"> & { embedded?: boolean }) {
  const dock = useAgentDockSurface();
  const composerVisible = dock?.composerVisible ?? false;
  const suppressed = dock?.suppressed ?? false;
  const attachHost = dock?.setHost;
  return (
    <div
      {...props}
      data-agent-dock-surface={dock ? (composerVisible ? "text" : "voice") : undefined}
      data-agent-dock-embedded={embedded || undefined}
      hidden={suppressed || props.hidden}
      inert={suppressed || props.inert}
      className={cn(
        !embedded && "bottom-chrome-surface",
        "pointer-events-auto relative flex min-h-11 items-center overflow-hidden rounded-full",
        dock && "min-h-[3.25rem] rounded-[1.5rem]",
        BOTTOM_CHROME_COLUMN_CLASSNAME,
        className,
        suppressed && "hidden",
      )}
    >
      {dock ? <>
        <div data-agent-dock-voice hidden={composerVisible} inert={composerVisible} className="flex w-full min-w-0 items-center">{children}</div>
        <div ref={attachHost} data-agent-dock-composer hidden={!composerVisible} inert={!composerVisible} className="w-full min-w-0" />
      </> : children}
    </div>
  );
}
