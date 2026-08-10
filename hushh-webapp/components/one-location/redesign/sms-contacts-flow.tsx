"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, Loader2, UsersRound } from "lucide-react";

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
  OneLocationCircleEligibleConnections,
  OneLocationCircleSummary,
  OneLocationRecipient,
} from "@/lib/one-location/types";
import { CircleGrowActions } from "@/components/one-location/redesign/circles/circle-grow-actions";
import { MUTED_TEXT, SECTION_HEADING } from "@/components/one-location/redesign/tokens";


const AVATAR_TONES = [
  "bg-[#2f80ed]",
  "bg-[#9b51e0]",
  "bg-[#f29918]",
  "bg-[#10a89a]",
  "bg-[#eb5757]",
] as const;

type SmsContactsFlowProps = {
  recipients: OneLocationRecipient[];
  circles: OneLocationCircleSummary[];
  selectedUserIds: string[];
  busyKey: string | null;
  onBack: () => void;
  onAdd: (recipientUserId: string) => void;
  onAddCircle: (circleId: string) => Promise<void>;
  onRemove: (recipientUserId: string) => Promise<boolean>;
  recipientLabel: (recipient: OneLocationRecipient) => string;
  recipientSubtitle: (recipient: OneLocationRecipient) => string;
  isRecipientShareReady: (recipient: OneLocationRecipient) => boolean;
  // Grow-this-Circle handlers so a user can invite loved ones or share the
  // invite code right where they add a Circle to SMS contacts.
  onShareCircleCode: (circleId: string) => Promise<void>;
  onLoadCircleEligibleConnections: (
    circleId: string,
  ) => Promise<OneLocationCircleEligibleConnections>;
  onInviteCircleConnections: (
    circleId: string,
    inviteeUserIds: string[],
  ) => Promise<void>;
  onCancelCircleMemberInvite: (inviteId: string) => Promise<void>;
};


function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? ""))
    .slice(0, 2)
    .toUpperCase();
}

