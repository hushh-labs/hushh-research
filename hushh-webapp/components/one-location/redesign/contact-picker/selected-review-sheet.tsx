"use client";

import { useMemo, useState } from "react";
import { Loader2, UsersRound } from "lucide-react";

import { ContactSourceBadge } from "@/components/connections/contact-source-badge";
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
 * The selection summary, and the sheet it opens.
 *
 * Selection used to be readable only by scrolling the whole screen and
 * counting the rows wearing a Remove button -- across two sections, and soon
 * across two tabs. The pill answers "who is on this list" before the tabs are
 * reached, and the sheet is where that answer gets edited.
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
  // "0 people added" sitting under the title of a screen whose whole job is to
  // stop being 0.
  if (count <= 0) return null;
  return (
    // Reads as part of the header block: who is already on the list, answered
    // once on the way down into the tabs. Floating it over the bottom of the
    // screen instead meant that on a list short enough not to scroll it came to
    // rest on top of the first contact row.
    <div className="mt-6 flex justify-center px-4">
      <button
        type="button"
        onClick={onOpen}
        data-testid="sms-selected-pill"
        aria-label={"Review " + peoplePillLabel(count)}
        className="press-scale flex h-11 max-w-full items-center gap-2 rounded-full bg-[color:var(--app-accent)] px-5 text-[15px] font-semibold text-[color:var(--app-accent-fg)] shadow-[var(--app-card-shadow-standard)] dark:shadow-none"
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
          <DrawerDescription className="text-[15px] leading-5 text-[color:var(--app-secondary-label)]">
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
                    <ContactAvatar
                      label={label}
                      photoUrl={recipient.photoUrl}
                      verified={Boolean(recipient.isRia)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-start gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[17px] font-normal leading-[22px] text-foreground">
                          {label}
                        </span>
                        {recipient.connectedFromContacts ? (
                          <ContactSourceBadge className="mt-px shrink-0" />
                        ) : null}
                      </span>
                      {subtitle ? (
                        <span className="mt-0.5 block truncate text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
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
