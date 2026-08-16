"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Loader2, UsersRound } from "lucide-react";

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
import { SECTION_HEADING } from "@/components/one-location/redesign/tokens";
import { TaskFlowHeader } from "@/components/one-location/redesign/primitives";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";

/**
 * A person avatar reports no state of its own — the initials identify, the
 * trailing control acts. Keeping it neutral leaves exactly one accent per row
 * (the Add button) instead of two blues competing across the same 58px.
 */
const CONTACT_AVATAR_TONE = cn(
  roleClasses("neutral").tile,
  roleClasses("neutral").glyph,
);

type SmsContactsFlowProps = {
  recipients: OneLocationRecipient[];
  circles: OneLocationCircleSummary[];
  selectedUserIds: string[];
  busyKey: string | null;
  onAdd: (recipientUserId: string) => void;
  onAddCircle: (circleId: string) => Promise<void>;
  onRemove: (recipientUserId: string) => Promise<boolean>;
  recipientLabel: (recipient: OneLocationRecipient) => string;
  recipientSubtitle: (recipient: OneLocationRecipient) => string;
  isRecipientShareReady: (recipient: OneLocationRecipient) => boolean;
};

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? ""))
    .slice(0, 2)
    .toUpperCase();
}

function ContactRow({
  recipient,
  selected,
  busy,
  ready,
  onAdd,
  onAskRemove,
  recipientLabel,
}: {
  recipient: OneLocationRecipient;
  selected: boolean;
  busy: boolean;
  ready: boolean;
  onAdd: () => void;
  onAskRemove: () => void;
  recipientLabel: (recipient: OneLocationRecipient) => string;
}) {
  const label = recipientLabel(recipient);
  return (
    <div className="flex min-h-[58px] items-center gap-3 px-3.5 py-2">
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold",
          CONTACT_AVATAR_TONE,
        )}
        aria-hidden
      >
        {initials(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] font-normal leading-[22px] text-foreground">
          {label}
        </span>
      </span>
      {selected ? (
        <button
          type="button"
          onClick={onAskRemove}
          disabled={busy}
          className="press-scale flex h-8 min-w-[76px] items-center justify-center rounded-full bg-[color:var(--app-destructive-tint)] px-3 text-[13px] font-semibold text-[color:var(--app-destructive)] disabled:bg-[color:var(--app-neutral-fill-strong)] disabled:opacity-45"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
        </button>
      ) : (
        <button
          type="button"
          onClick={onAdd}
          disabled={busy || !ready}
          aria-label={`Add ${label}`}
          className="press-scale flex h-8 min-w-[58px] items-center justify-center rounded-full bg-[color:var(--app-accent)] px-3 text-[13px] font-semibold text-[color:var(--app-accent-fg)] disabled:bg-[color:var(--app-neutral-fill-strong)] disabled:text-muted-foreground"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : ready ? (
            "Add"
          ) : (
            "Setup"
          )}
        </button>
      )}
    </div>
  );
}

function ContactGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-[color:var(--app-separator)] overflow-hidden rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)] shadow-none">
      {children}
    </div>
  );
}

function EmptyStateCard({ message }: { message: string }) {
  return (
    <div className="flex min-h-[72px] w-full items-center justify-center rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)] px-5 py-4 text-center text-[15px] font-normal leading-5 text-muted-foreground transition-all duration-200 ease-out shadow-none">
      <p className="max-w-[280px]">{message}</p>
    </div>
  );
}

