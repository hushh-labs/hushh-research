"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { resolvePersonRefFromProfilePathname } from "@/lib/navigation/routes";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";

/** Retain a real link for sharing/new tabs; ordinary activation keeps the source mounted. */
export function PersonProfileLink({ onClick, ...props }: ComponentProps<typeof Link>) {
  return <Link {...props} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === "_blank") return;
    const personRef = resolvePersonRefFromProfilePathname(typeof props.href === "string" ? props.href : props.href.pathname);
    if (!personRef) return;
    if (openPersonProfilePreview({ personRef }, event.currentTarget)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }} />;
}
