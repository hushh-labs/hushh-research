"use client";

import { useMemo, useState } from "react";
import { Loader2, UsersRound } from "lucide-react";

import {
  ContactAvatar,
  EmptyStateCard,
} from "@/components/one-location/redesign/contact-picker/atoms";
import { ContactListControls } from "@/components/one-location/redesign/contact-picker/list-controls";
import { VirtualContactList } from "@/components/one-location/redesign/contact-picker/virtual-list";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  filterByContactQuery,
  peoplePillLabel,
  sortByContactMode,
  type ContactSortMode,
} from "@/lib/one-location/contact-picker-controls";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

/**
 * The sticky counter, and the sheet it opens.
 *
 * Selection used to be readable only by scrolling the whole screen and
 * counting the rows wearing a Remove button -- across two sections, and soon
 * across two tabs. The pill answers "who is on this list" from anywhere in the
 * flow, and the sheet is where that answer gets edited.
 *
 * Vaul's drawer rather than a dialog, because this is a review surface a thumb
 * should be able to drag away: it is not a decision, and dismissing it must
 * cost nothing.
 */

export function SelectedContactsPill({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  // Nothing selected, nothing to review. An empty pill would be a permanent
  // "0 people added" hovering over a screen whose whole job is to stop being 0.
  if (count <= 0) return null;
  return (
    // Sits above the app's own bottom chrome by reading the height the shell
    // publishes (`--bottom-chrome-full-height`, set in app-bottom-shell) rather
    // than guessing an offset that breaks the moment the nav changes height or
    // the keyboard opens.
    <div
      className="pointer-events-none sticky z-40 flex justify-center px-4"
      style={{
        bottom:
          "calc(var(--bottom-chrome-full-height, 0px) + var(--kb-height, 0px) + max(12px, env(safe-area-inset-bottom)))",
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        data-testid="sms-selected-pill"
        aria-label={"Review " + peoplePillLabel(count)}
        className="press-scale pointer-events-auto flex h-11 max-w-full items-center gap-2 rounded-full bg-[color:var(--app-accent)] px-5 text-[15px] font-semibold text-[color:var(--app-accent-fg)] shadow-lg"
      >
        <UsersRound className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{peoplePillLabel(count)}</span>
      </button>
    </div>
  );
}

export function SelectedContactsSheet({
  open,
  onOpenChange,
  recipients,
  busyUserId,
  onRemove,
  recipientLabel,
  recipientSubtitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipients: OneLocationRecipient[];
  busyUserId: string | null;
  onRemove: (recipientUserId: string) => void;
  recipientLabel: (recipient: OneLocationRecipient) => string;
  recipientSubtitle?: (recipient: OneLocationRecipient) => string;
}) {
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<ContactSortMode>("default");

  const visible = useMemo(
    () =>
      sortByContactMode(
        filterByContactQuery(recipients, query, recipientLabel),
        sortMode,
        recipientLabel,
      ),
    [query, recipientLabel, recipients, sortMode],
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[80vh]"
        data-testid="sms-selected-sheet"
        aria-describedby={undefined}
      >
        <DrawerHeader className="pb-2 text-left">
          <DrawerTitle className="text-[20px] font-semibold leading-[25px]">
            {peoplePillLabel(recipients.length)}
          </DrawerTitle>
          <DrawerDescription className="text-[15px] leading-5 text-muted-foreground">
            They receive your SMS alerts. Remove anyone who should not.
          </DrawerDescription>
        </DrawerHeader>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto px-4",
            "pb-[max(16px,env(safe-area-inset-bottom))]",
          )}
        >
          <ContactListControls
            sourceCount={recipients.length}
            query={query}
            onQueryChange={setQuery}
            sortMode={sortMode}
            onSortModeChange={setSortMode}
            placeholder="Search added people"
            resultCount={visible.length}
          />

          {visible.length ? (
            <VirtualContactList
              items={visible}
              getKey={(recipient) => recipient.userId}
              testId="sms-selected-sheet-list"
              ariaLabel="People added to SMS alerts"
              maxHeightClassName="max-h-[52vh]"
              renderItem={(recipient) => {
                const label = recipientLabel(recipient);
                const subtitle = recipientSubtitle?.(recipient);
                const busy = busyUserId === recipient.userId;
                return (
                  <div className="flex min-h-[58px] items-center gap-3 px-3.5 py-2">
                    <ContactAvatar label={label} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[17px] font-normal leading-[22px] text-foreground">
                        {label}
                      </span>
                      {subtitle ? (
                        <span className="mt-0.5 block truncate text-[13px] leading-4 text-muted-foreground">
                          {subtitle}
                        </span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemove(recipient.userId)}
                      disabled={busy}
                      aria-label={"Remove " + label}
                      className="press-scale flex h-8 min-w-[76px] items-center justify-center rounded-full bg-[color:var(--app-destructive-tint)] px-3 text-[13px] font-semibold text-[color:var(--app-destructive)] disabled:bg-[color:var(--app-neutral-fill-strong)] disabled:opacity-45"
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Remove"
                      )}
                    </button>
                  </div>
                );
              }}
            />
          ) : (
            <EmptyStateCard
              message={
                query.trim()
                  ? "No one added matches that name."
                  : "No one is added yet."
              }
            />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
