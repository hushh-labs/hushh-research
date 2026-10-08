"use client";

import { createContext, useCallback, useContext, type ReactNode, type RefCallback } from "react";
import { cn } from "@/lib/utils";

type Presentation = { open: boolean; side: "left" | "right"; onMotionRef: RefCallback<HTMLDivElement> };
const Context = createContext<Presentation | null>(null);

/** Layout projection only. The existing dialog retains focus, isolation,
 * navigation and gesture authority; its semantic frame never translates. */
export function SidePanelMotionProvider({ children, ...presentation }: Presentation & { children: ReactNode }) {
  return <Context.Provider value={presentation}>{children}</Context.Provider>;
}

/** Opt-in body motion shared by Profile and History, not a new gesture owner. */
export function SidePanelMotionBody({ children, className, contentRef }: {
  children: ReactNode;
  className?: string;
  contentRef?: RefCallback<HTMLDivElement>;
}) {
  const presentation = useContext(Context);
  const onMotionRef = presentation?.onMotionRef;
  const attach = useCallback((node: HTMLDivElement | null) => {
    onMotionRef?.(node);
    contentRef?.(node);
  }, [onMotionRef, contentRef]);
  if (!presentation) return children;
  return <div ref={attach}
    data-side-panel-body={presentation.side} data-state={presentation.open ? "open" : "closed"}
    className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>{children}</div>;
}
