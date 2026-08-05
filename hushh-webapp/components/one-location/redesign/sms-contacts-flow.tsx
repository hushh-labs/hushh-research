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
        <span className="block truncate text-[15px] font-semibold text-[#17171c]">
          {label}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-black/45">
          {recipientSubtitle(recipient) || "Connected in One"}
        </span>
      </span>
      {selected ? (
        <button
          type="button"
          onClick={onAskRemove}
          disabled={busy}
          className="press-scale flex h-8 min-w-[76px] items-center justify-center rounded-full border border-[#ff3b30]/35 px-3 text-[13px] font-semibold text-[#ff3b30] disabled:opacity-45"
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
    <div className="divide-y divide-black/[0.055] overflow-hidden rounded-[15px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
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
      className="fixed inset-0 z-[540] h-[100dvh] min-h-[100dvh] overflow-y-auto overscroll-none bg-[#f2f3f7] text-[#17171c]"
      data-ambient-chrome-ignore
      data-testid="sms-contacts-screen"
    >
      <div className="mx-auto min-h-[100dvh] w-full max-w-[430px] px-3.5 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(38px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="press-scale flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.045]"
        >
          <ChevronLeft className="h-[19px] w-[19px]" />
        </button>

        <h1 className="mt-3 !text-[29px] !font-bold !leading-tight !tracking-[-0.65px]">
          SMS contacts
        </h1>
        <p className="mt-1 max-w-[350px] text-[13px] leading-[1.45] text-black/47">
          These people are alerted with your live location the moment you send
          the SMS.
        </p>

        {circles.length ? (
          <>
            <p className="mb-2 mt-6 px-1 text-[11px] font-bold uppercase tracking-[0.35px] text-black/40">
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
                        "border-b border-black/[0.055]",
                    )}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
                      <UsersRound className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-[#17171c]">
                        {circle.name}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-black/45">
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
            <p className="mt-2 px-1 text-[12px] leading-[1.45] text-black/43">
              This adds a snapshot of current ready members. Anyone who joins
              later is never added to SMS automatically.
            </p>
            {/* Grow a Circle in-context: invite an existing connection or share
                the invite code so loved ones can join before they become SMS
                contacts. Membership never auto-adds anyone to SMS. */}
            {circles.map((circle) => (
              <div key={`grow-${circle.id}`} className="mt-3 px-1">
                <p className="mb-1.5 text-[12px] font-semibold text-black/50">
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


        <p className="mb-2 mt-6 px-1 text-[11px] font-bold uppercase tracking-[0.35px] text-black/40">
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
          <div className="rounded-[15px] bg-white px-4 py-5 text-center text-[13px] leading-relaxed text-black/45">
            No SMS contacts yet. Add someone from your circle below.
          </div>
        )}

        <p className="mb-2 mt-6 px-1 text-[11px] font-bold uppercase tracking-[0.35px] text-black/40">
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
          <div className="rounded-[15px] bg-white px-4 py-5 text-center text-[13px] text-black/45">
            Everyone in your ready circle is already selected.
          </div>
        )}

        <p className="mt-4 px-1 text-[12px] leading-[1.45] text-black/43">
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
          className="!bottom-0 !left-1/2 !top-auto !w-full !max-w-[430px] !-translate-x-1/2 !translate-y-0 !gap-0 !rounded-b-none !rounded-t-[24px] !border-0 !bg-white !px-4 !pb-[max(20px,env(safe-area-inset-bottom))] !pt-5 !shadow-none"
        >
          <AlertDialogHeader className="!place-items-center !text-center sm:!place-items-center sm:!text-center">
            <span
              className="flex h-14 w-14 items-center justify-center rounded-full bg-[#f29918] text-xl font-semibold text-white"
              aria-hidden
            >
              {pendingRemoval ? initials(recipientLabel(pendingRemoval)) : "?"}
            </span>
            <AlertDialogTitle className="mt-1 !text-center !text-[20px] !font-bold !leading-tight">
              Remove{" "}
              {pendingRemoval
                ? `${recipientLabel(pendingRemoval).split(/\s+/)[0]}?`
                : "contact?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-1 !max-w-[290px] !text-center !text-[13px] !leading-[1.45]">
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
              className="!h-12 !rounded-full !bg-[#ff3b30] !text-[15px] !font-semibold !text-white hover:!bg-[#ff3b30]/90 disabled:!opacity-60"
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
              className="!mt-0 !h-12 !rounded-full !border-0 !bg-[#efeff4] !text-[15px] !font-semibold !text-[#17171c] hover:!bg-[#e5e5ea] disabled:!opacity-60"
            >
              Cancel
            </AlertDialogCancel>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
