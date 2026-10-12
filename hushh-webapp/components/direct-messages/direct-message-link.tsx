"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps, MouseEvent } from "react";

import { resolveDirectMessageHref } from "@/lib/direct-messages/navigate-direct-message";
import { morphyToast } from "@/lib/morphy-ux/morphy";

/** Legacy selection is a prop only, never an anchor URL or browser entry. */
export function DirectMessageLink({
  href, onClick, onAuxClick, ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const router = useRouter();
  const query = new URL(href, "https://navigation.invalid").searchParams;
  const token = query.get("token");

  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || token) return;
    event.preventDefault();
    // Open the empty tab during the user gesture, then give it only the
    // encrypted destination. A denied or stale request closes the empty tab.
    const newTab = event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey || props.target === "_blank";
    const tab = newTab ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    void (async () => {
      try {
        const destination = await resolveDirectMessageHref({
          conversationId: query.get("conversation"), personRef: query.get("person"),
        });
        if (!destination) { tab?.close(); return; }
        if (tab) tab.location.replace(destination);
        else router.push(destination);
      } catch {
        tab?.close();
        morphyToast.error("This conversation could not be opened. Try again.");
      }
    })();
  };

  return (
    <Link
      {...props}
      href={token ? `/one/messages?token=${encodeURIComponent(token)}` : "/one/messages"}
      onClick={(event) => { onClick?.(event); navigate(event); }}
      onAuxClick={(event) => { onAuxClick?.(event); if (event.button === 1) navigate(event); }}
    />
  );
}
