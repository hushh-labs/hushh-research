"use client";

import { useId, type ButtonHTMLAttributes, type Ref } from "react";
import { cn } from "@/lib/utils";

/** A selection action and an avatar are sibling buttons with the original row geometry. */
export function PersonSelectionSurface({ children, className, style, surfaceRef, ...action }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement>; surfaceRef?: Ref<HTMLDivElement> }) {
  const contentId = useId();
  const visualData = Object.fromEntries(Object.entries(action).filter(([key]) => key.startsWith("data-") && key !== "data-testid"));
  return <div id={contentId} ref={surfaceRef} {...visualData} data-pressed={action["aria-pressed"]} data-disabled={action.disabled || undefined} className={cn("relative isolate [&>*:not([data-person-row-action])]:relative [&>*:not([data-person-row-action])]:z-[2] [&>*:not([data-person-row-action])]:pointer-events-none [&_button]:pointer-events-auto [&_a]:pointer-events-auto", className)} style={style}>
    <button data-person-row-action aria-labelledby={action["aria-label"] ? undefined : contentId} {...action} type="button" className="absolute inset-0 z-[1] block size-full appearance-none rounded-[inherit] border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
    {children}
  </div>;
}
