"use client";

/**
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
 *   desktop (>=640px)  the anchored menu, restyled onto the app's surface
 *                      grammar and headed by the same name. A cursor makes
 *                      the anchor unambiguous, and a bottom sheet on a
 *                      1440px window is the wrong trade in the other
 *                      direction.
 *
 * 640px is the same boundary `save-location-sheet-layout.ts` switches its own
 * sheet on, and the same one Tailwind's `sm:` uses -- restated here rather
 * than imported, because that constant documents an onboarding modal's
 * geometry and this one is free to move without dragging that surface along.
 *
 * ## Visual Map
 *
 *   phone                                desktop
 *   +--------------------------+         roster row          [...]
 *   | Ankit Kumar Singh  [...] |                               |
 *   | JHUMMA KUMARI      [...] |                               v
 *   +==========================+                  +---------------------+
 *   |           ====           |                  | Ankit Kumar Singh   |
 *   |  (AK)  Ankit Kumar Singh |                  +---------------------+
 *   |        Connected         |                  | (>) Share location  |
 *   |  +--------------------+  |                  | (X) Remove from ... |
 *   |  | (>) Share location |  |                  +---------------------+
 *   |  | (X) Remove from .. |  |
 *   |  +--------------------+  |
 *   |  |       Cancel       |  |
 *   +--------------------------+
 */

import { useState, useSyncExternalStore } from "react";
import { MoreVertical, Share2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CIRCLE_MEMBER_MENU_CLASSNAME } from "@/components/one-location/redesign/circles/circle-member-row-layout";
import { cn } from "@/lib/utils";

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
  "min-w-[13.5rem] rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] p-1 text-[color:var(--app-primary-label)] shadow-[var(--app-card-shadow-standard)] dark:shadow-none";

/**
 * One row of the anchored menu.
 *
 * `min-h-11` -- 44px, the platform touch minimum -- rather than the
 * primitive's `py-1.5`, which lands a 15px label in a 30px row. Two 30px rows
 * is the other half of the report: the actions were cramped AND unlabelled as
 * to owner.
 */
export const MEMBER_ACTIONS_MENU_ITEM_CLASSNAME =
  "flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-[15px] font-normal leading-5 focus:bg-[color:var(--app-neutral-fill)] dark:focus:bg-[color:var(--app-neutral-fill-strong)]";

/** One row of the bottom sheet's action list. 56px, full bleed, so the whole
 *  width of the row is the target rather than the label alone. */
export const MEMBER_ACTIONS_SHEET_ITEM_CLASSNAME =
  "flex min-h-14 w-full items-center gap-3 px-4 text-left text-[17px] font-normal leading-[22px] transition-colors active:bg-[color:var(--app-neutral-fill)] disabled:opacity-60";

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

  const hasMenu = canShare || canRemove;
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
          aria-haspopup="menu"
          aria-expanded={sheetOpen}
          className={CIRCLE_MEMBER_MENU_CLASSNAME}
          onClick={() => {
            setSheetConfirmingRemove(false);
            setSheetOpen(true);
          }}
        >
          <MoreVertical className="h-5 w-5" />
        </Button>

        <Drawer
          open={sheetOpen}
          onOpenChange={(next) => {
            setSheetOpen(next);
            if (!next) setSheetConfirmingRemove(false);
          }}
        >
          <DrawerContent
            data-testid={MEMBER_ACTIONS_SHEET_TESTID}
            className="rounded-t-[20px] pb-[max(12px,env(safe-area-inset-bottom))]"
          >
            {sheetConfirmingRemove ? (
              <div className="px-4 pt-2">
                <DrawerTitle className="text-[17px] leading-[22px]">
                  {memberRemoveConfirmTitle(displayName)}
                </DrawerTitle>
                <DrawerDescription className="mt-1 text-[15px] leading-5 text-[color:var(--app-secondary-label)]">
                  {memberRemoveConfirmDescription(displayName)}
                </DrawerDescription>
                <div className="mt-4 flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    className="h-12 w-full rounded-[14px] text-[17px] font-semibold"
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
                    className="h-12 w-full rounded-[14px] text-[17px] font-semibold"
                    onClick={() => setSheetConfirmingRemove(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="px-4 pt-1">
                {/* Whose actions these are, said outright. The anchored menu
                    left this to proximity, and proximity is the one thing a
                    roster of near-identical rows cannot carry. */}
                <div className="flex items-center gap-3 pb-3">
                  <ConnectionPersonAvatar
                    label={displayName}
                    photoUrl={photoUrl}
                    verified={verified}
                    className="h-11 w-11"
                  />
                  <div className="min-w-0 flex-1 text-left">
                    <DrawerTitle className="truncate text-[17px] leading-[22px]">
                      {displayName}
                    </DrawerTitle>
                    <DrawerDescription className="truncate text-[13px] leading-4 text-[color:var(--app-secondary-label)]">
                      {secondaryLine ?? "Circle member"}
                    </DrawerDescription>
                  </div>
                </div>

                <div
                  role="menu"
                  aria-label={menuLabel}
                  className="overflow-hidden rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)]"
                >
                  {canShare ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      className={MEMBER_ACTIONS_SHEET_ITEM_CLASSNAME}
                      onClick={() => {
                        closeSheet();
                        onShare();
                      }}
                    >
                      <Share2
                        className="h-5 w-5 shrink-0 text-[color:var(--app-secondary-label)]"
                        aria-hidden="true"
                      />
                      Share location
                    </button>
                  ) : null}
                  {canShare && canRemove ? (
                    // Inset from the icon column, the way a grouped iOS list
                    // separates rows -- a full-bleed rule reads as the end of
                    // the group rather than a divider inside it.
                    <div
                      aria-hidden="true"
                      className="ml-[52px] h-px bg-[color:var(--app-separator)]"
                    />
                  ) : null}
                  {canRemove ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      className={cn(
                        MEMBER_ACTIONS_SHEET_ITEM_CLASSNAME,
                        "text-destructive",
                      )}
                      onClick={() => setSheetConfirmingRemove(true)}
                    >
                      <Trash2 className="h-5 w-5 shrink-0" aria-hidden="true" />
                      Remove from Circle
                    </button>
                  ) : null}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  className="mt-2 h-12 w-full rounded-[14px] text-[17px] font-semibold"
                  onClick={closeSheet}
                >
                  Cancel
                </Button>
              </div>
            )}
          </DrawerContent>
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
            className={CIRCLE_MEMBER_MENU_CLASSNAME}
          >
            <MoreVertical className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          data-testid={MEMBER_ACTIONS_MENU_TESTID}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className={MEMBER_ACTIONS_MENU_SURFACE_CLASSNAME}
        >
          {/* Same job as the sheet's header: name the person, so a menu that
              paints over the next row still says who it belongs to. */}
          <p className="truncate px-3 pt-1.5 pb-1 text-[13px] font-semibold leading-4 text-[color:var(--app-secondary-label)]">
            {displayName}
          </p>
          <div
            aria-hidden="true"
            className="mx-1 mb-1 h-px bg-[color:var(--app-separator)]"
          />
          {canShare ? (
            <DropdownMenuItem
              className={MEMBER_ACTIONS_MENU_ITEM_CLASSNAME}
              onSelect={() => onShare()}
            >
              <Share2 className="h-4 w-4 text-current" />
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
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {memberRemoveConfirmTitle(displayName)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {memberRemoveConfirmDescription(displayName)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => void onRemove()}
                className="h-11 w-full sm:w-auto"
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
