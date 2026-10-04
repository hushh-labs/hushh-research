"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UsersRound, ImageIcon, Trash2 } from "@/components/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { pickAvatar } from "@/lib/profile/avatar-capture";
import { cn } from "@/lib/utils";

export function CircleAvatar({ photoUrl, className }: { photoUrl?: string | null; className?: string }) {
  return <Avatar key={photoUrl || "group"} className={cn("size-12 shrink-0", className)}>
    {photoUrl ? <AvatarImage src={photoUrl} alt="" referrerPolicy="no-referrer" /> : null}
    <AvatarFallback aria-hidden="true" className="bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent-deep)]"><UsersRound className="size-6" /></AvatarFallback>
  </Avatar>;
}

export function CirclePhotoEditor({ circleId, photoUrl, canEdit, onUpdate, onOpenChange }: {
  circleId: string; photoUrl: string | null; canEdit: boolean;
  onUpdate?: (photoUrl: string | null) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(photoUrl);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const invalidate = useCallback(() => { epoch.current++; }, []);
  const trigger = useRef<HTMLButtonElement>(null);
  const latest = useRef({ canEdit, onUpdate, onOpenChange }); latest.current = { canEdit, onUpdate, onOpenChange };
  useEffect(() => {
    latest.current.onOpenChange?.(open);
    return () => latest.current.onOpenChange?.(false);
  }, [open]);
  useEffect(() => {
    invalidate(); setOpen(false); setBusy(false); setPicking(false); setError(null);
    return invalidate;
  }, [circleId, canEdit, invalidate]);
  const changeOpen = (value: boolean) => {
    if (busy || picking) return;
    epoch.current++;
    if (value) { setDraft(photoUrl); setError(null); }
    setOpen(value);
  };
  if (!canEdit || !onUpdate) return <CircleAvatar photoUrl={photoUrl} className="size-14" />;
  return <>
    <button ref={trigger} type="button" aria-label="Change circle photo" title="Change circle photo"
      className="shrink-0 rounded-full touch-manipulation focus-visible:outline-2 focus-visible:outline-ring" onClick={() => changeOpen(true)}>
      <CircleAvatar photoUrl={photoUrl} className="size-14" />
    </button>
    <Sheet modal open={open} onOpenChange={changeOpen}>
      <SheetContent side="bottom" onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }} className="mx-auto w-full rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-lg sm:px-6">
        <SheetHeader><SheetTitle>Circle photo</SheetTitle><SheetDescription>Choose a photo for your circle.</SheetDescription></SheetHeader>
        <div className="flex flex-col items-center gap-4 py-5">
          <CircleAvatar photoUrl={draft} className="size-28" />
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" className="min-h-11" disabled={busy || picking} onClick={async () => {
              const current = epoch.current;
              setPicking(true); setError(null);
              try {
                const result = await pickAvatar("Circle photo");
                if (current !== epoch.current || !latest.current.canEdit) return;
                if (result.kind === "selected") setDraft(result.dataUrl);
                else if (result.kind === "failed") setError("That photo couldn’t be selected. Try again.");
              } catch { if (current === epoch.current) setError("Couldn’t open your photos. Try again."); }
              finally { if (current === epoch.current) setPicking(false); }
            }}><ImageIcon className="size-4" />{picking ? "Opening photos…" : "Choose photo"}</Button>
            {draft ? <Button variant="ghost" className="min-h-11" disabled={busy || picking} onClick={() => setDraft(null)}><Trash2 className="size-4" />Remove photo</Button> : null}
          </div>
          {error ? <p role="alert" className="text-center text-sm text-destructive">{error}</p> : null}
          <div className="flex w-full justify-center gap-2">
            <Button variant="ghost" className="min-h-11" disabled={busy || picking} onClick={() => changeOpen(false)}>Cancel</Button>
            <Button className="min-h-11" disabled={busy || picking || draft === photoUrl} isLoading={busy} onClick={async () => {
              if (!latest.current.canEdit || !latest.current.onUpdate || busy) return;
              const current = epoch.current;
              setBusy(true); setError(null);
              try { await latest.current.onUpdate(draft); if (current === epoch.current) setOpen(false); }
              catch (error) { if (current === epoch.current) setError(error instanceof Error ? error.message : "Circle photo wasn’t saved. Try again."); }
              finally { if (current === epoch.current) setBusy(false); }
            }}>Save photo</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  </>;
}
