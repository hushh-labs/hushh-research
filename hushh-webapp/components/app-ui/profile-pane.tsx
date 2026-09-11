"use client";

import { X } from "lucide-react";

import { ProfilePage } from "@/app/profile/profile-workspace-page";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type ProfilePaneProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The signed-in Profile entry surface. Profile owns its existing settings
 * rows and route-aware stack; this component only supplies the immersive
 * right-side presentation used by the shell and native edge gesture.
 */
export function ProfilePane({ open, onOpenChange }: ProfilePaneProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal>
      <SheetContent
        side="right"
        showCloseButton={false}
        contentDragDismiss={false}
        className="w-[min(92vw,480px)] max-w-none gap-0 overflow-hidden p-0"
        aria-label="Profile"
        data-testid="profile-pane"
      >
        <SheetHeader className="shrink-0 border-b border-border/60 px-5 pb-4 pt-[calc(1rem+env(safe-area-inset-top))] pr-16 text-left">
          <SheetTitle>Profile</SheetTitle>
          <SheetDescription>
            Your account, preferences, and privacy controls.
          </SheetDescription>
        </SheetHeader>
        <SheetClose
          asChild
          className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] z-10"
        >
          <button
            type="button"
            aria-label="Close Profile"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </SheetClose>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
          <ProfilePage presentation="pane" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
