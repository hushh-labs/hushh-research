"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import { useBackLayer } from "@/lib/navigation/back-layers";

/** Keep the event's verified destination; the external Meet identity is chosen in Meet. */
export function CalendarJoinLink({ url, accountEmail, label = "Join meeting", ariaLabel, className, children }: {
  url: string | null | undefined;
  accountEmail?: string | null;
  label?: string;
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const safe = safeMeetingUrl(url);
  const [launch, setLaunch] = useState<{ url: string; accountEmail: string } | null>(null);
  const pathname = usePathname();
  useBackLayer(pathname, launch ? 3 : 0, () => { setLaunch(null); return true; });
  if (!safe) return null;
  const isMeet = new URL(safe).hostname === "meet.google.com";
  const email = accountEmail?.trim() || "";
  if (!isMeet || !email) return <a href={safe} target="_blank" rel="noopener noreferrer" className={className} aria-label={ariaLabel}>{children || label}</a>;
  return <>
    <a href={safe} target="_blank" rel="noopener noreferrer" className={className} aria-label={ariaLabel} onClick={event => { event.preventDefault(); setLaunch({ url: safe, accountEmail: email }); }}>{children || label}</a>
    <Dialog modal open={Boolean(launch)} onOpenChange={open => { if (!open) setLaunch(null); }}>
      <DialogContent className="w-[min(calc(100vw-2rem),24rem)] gap-3 p-5">
        <DialogHeader className="text-left"><DialogTitle>Check Google account</DialogTitle><DialogDescription>Use {launch?.accountEmail} in Google Meet. Tap Switch on the pre-join screen.</DialogDescription></DialogHeader>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setLaunch(null)}>Cancel</Button><Button asChild><a href={launch?.url || safe} target="_blank" rel="noopener noreferrer" onClick={() => setLaunch(null)}>Open Meet</a></Button></div>
      </DialogContent>
    </Dialog>
  </>;
}
