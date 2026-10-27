"use client";

import { useEffect, useRef, useState } from "react";
import { NativeActionMenu } from "./native-action-menu";
import { nativeOwnedChoicesEnabled } from "@/lib/capacitor/native-presentation-policy";
import { plainChoiceText } from "@/lib/capacitor/native-choice-items";
import type { ReactNode } from "react";
import type { LucideIcon } from "@/components/icons";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/**
 * A section's "+" and the short list of things it can add.
 *
 * QA, three times, on three sections: "yeh + wala button open jab ho raha hai
 * tab neeche aa raha hai dusre tab pe". A dropdown anchored under a "+" that
 * sits at the top-right of a section opens straight down ONTO that section's
 * own list -- so "Create Circle / Join with code" landed on top of the Circles
 * rows, and it stopped being obvious which section the menu even belonged to.
 * On a phone it also puts the choices at the top of the screen, furthest from
 * the thumb that just tapped the button.
 *
 * So the surface follows the platform instead of the anchor:
 *
 *   phone   a sheet from the bottom, titled with the section it acts on. It
 *           covers nothing the reader was mid-way through, it is where the
 *           thumb already is, and the title says what these actions are for.
 *   desktop the anchored menu, which is correct there -- a pointer is already
 *           at the trigger and there is room beside the list.
 *
 * The presentation is frozen while the menu is open, for the same reason
 * `SaveLocationModal` freezes its own: swapping Sheet for DropdownMenu swaps
 * the parent element, React remounts everything inside, and a rotation
 * mid-choice would tear the menu down under the hand using it.
 */
export type ActionMenuItem = {
  /** Stable key. Also the test id, as `${testId}-item-${id}`. */
  id: string;
  label: ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Marks the row busy without unmounting it, so a repeat tap is refused
   *  rather than queued -- single-flight, visibly. */
  busy?: boolean;
  voiceControlId?: string;
  voiceActionId?: string;
};

const ITEM_CLASSNAME =
  "flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 text-[15px] font-normal leading-5 text-[color:var(--app-primary-label)] hover:bg-[color:var(--app-neutral-fill)] hover:text-[color:var(--app-primary-label)] focus:!bg-[color:var(--app-neutral-fill)] focus:!text-[color:var(--app-primary-label)] data-[highlighted]:!bg-[color:var(--app-neutral-fill)] data-[highlighted]:!text-[color:var(--app-primary-label)] dark:hover:bg-[color:var(--app-neutral-fill-strong)] dark:focus:!bg-[color:var(--app-neutral-fill-strong)] dark:data-[highlighted]:!bg-[color:var(--app-neutral-fill-strong)] disabled:text-[color:var(--app-tertiary-label)] disabled:opacity-45 data-[disabled]:!text-[color:var(--app-tertiary-label)] data-[disabled]:opacity-45 focus:[&_svg]:!text-[color:var(--app-secondary-label)] data-[highlighted]:[&_svg]:!text-[color:var(--app-secondary-label)]";

