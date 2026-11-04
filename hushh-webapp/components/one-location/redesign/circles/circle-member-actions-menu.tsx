"use client";
import { PersonProfileLink } from "@/components/connections/person-profile-link";
import { DirectMessageLink } from "@/components/direct-messages/direct-message-link";


/**
 * Every actionable row uses the same three-dot trigger. The action surface
 * keeps sharing in the Profile palette and removal in destructive red.
 *
 * The two things you can do TO one person in a Circle -- Share location and
 * Remove from Circle -- and the surface that offers them.
 *
 * Reported from phone QA with a screenshot of the roster: the kebab on the
 * first member opened a small floating card that landed ON the second
 * member's name, so the screen showed "Share location / Remove from Circle"
 * overlapping the next person in the list. Nothing on the surface said whose
 * actions those were, and the one visual cue available -- proximity --
 * pointed at the wrong person. "Dusre connection ke name ke upar aa gaya."
 *
 * That is not a positioning bug to nudge with an offset. An anchored popover
 * is a POINTER idiom: it works because a cursor is already at the anchor and
 * the eye follows it there. On a phone the finger covers the anchor, the menu
 * paints into whatever row happens to be below, and the roster is a list of
 * near-identical rows -- so the one piece of context that would disambiguate
 * it is exactly what gets covered.
 *
 * So the surface follows the pointer, not the component:
 *
 *   phone   (<640px)   bottom action sheet, headed by the member's own avatar
 *                      and name, over a scrim. It cannot overlap a row
 *                      because it is not laid out against one, and it says
 *                      who it is for in the header rather than by proximity.
 *
 *   desktop (>=640px)  an anchored menu immediately outside the row, to the
 *                      right of the kebab and vertically centred on the
 *                      selected member. Only action rows are visible; the
 *                      accessible menu name identifies the member. A cursor makes
 *                      the anchor unambiguous, and a bottom sheet on a 1440px
 *                      window is the wrong trade in the other direction.
 *
 * 640px is the same boundary `save-location-sheet-layout.ts` switches its own
 * sheet on, and the same one Tailwind's `sm:` uses -- restated here rather
 * than imported, because that constant documents an onboarding modal's
 * geometry and this one is free to move without dragging that surface along.
 *
 * ## Visual Map
 *
 *   phone                                desktop
 *   +--------------------------+                   +---------------------+  [...]
 *   | Ankit Kumar Singh  [...] |                   | (>) Share location  |<-- row
 *   | JHUMMA KUMARI      [...] |                   | (X) Remove from ... |
 *   +==========================+                   +---------------------+
 *   |           ====           |
 *   |  (AK)  Ankit Kumar  (>) |
 *   |        Connected         |
 *   |  | (X) Remove from .. |  |
 *   |  |       Cancel       |  |
 *   +--------------------------+
 */

import { TaskDrawerContent as UnscopedTaskDrawerContent, TaskAlertDialogContent as UnscopedTaskAlertDialogContent, TaskSurfaceBody } from "@/lib/morphy-ux/ui/task-surfaces";
import { useState, useSyncExternalStore } from "react";
import {
  MessageCircle,
  MoreVertical,
  Trash2,
  UserRound,
} from "@/components/icons";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ProfilePaneShareIcon,
} from "@/components/profile/profile-pane-icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import {
  Drawer,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent as UnscopedDropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CIRCLE_MEMBER_ACTIONS_MENU_ALIGN,
  CIRCLE_MEMBER_ACTIONS_MENU_COLLISION_PADDING_PX,
  CIRCLE_MEMBER_ACTIONS_MENU_SIDE,
  CIRCLE_MEMBER_ACTIONS_MENU_SIDE_OFFSET_PX,
  CIRCLE_MEMBER_MENU_CLASSNAME,
  CIRCLE_MEMBER_MENU_ITEM_CLASSNAME,
  CIRCLE_MEMBER_MENU_TRIGGER_CLASSNAME,
} from "@/components/one-location/redesign/circles/circle-member-row-layout";
import { resolvePersonRefFromProfilePathname } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import { LOCATION_ACTION_SHAPE } from "../location-action-styles";
import { withLocationTypography } from "../location-typography";

const TaskAlertDialogContent = withLocationTypography(UnscopedTaskAlertDialogContent);
const TaskDrawerContent = withLocationTypography(UnscopedTaskDrawerContent);
const DropdownMenuContent = withLocationTypography(UnscopedDropdownMenuContent, "circles");

/* ------------------------------------------------------------------ */
/* Presentation boundary                                              */
/* ------------------------------------------------------------------ */

/** Below this width the actions arrive as a bottom sheet; at or above it, as
 *  the anchored menu. See the module comment for why. */
