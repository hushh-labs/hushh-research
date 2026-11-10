"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import { useBackLayer } from "@/lib/navigation/back-layers";

/** Prefer the calendar account in Meet and let Google handle missing sessions. */
export function CalendarJoinLink({ url, accountEmail, label = "Join meeting", ariaLabel, className, children }: {
  url: string | null | undefined;
  accountEmail?: string | null;
  label?: string;
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const safe = safeMeetingUrl(url);
  const [launch, setLaunch] = useState<{ url: string; chooserUrl: string; accountEmail: string } | null>(null);
  const trigger = useRef<HTMLAnchorElement>(null);
  const pathname = usePathname();
  useBackLayer(pathname, launch ? 3 : 0, () => { setLaunch(null); return true; });
  if (!safe) return null;
  const meeting = new URL(safe);
  const email = accountEmail?.trim() || "";
  if (meeting.origin !== "https://meet.google.com" || !email) return <a href={safe} target="_blank" rel="noopener noreferrer" className={className} aria-label={ariaLabel}>{children || label}</a>;
  meeting.searchParams.set("authuser", email);
  const prepareLaunch = () => {
    const continuation = new URL(meeting);
    // Google's chooser supplies the session the person selects.
    continuation.searchParams.delete("authuser");
    const chooser = new URL("https://accounts.google.com/AccountChooser");
    chooser.searchParams.set("continue", continuation.href);
    setLaunch({ url: meeting.href, chooserUrl: chooser.href, accountEmail: email });
  };
  return <>
    <a ref={trigger} href={meeting.href} target="_blank" rel="noopener noreferrer" className={className} aria-label={ariaLabel} onClick={event => { event.preventDefault(); prepareLaunch(); }}>{children || label}</a>
    <Dialog modal open={Boolean(launch)} onOpenChange={open => { if (!open) setLaunch(null); }}>
      <DialogContent className="w-[min(calc(100vw-2rem),24rem)] gap-3 p-5" onCloseAutoFocus={event => {
        event.preventDefault();
        trigger.current?.focus();
      }}>
        <DialogHeader className="text-left">
          <DialogTitle>Check Google account</DialogTitle>
          <DialogDescription className="wrap-anywhere">Use {launch?.accountEmail} in Google Meet. If you’re not signed in to that account here, choose or add it first.</DialogDescription>
        </DialogHeader>
        {launch && <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setLaunch(null)}>Cancel</Button>
          <Button asChild variant="outline"><a href={launch.chooserUrl} target="_blank" rel="noopener noreferrer" onClick={() => setLaunch(null)}>Choose account</a></Button>
          <Button asChild><a href={launch.url} target="_blank" rel="noopener noreferrer" onClick={() => setLaunch(null)}>Open Meet</a></Button>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