function WebActionMenu({
  label,
  title,
  showMobileTitle = true,
  items,
  triggerIcon: TriggerIcon,
  trigger: customTrigger,
  testId,
  contentClassName,
  profileTypeScale,
  nativePresentation: _nativePresentation,
  initialOpen = false,
}: {
  /** The trigger's accessible name, e.g. "Add Circle". */
  label: string;
  /** The sheet's heading on a phone. Defaults to `label`. */
  title?: string;
  /** Keep the sheet named for assistive technology while hiding its visual
   * heading when the surrounding mobile screen already supplies the context. */
  showMobileTitle?: boolean;
  items: ActionMenuItem[];
  triggerIcon?: LucideIcon;
  trigger?: ReactNode;
  testId?: string;
  contentClassName?: string;
  /** Explicit typography scope for portaled controls. */
  profileTypeScale?: string;
  /** Explicit author admission: only stationary public labels, never a person,
   * protected record, credential, or arbitrary rich React label. */
  nativePresentation?: { owner: string | null; context: string };
  initialOpen?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(initialOpen);
  // Frozen for the lifetime of one opening. See the note above.
  const [sheetPresentation, setSheetPresentation] = useState(isMobile);
  useEffect(() => {
    if (!open) setSheetPresentation(isMobile);
  }, [isMobile, open]);

  const trigger = customTrigger ?? (
    <Button
      ref={triggerRef}
      type="button"
      size="icon"
      variant="ghost"
      aria-label={label}
      data-testid={testId}
      className="h-11 w-11 rounded-full text-[color:var(--app-accent)] hover:bg-[color:var(--app-neutral-fill)] hover:text-[color:var(--app-accent-hover)]"
    >
      {TriggerIcon ? (
        <TriggerIcon className="h-[21px] w-[21px]" aria-hidden="true" />
      ) : (
        label
      )}
    </Button>
  );
  const presentedTrigger = trigger;

  if (sheetPresentation) {
    return (
      <>
        <span onClick={() => setOpen(true)}>{presentedTrigger}</span>
        <Sheet open={open} onOpenChange={setOpen} modal>
          <SheetContent data-profile-type-scale={profileTypeScale}
            side="bottom"
            showCloseButton={false}
            data-testid={testId ? `${testId}-sheet` : undefined}
            className="gap-0 rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2"
          >
            {showMobileTitle ? (
              <SheetHeader className="px-1 pb-2 pt-1 text-left">
                <SheetTitle className="text-[15px] font-medium leading-5 text-[color:var(--app-secondary-label)]">
                  {title ?? label}
                </SheetTitle>
              </SheetHeader>
            ) : (
              <SheetTitle className="sr-only">{title ?? label}</SheetTitle>
            )}
            <SheetDescription className="sr-only">
              Choose an action for {title ?? label}.
            </SheetDescription>
            <div className="space-y-1">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled || item.busy}
                    aria-busy={item.busy || undefined}
                    data-voice-control-id={item.voiceControlId}
                    data-testid={
                      testId ? `${testId}-item-${item.id}` : undefined
                    }
                    onClick={() => {
                      if (item.disabled || item.busy) return;
                      setOpen(false);
                      item.onSelect();
                    }}
                    className={cn(
                      ITEM_CLASSNAME,
                      "text-left disabled:opacity-50",
                    )}
                  >
                    {Icon ? (
                      <Icon
                        className={cn("h-4 w-4 shrink-0 text-[color:var(--app-secondary-label)]", item.iconClassName)}
                        aria-hidden="true"
                      />
                    ) : null}
                    {item.label}
                  </button>
                );
              })}
            </div>
            {/* An explicit way out. A sheet a thumb opened by accident should
                not need a reach to the scrim at the top of the screen. */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-2 min-h-11 w-full rounded-[10px] text-[15px] font-medium text-[color:var(--app-secondary-label)]"
            >
              Cancel
            </button>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    // Deliberately UNCONTROLLED, with only a callback for the freeze above.
    // Passing `open` puts a React state round-trip between the keypress and
    // the menu appearing; Radix otherwise opens inside the same event. A test
    // that presses Enter and reads the menu on the next line then fails under
    // load while passing in isolation -- which is exactly what it did.
    <DropdownMenu defaultOpen={initialOpen} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{presentedTrigger}</DropdownMenuTrigger>
      <DropdownMenuContent data-profile-type-scale={profileTypeScale}
        align="end"
        forceMount
        data-testid={testId ? `${testId}-menu` : undefined}
        className={cn(
          "min-w-52 rounded-2xl border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] p-1.5 shadow-[var(--app-card-shadow-standard)] dark:shadow-none",
          contentClassName,
        )}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              key={item.id}
              disabled={item.disabled || item.busy}
              aria-busy={item.busy || undefined}
              data-voice-control-id={item.voiceControlId}
              data-voice-action-id={item.voiceActionId}
              data-testid={testId ? `${testId}-item-${item.id}` : undefined}
              onSelect={(event) => {
                if (item.disabled || item.busy) {
                  event.preventDefault();
                  return;
                }
                item.onSelect();
              }}
              className={ITEM_CLASSNAME}
            >
              {Icon ? (
                <Icon
                  className={cn("h-4 w-4 shrink-0 text-[color:var(--app-secondary-label)]", item.iconClassName)}
                  aria-hidden="true"
                />
              ) : null}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


/** Renderer is selected for the popup family, not for each screen or click.
 * Trigger geometry/artwork stays authored; only the complete popup is native. */
export function ActionMenu(props: Parameters<typeof WebActionMenu>[0]) {
  const [native] = useState(() => nativeOwnedChoicesEnabled() && props.items.length > 0 &&
    props.items.length <= 256 && props.items.every(item => {
      const label = plainChoiceText(item.label)?.trim();
      return item.id.length > 0 && item.id.length <= 128 && label && label.length <= 256;
    }) && new Set(props.items.map(item => item.id)).size === props.items.length);
  return native ? <NativeActionMenu {...props} webFallback={open => <WebActionMenu {...props} initialOpen={open} />} /> : <WebActionMenu {...props} />;
}