export const MEMBER_ACTIONS_SHEET_QUERY = "(max-width: 639.98px)";

export const MEMBER_ACTIONS_SHEET_TESTID = "circle-member-actions-sheet";
export const MEMBER_ACTIONS_MENU_TESTID = "circle-member-actions-menu";

/**
 * The anchored menu's surface, on the app's card grammar rather than the
 * primitive's default `rounded-md border shadow-md`.
 *
 * The default is a generic popover: 6px corners, a hairline border in the
 * shadcn palette, and `min-w-[8rem]` -- narrower than "Remove from Circle",
 * so the menu sized itself to its own longest label and looked hand-cut.
 * Everything else on this screen is a 14px-radius card on
 * `--app-primary-surface`; this now is too.
 */
export const MEMBER_ACTIONS_MENU_SURFACE_CLASSNAME =
  "w-[280px] max-w-[calc(100vw-24px)] rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] p-1 text-[color:var(--app-primary-label)] shadow-[var(--app-card-shadow-standard)] dark:shadow-none";

/**
 * One row of the anchored menu.
 *
 * Shares the sheet's 52px row height and 16px horizontal inset so each action
 * fills its surface with a consistent, comfortable target.
 */
export const MEMBER_ACTIONS_MENU_ITEM_CLASSNAME =
  CIRCLE_MEMBER_MENU_ITEM_CLASSNAME;

/** Optional profile/message actions fill the sheet's padded width; Cancel and
 *  the removal confirmation retain their existing 244px measure. */
export const MEMBER_ACTIONS_SHEET_ITEM_CLASSNAME =
  "flex min-h-[52px] w-full items-center gap-3 px-4 py-3 text-left text-[17px] font-normal leading-[22px] transition-colors hover:bg-[color:var(--app-neutral-fill)] focus-visible:bg-[color:var(--app-neutral-fill)] active:bg-[color:var(--app-neutral-fill)] disabled:opacity-60";

export const MEMBER_ACTIONS_SHEET_CTA_CLASSNAME =
  "mx-auto w-full max-w-[244px]";

const MEMBER_REMOVE_CONFIRM_CLASSNAME = "w-full";

/* ------------------------------------------------------------------ */
/* Confirmation copy                                                  */
/* ------------------------------------------------------------------ */

/**
 * The confirm step exists twice -- as an AlertDialog behind the anchored menu
 * and as a second pane inside the sheet -- so its words live here once. Two
 * copies of a sentence about ending someone's access is exactly the kind of
 * pair that drifts, and the phone would be the copy nobody re-read.
 */
export function memberRemoveConfirmTitle(displayName: string): string {
  return `Remove ${displayName}?`;
}

export function memberRemoveConfirmDescription(displayName: string): string {
  return `Circle shares with ${displayName} will stop. Direct shares stay unchanged.`;
}

/* ------------------------------------------------------------------ */
/* Which surface                                                      */
/* ------------------------------------------------------------------ */

function sheetPresentationSupported(): boolean {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  );
}

