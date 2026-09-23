"use client";

import { memo } from "react";

import {
  ArrowLeftIcon as ArrowLeft,
  XIcon as X,
} from "@/components/icons";
import { usePathname, useSearchParams } from "next/navigation";

import { ProfilePage } from "@/components/profile/profile-workspace-page";
import { useVault } from "@/lib/vault/vault-context";
import {
  canGoBackProfilePane,
  popProfilePaneLocation,
  resolveProfilePaneUrlState,
} from "@/lib/navigation/profile-pane";
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
export const ProfilePane = memo(function ProfilePane({ open, onOpenChange }: ProfilePaneProps) {
  const { isVaultUnlocked } = useVault();
  const pathname = usePathname() || "/";
  const searchParams = useSearchParams();
  const paneState = resolveProfilePaneUrlState(searchParams);
  const canGoBack = canGoBackProfilePane(paneState.location);
  const title = paneState.location.detail
    ? "Profile detail"
    : paneState.location.panel
      ? paneState.location.panel === "my-data"
        ? "Memory"
        : paneState.location.panel === "connected-systems"
          ? "Connected Systems"
          : paneState.location.panel === "gmail"
            ? "Mail receipts"
            : paneState.location.panel === "account"
              ? "Your account"
              : paneState.location.panel === "preferences"
                ? "Appearance & preferences"
                : paneState.location.panel === "security"
                  ? "Security & privacy"
                  : paneState.location.panel === "referrals"
                    ? "Invite friends"
                    : "Help & feedback"
      : "Profile";

  // URL state requests a destination, not admission. Keep it for resume, but
  // unmount the modal while the vault gate owns the screen (including cold
  // loads and manual relocks), so no sheet or focus trap covers unlock.
  if (!isVaultUnlocked) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal>
      <SheetContent
        side="right"
        showCloseButton={false}
        contentDragDismiss={false}
        className="w-full max-w-none transform-gpu gap-0 overflow-hidden p-0 data-[state=open]:will-change-transform data-[state=closed]:will-change-transform sm:w-[min(92vw,560px)] sm:max-w-[560px]"
        aria-label="Profile"
        data-testid="profile-pane"
      >
        <SheetHeader className="shrink-0 border-b border-border/60 pb-4 pl-[max(var(--page-inline-gutter-standard),calc(1rem+env(safe-area-inset-left)))] pr-[max(5rem,calc(var(--page-inline-gutter-standard)+4rem))] pt-[calc(1rem+env(safe-area-inset-top))] text-left">
          <div className="flex min-w-0 items-center gap-2">
            {canGoBack ? (
              <button
                type="button"
                aria-label="Back in Profile"
                onClick={() =>
                  popProfilePaneLocation(pathname, searchParams)
                }
                className="-ml-3 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : null}
            <SheetTitle className="truncate">{title}</SheetTitle>
          </div>
          {/* On a panel the page opens with its own description, so the
           * generic line stays for assistive tech only (two subtitles, one
           * line apart, read as clutter). The arrow's glyph sits on the
           * content column, as the close button's edge does on the right. */}
          <SheetDescription className={canGoBack ? "sr-only" : undefined}>
            {canGoBack
              ? "Profile settings"
              : "Your account, preferences, and privacy controls."}
          </SheetDescription>
        </SheetHeader>
        <SheetClose
          asChild
          className="absolute top-[calc(1rem+env(safe-area-inset-top))] z-10"
        >
          <button
            type="button"
            aria-label="Close Profile"
            style={{ right: "max(1rem, env(safe-area-inset-right, 0px))" }}
            className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill)] text-muted-foreground transition-colors duration-100 hover:bg-[color:var(--app-neutral-fill-strong)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <X className="h-4 w-4" />
          </button>
        </SheetClose>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(1.5rem,env(safe-area-inset-bottom))] [-webkit-overflow-scrolling:touch]"
          data-profile-pane-scroll-root="true"
        >
          <ProfilePage presentation="pane" />
        </div>
      </SheetContent>
    </Sheet>
  );
});
