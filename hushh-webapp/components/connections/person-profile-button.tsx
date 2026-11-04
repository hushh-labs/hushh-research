"use client";

import type { HTMLAttributes } from "react";
import { openPersonProfilePreview, type PersonProfilePreviewIdentity } from "@/lib/connections/person-profile-preview";
import { cn } from "@/lib/utils";

/** Preserve a custom portrait's appearance while giving known people an independent action. */
export function PersonProfileButton({ personRef, userId, label, className, children, ...props }:
  PersonProfilePreviewIdentity & Omit<HTMLAttributes<HTMLElement>, "onClick"> & { label: string }) {
  if (!personRef?.trim() && !userId?.trim()) {
    return <span {...props} className={className} aria-hidden="true">{children}</span>;
  }
  return <button {...props} type="button" aria-hidden={undefined} aria-label={`View ${label}'s profile`}
    className={cn("cursor-pointer appearance-none p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    onClick={event => { event.preventDefault(); event.stopPropagation(); openPersonProfilePreview({ personRef, userId }, event.currentTarget); }}>
    {children}
  </button>;
}