function subscribeToSheetPresentation(onChange: () => void): () => void {
  if (!sheetPresentationSupported()) return () => {};
  const query = window.matchMedia(MEMBER_ACTIONS_SHEET_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Read during render rather than in an effect, the same way
 * `save-location-modal.tsx` does: an effect would mount the anchored menu for
 * one frame before swapping to the sheet, which on a phone is a visible flash
 * of the exact defect this module exists to remove. The server snapshot is
 * `false`, so SSR and the first client paint agree.
 */
function useSheetPresentation(): boolean {
  return useSyncExternalStore(
    subscribeToSheetPresentation,
    () =>
      sheetPresentationSupported() &&
      window.matchMedia(MEMBER_ACTIONS_SHEET_QUERY).matches,
    () => false,
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export type CircleMemberActionsMenuProps = {
  displayName: string;
  /** Retained for existing callers; the shared avatar component now owns
   *  fallback initials so roster rows and sheets cannot disagree. */
  initials: string;
  photoUrl?: string | null;
  verified?: boolean;
  /** The row's own second line ("Connected", "Owner", "Location setup
   *  needed"). Repeated in the sheet header so the sheet identifies the
   *  person exactly the way the row it came from did. */
  secondaryLine?: string | null;
  /** Present when this member has a request profile: offers View profile. */
  profileHref?: string | null;
  /** Present only for an accepted connection with a public person reference. */
  messageHref?: string | null;
  canShare: boolean;
  canRemove: boolean;
  /** A write is already in flight on this Circle. */
  busy: boolean;
  onShare: () => void;
  onRemove: () => Promise<void>;
};

/**
 * Renders the kebab and its actions -- or, on a row with no valid action, the
 * inert spacer that holds the 44px kebab column open.
 *
 * The spacer lives here rather than at the call site so the two halves of
 * "does this row have a menu" cannot be answered differently in one render.
 * `circle-member-row-layout.ts` documents why the column has to exist on
 * every row at all.
 */
export function CircleMemberActionsMenu({
  displayName,
  photoUrl,
  verified = false,
  secondaryLine,
  canShare,
  canRemove,
  busy,
  onShare,
  onRemove,
  profileHref,
  messageHref,
}: CircleMemberActionsMenuProps) {
  const asSheet = useSheetPresentation();
  const [sheetOpen, setSheetOpen] = useState(false);
  /** The sheet's second pane. A phone gets the confirm INSIDE the sheet
   *  rather than as an AlertDialog over it: vaul's content sits at z-712 and
   *  the alert at z-500, so a dialog opened over a closing sheet would spend
   *  its entrance animation behind the thing it replaced. One surface, two
   *  panes, no stacking order to get wrong. */
  const [sheetConfirmingRemove, setSheetConfirmingRemove] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

  const hasMenu = Boolean(messageHref) || canShare || canRemove;
  const menuLabel = `Actions for ${displayName}`;

  if (!hasMenu) {
    return (
      // Holds the kebab column open on the rows that have no kebab. Without
      // it the roster's right edge steps in and out by 44px from row to row.
      <span
        aria-hidden="true"
        className={CIRCLE_MEMBER_MENU_CLASSNAME}
        data-testid="circle-member-menu-spacer"
      />
    );
  }

  const closeSheet = () => {
    setSheetOpen(false);
    setSheetConfirmingRemove(false);
  };

  if (asSheet) {
    return (
      <>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={busy}
          aria-label={menuLabel}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          className={CIRCLE_MEMBER_MENU_TRIGGER_CLASSNAME}
          onClick={() => {
            setSheetConfirmingRemove(false);
            setSheetOpen(true);
          }}
        >
          <MoreVertical size={24} aria-hidden="true" />
        </Button>

        <Drawer
          modal
          open={sheetOpen}
          onOpenChange={(next) => {
            setSheetOpen(next);
            if (!next) setSheetConfirmingRemove(false);
          }}
        >
          <TaskDrawerContent data-testid={MEMBER_ACTIONS_SHEET_TESTID}>
            <TaskSurfaceBody>

            {sheetConfirmingRemove ? (
              <div className="px-4 pt-2">
                <DrawerTitle className="text-[17px] leading-[22px]">
                  {memberRemoveConfirmTitle(displayName)}
                </DrawerTitle>
                <DrawerDescription className="mt-1 text-[15px] leading-5 text-[color:var(--app-secondary-label)]">
                  {memberRemoveConfirmDescription(displayName)}
                </DrawerDescription>
                <div
                  className={cn(
                    "mt-4 flex flex-col gap-2",
                    MEMBER_ACTIONS_SHEET_CTA_CLASSNAME,
                  )}
                >
                  <Button
                    type="button"
                    variant="destructive"
                    size="prominent"
                    className={MEMBER_REMOVE_CONFIRM_CLASSNAME}
                    onClick={() => {
                      closeSheet();
                      void onRemove();
                    }}
                  >
                    Remove
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="prominent"
                    className="w-full text-foreground"
                    onClick={() => setSheetConfirmingRemove(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="pt-2">
                {/* Whose actions these are, said outright. The anchored menu
                    left this to proximity, and proximity is the one thing a
                    roster of near-identical rows cannot carry. */}
                <div className="flex items-center gap-3 pb-2">
                  <ConnectionPersonAvatar personRef={resolvePersonRefFromProfilePathname(profileHref)}
                    label={displayName}
                    photoUrl={photoUrl}
                    verified={verified}
                    className="h-12 w-12"
                  />
                  <div className="min-w-0 flex-1 text-left">
                    <DrawerTitle className="whitespace-normal [overflow-wrap:anywhere]">
                      {displayName}
                    </DrawerTitle>
                    <DrawerDescription className="mt-1 whitespace-normal [overflow-wrap:anywhere]">
                      {secondaryLine ?? "Circle member"}
                    </DrawerDescription>
                  </div>
                  {canShare ? (
                    <Button
                      type="button"
                      size="icon-touch"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Share location with ${displayName}`}
                      className="shrink-0 focus-visible:ring-[3px] focus-visible:ring-[color:var(--app-focus-ring)]"
                      onClick={() => {
                        closeSheet();
                        onShare();
                      }}
                    >
                      <ProfilePaneShareIcon className="size-5" aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>

                {profileHref || messageHref ? (
                  <div
                    role="menu"
                    aria-label={menuLabel}
                    className={cn("w-full overflow-hidden border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]", LOCATION_ACTION_SHAPE)}
                  >
                  {profileHref ? (
                    <PersonProfileLink
                      href={profileHref}
                      role="menuitem"
                      className={MEMBER_ACTIONS_SHEET_ITEM_CLASSNAME}
                      data-testid="circle-member-view-profile"
                    >
                      <UserRound
                        className="h-5 w-5 shrink-0 text-[color:var(--app-secondary-label)]"
                        aria-hidden="true"
                      />
                      View profile
                    </PersonProfileLink>
                  ) : null}
                  {profileHref && messageHref ? (
                    <div aria-hidden="true" className="ml-[52px] h-px bg-[color:var(--app-separator)]" />
                  ) : null}
                  {messageHref ? (
                    <DirectMessageLink
                      href={messageHref}
                      role="menuitem"
                      className={MEMBER_ACTIONS_SHEET_ITEM_CLASSNAME}
                      onClick={() => closeSheet()}
                      data-testid="circle-member-message"
                    >
                      <MessageCircle
                        className="h-5 w-5 shrink-0 text-[color:var(--app-secondary-label)]"
                        aria-hidden="true"
                      />
                      Message
                    </DirectMessageLink>
                  ) : null}
                  </div>
                ) : null}

                <div
                  className={cn(
                    "mt-1 flex flex-col gap-0",
                    MEMBER_ACTIONS_SHEET_CTA_CLASSNAME,
                  )}
                >
                  {canRemove ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="prominent"
                      disabled={busy}
                      className="w-full justify-center text-[color:var(--app-destructive)] hover:bg-transparent hover:text-[color:var(--app-destructive)]"
                      onClick={() => setSheetConfirmingRemove(true)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                      Remove from Circle
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="prominent"
                    className={cn(
                      "h-[52px] min-h-[52px] w-full justify-center bg-[#F2F2F7] text-center text-[17px] font-medium text-[color:var(--app-accent-deep)] shadow-none [--type-button-label-weight:500] hover:bg-[#E5E5EA]",
                      LOCATION_ACTION_SHAPE,
                    )}
                    onClick={closeSheet}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            </TaskSurfaceBody>
          </TaskDrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={busy}
            aria-label={menuLabel}
            className={CIRCLE_MEMBER_MENU_TRIGGER_CLASSNAME}
          >
            <MoreVertical size={24} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-profile-type-scale="circles"
          data-testid={MEMBER_ACTIONS_MENU_TESTID}
          aria-label={menuLabel}
          side={CIRCLE_MEMBER_ACTIONS_MENU_SIDE}
          align={CIRCLE_MEMBER_ACTIONS_MENU_ALIGN}
          sideOffset={CIRCLE_MEMBER_ACTIONS_MENU_SIDE_OFFSET_PX}
          collisionPadding={CIRCLE_MEMBER_ACTIONS_MENU_COLLISION_PADDING_PX}
          className={MEMBER_ACTIONS_MENU_SURFACE_CLASSNAME}
        >
          {messageHref ? (
            <DropdownMenuItem asChild className={MEMBER_ACTIONS_MENU_ITEM_CLASSNAME}>
              <DirectMessageLink href={messageHref} data-testid="circle-member-message">
                <MessageCircle className="h-4 w-4 text-current" />
                Message
              </DirectMessageLink>
            </DropdownMenuItem>
          ) : null}
          {canShare ? (
            <DropdownMenuItem
              className={MEMBER_ACTIONS_MENU_ITEM_CLASSNAME}
              onSelect={() => onShare()}
            >
              <ProfilePaneShareIcon className="h-4 w-4" />
              Share location
            </DropdownMenuItem>
          ) : null}
          {canRemove ? (
            <DropdownMenuItem
              variant="destructive"
              className={MEMBER_ACTIONS_MENU_ITEM_CLASSNAME}
              onSelect={(event) => {
                // `preventDefault` stops Radix's own close-and-restore-focus
                // so that close cannot race the dialog's entrance; the menu is
                // then closed explicitly on the next line. Before this, the
                // menu was left OPEN behind the confirm dialog -- two stacked
                // surfaces for one decision.
                event.preventDefault();
                setMenuOpen(false);
                setConfirmRemoveOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
              Remove from Circle
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {canRemove ? (
        <AlertDialog
          open={confirmRemoveOpen}
          onOpenChange={setConfirmRemoveOpen}
        >
          <TaskAlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {memberRemoveConfirmTitle(displayName)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {memberRemoveConfirmDescription(displayName)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="prominent" className="w-full">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                size="prominent"
                onClick={() => void onRemove()}
                className={MEMBER_REMOVE_CONFIRM_CLASSNAME}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </TaskAlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
