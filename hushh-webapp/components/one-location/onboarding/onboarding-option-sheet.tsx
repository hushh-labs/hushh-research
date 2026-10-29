"use client";

import { useBackLayer } from "@/lib/navigation/back-layers";
import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/** Optional work keeps its own focus/Back boundary without lengthening setup. */
export function OnboardingOptionSheet({
  open,
  onClose,
  title,
  children,
  busy = false,
  overPlace = false,
  routeId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  busy?: boolean;
  overPlace?: boolean;
  routeId?: string;
}) {
  useBackLayer(routeId ?? "", open && routeId ? 3 : 0, () => {
    if (!busy) onClose();
    return true;
  });
  return (
    <Sheet modal open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <SheetContent
        side="bottom"
        contentDragDismiss={false}
        data-location-type-scale="connect"
        data-location-type-context="overlay"
        aria-describedby={undefined}
        className={(overPlace ? "z-[9201] " : "z-[9051] ") + "mx-auto flex max-h-[min(88dvh,calc(100dvh-var(--kb-height,0px)-24px))] w-full max-w-[520px] flex-col gap-0 overflow-hidden rounded-t-[28px] p-0"}
        overlayClassName={overPlace ? "z-[9200]" : "z-[9050]"}
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
      >
        <header className="shrink-0 px-6 pb-4 pt-6 pr-14">
          <SheetTitle className="ui-text-navigation-title">{title}</SheetTitle>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)]">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
