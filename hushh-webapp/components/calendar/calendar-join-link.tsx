"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { calendarMeetingTarget } from "@/lib/calendar/calendar-url";
import { useBackLayer } from "@/lib/navigation/back-layers";

/** Prefer the calendar account in Meet and let Google handle missing sessions. */
export function CalendarJoinLink({ url, accountEmail, label = "Join meeting", ariaLabel, className, children, open, onOpenChange }: {
  url: string | null | undefined;
  accountEmail?: string | null;
  label?: string;
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const target = calendarMeetingTarget(url, accountEmail);
  const [launch, setLaunch] = useState<ReturnType<typeof calendarMeetingTarget>>(null);
  const trigger = useRef<HTMLAnchorElement>(null);
  const pathname = usePathname();
  const close = () => { setLaunch(null); onOpenChange?.(false); };
  const shown = target?.chooserUrl ? open ? target : launch : null;
  useBackLayer(pathname, shown ? 3 : 0, () => { close(); return true; });
  if (!target) return null;
  if (!target.chooserUrl) return <a href={target.url} target="_blank" rel="noopener noreferrer" className={className} aria-label={ariaLabel}>{children || label}</a>;
  return <>
    {!open ? <a ref={trigger} href={target.url} target="_blank" rel="noopener noreferrer" className={className} aria-label={ariaLabel} onClick={event => { event.preventDefault(); setLaunch(target); }}>{children || label}</a> : null}
    <Dialog modal open={Boolean(shown)} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="w-[min(calc(100vw-2rem),24rem)] gap-3 p-5" onCloseAutoFocus={event => {
        event.preventDefault();
        trigger.current?.focus();
      }}>
        <DialogHeader className="text-left">
          <DialogTitle>Check Google account</DialogTitle>
          <DialogDescription className="wrap-anywhere">Use {shown?.accountEmail} in Google Meet. If you’re not signed in to that account here, choose or add it first.</DialogDescription>
        </DialogHeader>
        {shown && <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={close}>Cancel</Button>
          {shown.chooserUrl ? <Button asChild variant="outline"><a href={shown.chooserUrl} target="_blank" rel="noopener noreferrer" onClick={close}>Choose account</a></Button> : null}
          <Button asChild><a href={shown.url} target="_blank" rel="noopener noreferrer" onClick={close}>Open Meet</a></Button>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