export function SmsContactsFlow({
  recipients,
  circles,
  selectedUserIds,
  busyKey,
  onAdd,
  onAddCircle,
  onRemove,
  recipientLabel,
  isRecipientShareReady,
}: SmsContactsFlowProps) {
  const [pendingRemoval, setPendingRemoval] =
    useState<OneLocationRecipient | null>(null);
  const [removing, setRemoving] = useState(false);
  const selectedIds = useMemo(
    () => new Set(selectedUserIds),
    [selectedUserIds],
  );
  const selected = recipients.filter((recipient) =>
    selectedIds.has(recipient.userId),
  );
  const available = recipients.filter(
    (recipient) => !selectedIds.has(recipient.userId),
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

  return (
    // Renders inside the signed-in shell like every other Location task flow,
    // so the top bar keeps the single back control, the
    // "Location › SMS contacts" trail and the profile avatar. It used to pin
    // itself over the whole viewport, which hid all three and left it drawing
    // its own back arrow.
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

        {circles.length ? (
          <>
            <p className={cn(SECTION_HEADING, "mb-2 mt-6 px-[6px]")}>
              Circles
            </p>
            <ContactGroup>
              {circles.map((circle, index) => {
                const circleBusy = busyKey === `sms-circle:${circle.id}`;
                // STATE BEATS CATEGORY: a circle is the people role, but one
                // holding nobody except the viewer has nothing to report and
                // stays neutral. `memberCount` includes the viewer, so the
                // count that decides this is `memberCount - 1` — the same test
                // the Circles list and the check-in flow apply.
                const circleRole = roleClasses("people", {
                  inactive: Math.max(0, circle.memberCount - 1) === 0,
                });
                return (
                  <div
                    key={circle.id}
                    className={cn(
                      "flex min-h-[58px] items-center gap-3 px-3.5 py-2",
                      index < circles.length - 1 &&
                        "border-b border-[color:var(--app-separator)]",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]",
                        circleRole.tile,
                        circleRole.glyph,
                      )}
                    >
                      <UsersRound className="h-[17px] w-[17px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[17px] font-normal leading-[22px] text-foreground">
                        {circle.name}
                      </span>
                      <span className="mt-0.5 block text-[15px] leading-5 text-muted-foreground">
                        {circle.memberCount} members
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={Boolean(busyKey)}
                      onClick={() => void onAddCircle(circle.id)}
                      aria-label={`Add ${circle.name}`}
                      className="press-scale flex h-8 min-w-[58px] items-center justify-center rounded-full bg-[color:var(--app-accent)] px-3 text-[13px] font-semibold text-[color:var(--app-accent-fg)] disabled:opacity-45"
                    >
                      {circleBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Add"
                      )}
                    </button>
                  </div>
                );
              })}
            </ContactGroup>
            {/* Growing a Circle deliberately does NOT live here. This screen
                answers one question -- who gets the alert -- and a per-Circle
                "Invite people / Share code" block for every Circle pushed that
                list below the fold and mixed a membership task into a
                contact-picking one. Growing a Circle stays on the People tab,
                which owns membership. */}
          </>
        ) : null}


        {/* Keep contacts in one column on every viewport. The previous desktop
            split made a simple contact task feel scattered and disconnected. */}
        <div className="mt-6 grid gap-6">
          <div>
            <p className={cn(SECTION_HEADING, "mb-2 px-[6px]")}>
              Contacts
            </p>
            {selected.length ? (
              <ContactGroup>
                {selected.map((recipient) => (
                  <ContactRow
                    key={recipient.userId}
                    recipient={recipient}
                    selected
                    ready={isRecipientShareReady(recipient)}
                    busy={busyKey === `sms-contact:${recipient.userId}`}
                    onAdd={() => onAdd(recipient.userId)}
                    onAskRemove={() => setPendingRemoval(recipient)}
                    recipientLabel={recipientLabel}
                  />
                ))}
              </ContactGroup>
            ) : (
              <EmptyStateCard message="No contacts yet." />
            )}
          </div>

          <div>
            <p className={cn(SECTION_HEADING, "mb-2 px-[6px]")}>
              Add contacts
            </p>
            {available.length ? (
              <ContactGroup>
                {available.map((recipient) => (
                  <ContactRow
                    key={recipient.userId}
                    recipient={recipient}
                    selected={false}
                    ready={isRecipientShareReady(recipient)}
                    busy={busyKey === `sms-contact:${recipient.userId}`}
                    onAdd={() => onAdd(recipient.userId)}
                    onAskRemove={() => setPendingRemoval(recipient)}
                    recipientLabel={recipientLabel}
                  />
                ))}
              </ContactGroup>
            ) : (
              <EmptyStateCard message="All contacts added." />
            )}
          </div>
        </div>
      </div>

      <AlertDialog
        open={Boolean(pendingRemoval)}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        {/* A sheet that rises from the thumb is right on a phone and odd on a
            desktop, where it lands far from the row that opened it and from the
            pointer. Base classes stay exactly as they were — the phone case is
            the tested one — and only wider viewports re-centre it. */}
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
