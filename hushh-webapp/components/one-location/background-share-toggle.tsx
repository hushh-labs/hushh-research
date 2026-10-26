"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { morphyToast } from "@/lib/morphy-ux/morphy";

export interface BackgroundShareToggleProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  requestAlwaysAuthorization: () => Promise<{ background: string }>;
}

/** Disclosure acceptance precedes the OS request; stale replies never enable sharing. */
export function BackgroundShareToggle({ enabled, onEnabledChange, requestAlwaysAuthorization }: BackgroundShareToggleProps) {
  const id = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const lifetime = useRef({ mounted: true, generation: 0 });
  useEffect(() => {
    const current = lifetime.current;
    current.mounted = true;
    return () => { current.mounted = false; current.generation++; };
  }, []);
  const cancel = useCallback(() => {
    lifetime.current.generation++;
    setOpen(false);
    setPending(false);
  }, []);
  const accept = async () => {
    if (pending || !open) return;
    const request = ++lifetime.current.generation;
    const current = () => lifetime.current.mounted && lifetime.current.generation === request;
    setPending(true);
    try {
      const permission = await requestAlwaysAuthorization();
      if (!current()) return;
      if (permission.background !== "available") {
        setOpen(false);
        morphyToast.error("Allow background location in your device settings to use this option.");
        return;
      }
      onEnabledChange(true);
      setOpen(false);
    } catch {
      if (current()) morphyToast.error("Couldn’t enable background sharing. Please try again.");
    } finally {
      if (current()) setPending(false);
    }
  };

  if (!Capacitor.isNativePlatform()) return null;
  return (
    <>
      <label htmlFor={id} className="flex min-h-11 items-center justify-between gap-4 py-2">
        <span className="min-w-0">
          <span className="block text-sm font-medium">Keep sharing in the background</span>
          <span className="block text-xs text-muted-foreground">Update active shares while you use another app or lock your screen.</span>
        </span>
        <Switch ref={switchRef} id={id} checked={enabled} aria-label="Keep sharing in the background"
          data-voice-control-id="one-location-background-sharing-toggle"
          onCheckedChange={(next) => { if (next) setOpen(true); else { cancel(); onEnabledChange(false); } }} />
      </label>
      <Dialog modal open={open} onOpenChange={(next) => { if (!next) cancel(); }}>
        <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); switchRef.current?.focus(); }} className="max-w-[min(420px,calc(100vw-32px))]" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Keep sharing in the background?</DialogTitle>
            <DialogDescription>
              Hussh One collects your location in the background to update active live shares and Save My Soul alerts for the people you choose, including while you use another app or lock your screen. Updates are encrypted on your device for each recipient. You can pause or stop sharing at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={cancel} data-voice-control-id="one-location-background-sharing-cancel">Not now</Button>
            <Button onClick={() => void accept()} disabled={pending} isLoading={pending}
              data-voice-control-id="one-location-background-sharing-accept">Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