function ContactRow({
  recipient,
  index,
  selected,
  busy,
  ready,
  onAdd,
  onAskRemove,
  recipientLabel,
  recipientSubtitle,
}: {
  recipient: OneLocationRecipient;
  index: number;
  selected: boolean;
  busy: boolean;
  ready: boolean;
  onAdd: () => void;
  onAskRemove: () => void;
  recipientLabel: (recipient: OneLocationRecipient) => string;
  recipientSubtitle: (recipient: OneLocationRecipient) => string;
}) {
  const label = recipientLabel(recipient);
  return (
    <div className="flex min-h-[64px] items-center gap-3 px-3.5 py-2.5">
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[16px] font-semibold text-white",
          AVATAR_TONES[index % AVATAR_TONES.length],
        )}
        aria-hidden
      >
        {initials(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] font-normal leading-[22px] text-foreground">
          {label}
        </span>
        <span className="mt-0.5 block truncate text-[15px] leading-5 text-muted-foreground">
          {recipientSubtitle(recipient) || "Connected in One"}
        </span>
      </span>
      {selected ? (
        <button
          type="button"
          onClick={onAskRemove}
          disabled={busy}
          className="press-scale flex h-8 min-w-[76px] items-center justify-center rounded-full bg-[color:var(--app-destructive)]/10 px-3 text-[13px] font-semibold text-[color:var(--app-destructive)] disabled:bg-[color:var(--app-neutral-fill-strong)] disabled:opacity-45"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
        </button>
      ) : (
        <button
          type="button"
          onClick={onAdd}
          disabled={busy || !ready}
          className="press-scale flex h-8 min-w-[58px] items-center justify-center rounded-full bg-[color:var(--app-accent)] px-3 text-[13px] font-semibold text-[color:var(--app-accent-fg)] disabled:bg-black/10 disabled:text-black/35"
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

export function SmsContactsFlow({
  recipients,
  circles,
  selectedUserIds,
  busyKey,
  onBack,
  onAdd,
  onAddCircle,
  onRemove,
  recipientLabel,
  recipientSubtitle,
  isRecipientShareReady,
  onShareCircleCode,
  onLoadCircleEligibleConnections,
  onInviteCircleConnections,
  onCancelCircleMemberInvite,
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
    <section
      className="fixed inset-0 z-[540] h-[100dvh] min-h-[100dvh] overflow-y-auto overscroll-none bg-background text-foreground"
      data-ambient-chrome-ignore
      data-testid="sms-contacts-screen"
    >
      <div className="mx-auto min-h-[100dvh] w-full max-w-[430px] px-3.5 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(38px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="press-scale flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill-strong)] text-[color:var(--app-secondary-label)]"
        >
          <ChevronLeft className="h-[19px] w-[19px]" />
        </button>

        <h1 className="mt-3 !text-[32px] !font-bold !leading-[1.08] !tracking-normal">
          SMS contacts
        </h1>
        <p className="mt-2 max-w-[350px] text-[17px] leading-[24px] text-muted-foreground">
          These people are alerted with your live location the moment you send
          the SMS.
        </p>

        {circles.length ? (
          <>
            <p className={cn(SECTION_HEADING, "mb-2 mt-6 px-[6px]")}>
              Add a Circle
            </p>
            <ContactGroup>
              {circles.map((circle, index) => {
                const circleBusy = busyKey === `sms-circle:${circle.id}`;
                return (
                  <div
                    key={circle.id}
                    className={cn(
                      "flex min-h-[64px] items-center gap-3 px-3.5 py-2.5",
                      index < circles.length - 1 &&
                        "border-b border-[color:var(--app-separator)]",
                    )}
                  >
                    <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]">
                      <UsersRound className="h-[17px] w-[17px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[17px] font-normal leading-[22px] text-foreground">
                        {circle.name}
                      </span>
                      <span className="mt-0.5 block text-[15px] leading-5 text-muted-foreground">
                        Add current ready members · {circle.memberCount} total
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={Boolean(busyKey)}
                      onClick={() => void onAddCircle(circle.id)}
                      className="press-scale flex h-8 min-w-[78px] items-center justify-center rounded-full bg-[color:var(--app-accent)] px-3 text-[13px] font-semibold text-[color:var(--app-accent-fg)] disabled:opacity-45"
                    >
                      {circleBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Add Circle"
                      )}
                    </button>
                  </div>
                );
              })}
            </ContactGroup>
            <p className={cn(MUTED_TEXT, "mt-2 px-1")}>
              This adds a snapshot of current ready members. Anyone who joins
              later is never added to SMS automatically.
            </p>
            {/* Grow a Circle in-context: invite an existing connection or share
                the invite code so loved ones can join before they become SMS
                contacts. Membership never auto-adds anyone to SMS. */}
            {circles.map((circle) => (
              <div key={`grow-${circle.id}`} className="mt-3 px-1">
                <p className={cn(SECTION_HEADING, "mb-1.5")}>
                  Grow {circle.name}
                </p>
                <CircleGrowActions
                  circleId={circle.id}
                  circleName={circle.name}
                  busy={Boolean(busyKey)}
                  canInvite={
                    circle.viewerCapabilities?.canInviteMembers ??
                    circle.role === "owner"
                  }
                  onShareCode={onShareCircleCode}
                  onLoadEligibleConnections={onLoadCircleEligibleConnections}
                  onInviteConnections={onInviteCircleConnections}
                  onCancelMemberInvite={onCancelCircleMemberInvite}
                  testId={`sms-circle-grow-actions-${circle.id}`}
                />
              </div>
            ))}
          </>
        ) : null}


        <p className={cn(SECTION_HEADING, "mb-2 mt-6 px-[6px]")}>
          Alerted on SMS
        </p>
        {selected.length ? (
          <ContactGroup>
            {selected.map((recipient, index) => (
              <ContactRow
                key={recipient.userId}
                recipient={recipient}
                index={index}
                selected
                ready={isRecipientShareReady(recipient)}
                busy={busyKey === `sms-contact:${recipient.userId}`}
                onAdd={() => onAdd(recipient.userId)}
                onAskRemove={() => setPendingRemoval(recipient)}
                recipientLabel={recipientLabel}
                recipientSubtitle={recipientSubtitle}
              />
            ))}
          </ContactGroup>
        ) : (
          <div className="rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-5 text-center text-[15px] leading-5 text-muted-foreground">
            No SMS contacts yet. Add someone from your circle below.
          </div>
        )}

        <p className={cn(SECTION_HEADING, "mb-2 mt-6 px-[6px]")}>
          Add from your circle
        </p>
        {available.length ? (
          <ContactGroup>
            {available.map((recipient, index) => (
              <ContactRow
                key={recipient.userId}
                recipient={recipient}
                index={index + selected.length}
                selected={false}
                ready={isRecipientShareReady(recipient)}
                busy={busyKey === `sms-contact:${recipient.userId}`}
                onAdd={() => onAdd(recipient.userId)}
                onAskRemove={() => setPendingRemoval(recipient)}
                recipientLabel={recipientLabel}
                recipientSubtitle={recipientSubtitle}
              />
            ))}
          </ContactGroup>
        ) : (
          <div className="rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-5 text-center text-[15px] leading-5 text-muted-foreground">
            Everyone in your ready circle is already selected.
          </div>
        )}

        <p className={cn(MUTED_TEXT, "mt-4 px-1")}>
          Only people in your circle can be SMS contacts. They&apos;re never
          notified unless you send the SMS.
        </p>
      </div>

      <AlertDialog
        open={Boolean(pendingRemoval)}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent
          size="sm"
          className="!bottom-0 !left-1/2 !top-auto !w-full !max-w-[430px] !-translate-x-1/2 !translate-y-0 !gap-0 !rounded-b-none !rounded-t-[24px] !border-0 !bg-[color:var(--app-card-surface-default-solid)] !px-4 !pb-[max(20px,env(safe-area-inset-bottom))] !pt-5 !shadow-none"
        >
          <AlertDialogHeader className="!place-items-center !text-center sm:!place-items-center sm:!text-center">
            <span
              className="flex h-[52px] w-[52px] items-center justify-center rounded-[16px] bg-[color:var(--app-warning)] text-xl font-semibold text-white"
              aria-hidden
            >
              {pendingRemoval ? initials(recipientLabel(pendingRemoval)) : "?"}
            </span>
            <AlertDialogTitle className="mt-1 !text-center !text-[22px] !font-bold !leading-[1.14]">
              <span className="text-foreground">
                Remove{" "}
                {pendingRemoval
                  ? `${recipientLabel(pendingRemoval).split(/\s+/)[0]}?`
                  : "contact?"}
              </span>
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-1 !max-w-[290px] !text-center !text-[15px] !leading-5 !text-muted-foreground">
              They&apos;ll no longer be alerted with your live location when you
              trigger SMS.
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
              className="!h-12 !rounded-full !bg-[color:var(--app-destructive)] !text-[15px] !font-semibold !text-white hover:!bg-[color:var(--app-destructive)]/90 disabled:!opacity-60"
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
