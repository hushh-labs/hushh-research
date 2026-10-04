"use client";

import { memo, startTransition, useEffect, useState } from "react";

import { ArrowLeftIcon as ArrowLeft, XIcon as X } from "@/components/icons";
import { usePathname, useSearchParams } from "next/navigation";

import { ProfilePage } from "@/components/profile/profile-workspace-page";
import { Skeleton } from "@/components/ui/skeleton";
import { useVault } from "@/lib/vault/vault-context";
import {
  PROFILE_PANE_SHOWN_EVENT,
  canGoBackProfilePane,
  popProfilePaneLocation,
  profilePaneLocationKey,
  resolveProfilePaneUrlState,
  type ProfilePaneLocation,
} from "@/lib/navigation/profile-pane";
import { connectorDetailTitle } from "@/lib/navigation/profile-routes";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const PROFILE_DETAIL_TITLES: Record<string, string> = {
  phone: "Phone number",
  sharing: "Access & sharing",
  "kai-preferences": "Finance preferences",
  gemini: "Gemini",
  voice: "Voice",
  vault: "Vault methods",
  session: "Account access",
  "trusted-devices": "Trusted devices",
  "gmail-connection": "Connection",
  "gmail-actions": "Actions",
  terms: "Terms of Use",
  privacy: "Privacy Policy",
};

/** Rows in the Profile home's "Your settings" group, for the shell. */
const PROFILE_PANE_SHELL_ROW_COUNT = 7;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function markProfilePane(name: string): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") {
    return;
  }
  performance.mark(name);
}

/**
 * False until the pane's first slide frame has been painted.
 *
 * Opening the pane used to mount the whole Profile page (thousands of lines,
 * dozens of hooks and effects) in the same commit that inserts the sheet, so
 * the slide could not paint its first frame until all of it had rendered,
 * styled and laid out. The pane now commits its header and a static shell,
 * waits for that frame (two animation frames: the first runs just before it
 * paints, the second just after), then builds the page in a transition React
 * may interrupt. The slide itself is transform and opacity only, so it keeps
 * moving on the compositor while the page renders underneath it.
 *
 * Reduced motion has no slide to protect, so the page mounts at once.
 */
function useProfilePaneFirstFramePainted(): boolean {
  const [painted, setPainted] = useState(prefersReducedMotion);
  useEffect(() => {
    if (painted) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      markProfilePane("hushh:profile-pane-first-frame");
      second = window.requestAnimationFrame(() => {
        startTransition(() => setPainted(true));
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [painted]);
  return painted;
}

/** Static placeholder in the Profile home's shape: no data, no measuring. */
function ProfilePaneShell() {
  return (
    <div
      data-testid="profile-pane-shell"
      aria-hidden="true"
      className="flex flex-col gap-6 px-[max(var(--page-inline-gutter-standard),calc(1rem+env(safe-area-inset-left)))] pt-5"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="size-14 shrink-0 rounded-full motion-safe:animate-none" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-40 motion-safe:animate-none" />
          <Skeleton className="h-3 w-52 motion-safe:animate-none" />
        </div>
      </div>
      <div className="flex flex-col">
        {Array.from({ length: PROFILE_PANE_SHELL_ROW_COUNT }, (_, index) => (
          <div key={index} className="flex h-12 items-center gap-3">
            <Skeleton className="size-7 shrink-0 rounded-full motion-safe:animate-none" />
            <Skeleton className="h-4 w-36 motion-safe:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Lives inside the sheet's content, so it mounts with each open and unmounts
 * after each close: every open starts from the shell, and a close (or a move
 * between panels while open) never shows it again.
 */
function ProfilePaneBody({ location }: { location: ProfilePaneLocation }) {
  const firstFramePainted = useProfilePaneFirstFramePainted();
  // Mounted once per open, inside the committed sheet content: the evidence a
  // requested open is actually showing (voice settles on this, not the ask).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
  }, []);
  useEffect(() => {
    if (firstFramePainted) markProfilePane("hushh:profile-pane-content");
  }, [firstFramePainted]);
  if (!firstFramePainted) return <ProfilePaneShell />;
  return <ProfilePage presentation="pane" paneLocation={location} />;
}

type ProfilePaneProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The signed-in Profile entry surface. Profile owns its existing settings
 * rows and route-aware stack; this component only supplies the immersive
 * right-side presentation used by the shell and native edge gesture.
 */
export const ProfilePane = memo(function ProfilePane({
  open,
  onOpenChange,
}: ProfilePaneProps) {
  const { isVaultUnlocked } = useVault();
  const pathname = usePathname() || "/";
  const searchParams = useSearchParams();
  const paneState = resolveProfilePaneUrlState(searchParams);
  // Closing removes the pane query, which also resets the URL location to the
  // root in the same commit that starts the exit slide. Showing that reset
  // meant closing from a sub-panel retitled the header to "Profile" and slid
  // the inner stack back while the sheet slid out: two motions and a flicker.
  // Hold the last open location until the pane is open again.
  const [heldLocation, setHeldLocation] = useState(paneState.location);
  if (
    paneState.open &&
    profilePaneLocationKey(paneState.location) !==
      profilePaneLocationKey(heldLocation)
  ) {
    setHeldLocation(paneState.location);
  }
  const location = paneState.open ? paneState.location : heldLocation;
  const canGoBack = canGoBackProfilePane(location);
  const panelTitle = location.panel
    ? location.panel === "my-data"
      ? "Memory"
      : location.panel === "connected-systems"
        ? "Connected Systems"
        : location.panel === "connectors"
          ? "Connectors"
        : location.panel === "gmail"
          ? "Mail receipts"
          : location.panel === "account"
            ? "Your account"
            : location.panel === "hosting"
              ? "Hosting"
              : location.panel === "software-updates"
                ? "Software updates"
                : location.panel === "preferences"
                  ? "Appearance & preferences"
                  : location.panel === "security"
                    ? "Security & privacy"
                    : location.panel === "referrals"
                      ? "Invite friends"
                      : location.panel === "legal"
                        ? "Legal"
                        : "Help & feedback"
    : "Profile";
  // A detail is named for what it is ("Trusted devices"), matching its entry
  // in the Profile stack; it used to read "Profile detail" for all of them.
  // Details without a fixed name (a domain, a connection) keep the panel's.
  const detail = location.detail;
  const title = detail
    ? (PROFILE_DETAIL_TITLES[detail] ?? connectorDetailTitle(detail) ?? panelTitle)
    : panelTitle;

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
                onClick={() => popProfilePaneLocation(pathname, searchParams)}
                className="-ml-4 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : null}
            <SheetTitle className="truncate font-[family-name:var(--font-app-display)] text-[22px] font-bold leading-[27px] tracking-normal">
              {title}
            </SheetTitle>
          </div>
          {/* On a panel the page opens with its own description, so the
           * generic line stays for assistive tech only (two subtitles, one
           * line apart, read as clutter). The arrow's glyph sits on the
           * content column, as the close button's edge does on the right. */}
          <SheetDescription
            className={
              canGoBack
                ? "sr-only"
                : "font-[family-name:var(--font-app-body)] text-[15px] leading-5 tracking-normal"
            }
          >
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
          <ProfilePaneBody location={location} />
        </div>
      </SheetContent>
    </Sheet>
  );
});
