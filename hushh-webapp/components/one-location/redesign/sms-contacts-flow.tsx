"use client";

import { useCallback, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type {
  OneLocationCircleSummary,
  OneLocationRecipient,
} from "@/lib/one-location/types";
import type { CircleRecipientSelection } from "@/lib/one-location/circle-recipient-selection";
import { TaskFlowHeader } from "@/components/one-location/redesign/primitives";
import {
  CONTACT_AVATAR_TONE,
  ContactGroup,
  ContactRow,
  EmptyStateCard,
  initials,
} from "@/components/one-location/redesign/contact-picker/atoms";
import { CircleMemberPicker } from "@/components/one-location/redesign/contact-picker/circle-member-picker";
import { ContactListControls } from "@/components/one-location/redesign/contact-picker/list-controls";
import {
  SelectedContactsPill,
  SelectedContactsSheet,
} from "@/components/one-location/redesign/contact-picker/selected-review-sheet";
import { VirtualContactList } from "@/components/one-location/redesign/contact-picker/virtual-list";
import {
  filterByContactQuery,
  sortByContactMode,
  type ContactSortMode,
} from "@/lib/one-location/contact-picker-controls";

type SmsContactsTab = "circles" | "all-contacts";

const TABS: ReadonlyArray<{ value: SmsContactsTab; label: string }> = [
  { value: "circles", label: "Circles" },
  { value: "all-contacts", label: "All Contacts" },
];

type SmsContactsFlowProps = {
  recipients: OneLocationRecipient[];
  circles: OneLocationCircleSummary[];
  selectedUserIds: string[];
  busyKey: string | null;
  onAdd: (recipientUserId: string) => void;
  /**
   * Commit a hand-picked subset of one Circle's members in a single pass.
   *
   * Replaces the old all-or-nothing `onAddCircle`. The picker resolves the
   * roster itself and hands back exactly the people who were ticked, so a
   * hundred-member Circle can contribute four contacts.
   */
  onAddCircleMembers: (circleId: string, userIds: string[]) => Promise<void>;
  /** Resolves a Circle into its SMS-ready members, lazily, on expand. */
  onLoadCircleMembers: (circleId: string) => Promise<CircleRecipientSelection>;
  onRemove: (recipientUserId: string) => Promise<boolean>;
  recipientLabel: (recipient: OneLocationRecipient) => string;
  recipientSubtitle: (recipient: OneLocationRecipient) => string;
  isRecipientShareReady: (recipient: OneLocationRecipient) => boolean;
};

/**
 * Who receives your emergency SMS.
 *
 * Two tabs, one selection. "Circles" is a roster of Circles that each expand
 * into their own member picker; "All Contacts" is the flat directory. Both
 * write to the same list, and the sticky pill above the bottom bar is how that
 * list stays readable from either of them -- previously the only way to see
 * who was on it was to scroll the whole screen counting rows wearing a Remove
 * button.
 *
 * Selection commits as it happens rather than staging behind a submit: this
 * screen has never had one, and a contact roster that silently discards edits
 * when you navigate away would be a worse trade than the one extra request.
 * The pill therefore counts what is actually saved, which is why it reads
 * "added" and not "selected".
 */
export function SmsContactsFlow({
  recipients,
  circles,
  selectedUserIds,
  busyKey,
  onAdd,
  onAddCircleMembers,
  onLoadCircleMembers,
  onRemove,
  recipientLabel,
  recipientSubtitle,
  isRecipientShareReady,
}: SmsContactsFlowProps) {
  // Circles first, as the issue orders them -- unless there are none, in
  // which case landing on an empty tab makes the screen look broken before
  // the person has done anything.
  const [tab, setTab] = useState<SmsContactsTab>(() =>
    circles.length ? "circles" : "all-contacts",
  );
  const [pendingRemoval, setPendingRemoval] =
    useState<OneLocationRecipient | null>(null);
  const [removing, setRemoving] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [expandedCircleId, setExpandedCircleId] = useState<string | null>(null);

  const [circleQuery, setCircleQuery] = useState("");
  const [circleSort, setCircleSort] = useState<ContactSortMode>("default");
  const [contactQuery, setContactQuery] = useState("");
  const [contactSort, setContactSort] = useState<ContactSortMode>("default");

  const selectedIds = useMemo(
    () => new Set(selectedUserIds),
    [selectedUserIds],
  );
  const selected = useMemo(
    () => recipients.filter((recipient) => selectedIds.has(recipient.userId)),
    [recipients, selectedIds],
  );

  const visibleCircles = useMemo(
    () =>
      sortByContactMode(
        filterByContactQuery(circles, circleQuery, (circle) => circle.name),
        circleSort,
        (circle) => circle.name,
      ),
    [circleQuery, circleSort, circles],
  );

  const visibleContacts = useMemo(
    () =>
      sortByContactMode(
        filterByContactQuery(recipients, contactQuery, recipientLabel),
        contactSort,
        recipientLabel,
      ),
    [contactQuery, contactSort, recipientLabel, recipients],
  );

  const removePending = async () => {
    if (!pendingRemoval || removing) return;
    setRemoving(true);
    try {
      const removed = await onRemove(pendingRemoval.userId);
      if (removed) setPendingRemoval(null);
    } finally {
      setRemoving(false);
    }
  };

  const askRemoveById = useCallback(
    (recipientUserId: string) => {
      const recipient = recipients.find(
        (candidate) => candidate.userId === recipientUserId,
      );
      if (recipient) setPendingRemoval(recipient);
    },
    [recipients],
  );

  // The picker only ever passes ids it resolved from that Circle, so this is a
  // pass-through -- but keeping it a stable callback means expanding a Circle
  // does not re-run its roster effect on every parent render.
  const addCircleMembers = useCallback(
    (circleId: string, userIds: string[]) =>
      onAddCircleMembers(circleId, userIds),
    [onAddCircleMembers],
  );

  return (
    // Renders inside the signed-in shell like every other Location task flow,
    // so the top bar keeps the single back control, the
    // "Location > SMS contacts" trail and the profile avatar.
    <section data-testid="sms-contacts-screen">
      {/* 430px is a phone, not a layout. Held at every width it left most of a
          tablet or a desktop window as empty grey while the lists below scrolled
          inside a narrow ribbon. The column grows with the viewport instead, and
          stops at 960px so the rows never stretch into unreadable full-bleed
          lines. */}
      <div className="mx-auto w-full max-w-[430px] md:max-w-[680px] xl:max-w-[720px]">
        <TaskFlowHeader
          title="SMS contacts"
          description="Emergency contacts."
        />

        {/* Two sections, named for what they hold. "Add contacts" described the
            button on each row rather than the list, which left the screen with
            a "Contacts" list and an "Add contacts" list that were the same
            people in two states. */}
        <div
          role="tablist"
          aria-label="Contact sources"
          className="mt-6 flex gap-1.5 rounded-full bg-[color:var(--app-neutral-fill-strong)] p-1"
        >
          {TABS.map((entry) => {
            const active = entry.value === tab;
            return (
              <button
                key={entry.value}
                type="button"
                role="tab"
                id={"sms-tab-" + entry.value}
                aria-selected={active}
                aria-controls={"sms-panel-" + entry.value}
                onClick={() => setTab(entry.value)}
                className={cn(
                  "press-scale h-10 flex-1 rounded-full text-[15px] font-semibold transition-colors",
                  active
                    ? "bg-[color:var(--app-card-surface-default-solid)] text-foreground shadow-sm"
                    : "text-muted-foreground",
                )}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4">
          {tab === "circles" ? (
            <div
              role="tabpanel"
              id="sms-panel-circles"
              aria-labelledby="sms-tab-circles"
              data-testid="sms-circles-panel"
            >
              <ContactListControls
                sourceCount={circles.length}
                query={circleQuery}
                onQueryChange={setCircleQuery}
                sortMode={circleSort}
                onSortModeChange={setCircleSort}
                placeholder="Search Circles"
                resultCount={visibleCircles.length}
                voiceControlId="one-location-sms-circle-search"
              />
              {visibleCircles.length ? (
                <ContactGroup>
                  {visibleCircles.map((circle, index) => (
                    <div
                      key={circle.id}
                      className={cn(
                        index < visibleCircles.length - 1 &&
                          "border-b border-[color:var(--app-separator)]",
                      )}
                    >
                      <CircleMemberPicker
                        circle={circle}
                        expanded={expandedCircleId === circle.id}
                        onToggle={() =>
                          setExpandedCircleId((current) =>
                            current === circle.id ? null : circle.id,
                          )
                        }
                        selectedUserIds={selectedIds}
                        busy={Boolean(busyKey)}
                        onLoadMembers={onLoadCircleMembers}
                        onAddMembers={addCircleMembers}
                        recipientLabel={(person) =>
                          recipientLabel(person as OneLocationRecipient)
                        }
                      />
                    </div>
                  ))}
                </ContactGroup>
              ) : (
                <EmptyStateCard
                  message={
                    circleQuery.trim()
                      ? "No Circles match that name."
                      : "No Circles yet."
                  }
                />
              )}
              {/* Growing a Circle deliberately does NOT live here. This screen
                  answers one question -- who gets the alert -- and a per-Circle
                  "Invite people / Share code" block for every Circle pushed that
                  list below the fold and mixed a membership task into a
                  contact-picking one. Growing a Circle stays on the People tab,
                  which owns membership. */}
            </div>
          ) : (
            <div
              role="tabpanel"
              id="sms-panel-all-contacts"
              aria-labelledby="sms-tab-all-contacts"
              data-testid="sms-all-contacts-panel"
            >
              <ContactListControls
                sourceCount={recipients.length}
                query={contactQuery}
                onQueryChange={setContactQuery}
                sortMode={contactSort}
                onSortModeChange={setContactSort}
                placeholder="Search contacts"
                resultCount={visibleContacts.length}
                voiceControlId="one-location-sms-contact-search"
              />
              {visibleContacts.length ? (
                <VirtualContactList
                  items={visibleContacts}
                  getKey={(recipient) => recipient.userId}
                  testId="sms-all-contacts-list"
                  ariaLabel="All contacts"
                  renderItem={(recipient) => {
                    const label = recipientLabel(recipient);
                    return (
                      <ContactRow
                        label={label}
                        subtitle={recipientSubtitle(recipient)}
                        selected={selectedIds.has(recipient.userId)}
                        ready={isRecipientShareReady(recipient)}
                        busy={busyKey === "sms-contact:" + recipient.userId}
                        onAdd={() => onAdd(recipient.userId)}
                        onRemove={() => setPendingRemoval(recipient)}
                      />
                    );
                  }}
                />
              ) : (
                <EmptyStateCard
                  message={
                    contactQuery.trim()
                      ? "No contacts match that name."
                      : "No contacts yet."
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>

      <SelectedContactsPill
        count={selected.length}
        onOpen={() => setReviewOpen(true)}
      />

      <SelectedContactsSheet
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        recipients={selected}
        busyUserId={
          busyKey?.startsWith("sms-contact:")
            ? busyKey.slice("sms-contact:".length)
            : null
        }
        onRemove={askRemoveById}
        recipientLabel={recipientLabel}
        recipientSubtitle={recipientSubtitle}
      />

      <AlertDialog
        open={Boolean(pendingRemoval)}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        {/* A sheet that rises from the thumb is right on a phone and odd on a
            desktop, where it lands far from the row that opened it and from the
            pointer. Base classes stay exactly as they were -- the phone case is
            the tested one -- and only wider viewports re-centre it. */}
        <AlertDialogContent
          size="sm"
          className="!bottom-0 !left-1/2 !top-auto !w-full !max-w-[430px] !-translate-x-1/2 !translate-y-0 !gap-0 !rounded-b-none !rounded-t-[24px] !border-0 !bg-[color:var(--app-card-surface-default-solid)] !px-4 !pb-[max(20px,env(safe-area-inset-bottom))] !pt-5 !shadow-none md:!bottom-auto md:!top-1/2 md:!max-w-[400px] md:!-translate-y-1/2 md:!rounded-b-[24px] md:!pb-5 md:!shadow-xl"
        >
          <AlertDialogHeader className="!place-items-center !text-center sm:!place-items-center sm:!text-center">
            {/* The person being removed, not a warning about them. A solid
                orange well read as "attention" on a face, and white on
                --app-warning measures ~2.2:1. The danger in this dialog is
                carried by the red Remove button and the title copy. */}
            <span
              className={cn(
                "flex h-[52px] w-[52px] items-center justify-center rounded-[16px] text-xl font-semibold",
                CONTACT_AVATAR_TONE,
              )}
              aria-hidden
            >
              {pendingRemoval ? initials(recipientLabel(pendingRemoval)) : "?"}
            </span>
            <AlertDialogTitle className="mt-1 !text-center !text-[20px] !font-semibold !leading-[25px] !tracking-normal">
              <span className="text-foreground">
                Remove{" "}
                {pendingRemoval
                  ? `${recipientLabel(pendingRemoval).split(/\s+/)[0]}?`
                  : "contact?"}
              </span>
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-1 !max-w-[290px] !text-center !text-[15px] !leading-5 !text-muted-foreground">
              They won&apos;t receive SMS alerts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-4 grid gap-2">
            <AlertDialogAction
              variant="destructive"
              disabled={removing}
              onClick={(event) => {
                event.preventDefault();
                void removePending();
              }}
              className="!h-12 !rounded-full !bg-[color:var(--app-destructive)] !text-[15px] !font-semibold !text-[color:var(--app-destructive-fg)] hover:!bg-[color:var(--app-destructive)]/90 disabled:!opacity-60"
            >
              {removing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
            <AlertDialogCancel
              variant="secondary"
              disabled={removing}
              className="!mt-0 !h-12 !rounded-full !border-0 !bg-[color:var(--app-neutral-fill-strong)] !text-[15px] !font-semibold !text-foreground hover:!bg-[color:var(--app-neutral-fill-strong)]/80 disabled:!opacity-60"
            >
              Cancel
            </AlertDialogCancel>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
