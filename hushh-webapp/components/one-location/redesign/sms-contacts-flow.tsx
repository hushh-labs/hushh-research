"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";

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
import type { OneLocationRecipient } from "@/lib/one-location/types";

const AVATAR_TONES = [
  "bg-[#2f80ed]",
  "bg-[#9b51e0]",
  "bg-[#f29918]",
  "bg-[#10a89a]",
  "bg-[#eb5757]",
] as const;

type SmsContactsFlowProps = {
  recipients: OneLocationRecipient[];
  selectedUserIds: string[];
  busyKey: string | null;
  onBack: () => void;
  onAdd: (recipientUserId: string) => void;
  onRemove: (recipientUserId: string) => void;
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
  selectedUserIds,
  busyKey,
  onBack,
  onAdd,
  onRemove,
  recipientLabel,
  recipientSubtitle,
  isRecipientShareReady,
}: SmsContactsFlowProps) {
  const [pendingRemoval, setPendingRemoval] =
    useState<OneLocationRecipient | null>(null);
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

  const removePending = () => {
    if (!pendingRemoval) return;
    onRemove(pendingRemoval.userId);
    setPendingRemoval(null);
  };

  return (
    <section className="fixed inset-0 z-[90] overflow-y-auto bg-[#f2f3f7] text-[#17171c]">
      <div className="mx-auto min-h-[100dvh] w-full max-w-[430px] px-3.5 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(38px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="press-scale flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.045]"
        >
          <ArrowLeft className="h-[18px] w-[18px]" />
        </button>

        <h1 className="mt-3 text-[29px] font-bold leading-tight tracking-[-0.65px]">
          SMS contacts
        </h1>
        <p className="mt-1 max-w-[350px] text-[13px] leading-[1.45] text-black/47">
          These people are alerted with your live location the moment you send
          the SMS.
        </p>

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
          if (!open) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent className="bottom-0 left-1/2 top-auto w-full max-w-[430px] -translate-x-1/2 translate-y-0 rounded-b-none rounded-t-[24px] border-0 px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-5">
          <AlertDialogHeader className="items-center text-center">
            <span
              className="flex h-14 w-14 items-center justify-center rounded-full bg-[#f29918] text-xl font-semibold text-white"
              aria-hidden
            >
              {pendingRemoval
                ? initials(recipientLabel(pendingRemoval))
                : "?"}
            </span>
            <AlertDialogTitle className="text-center text-[20px]">
              Remove{" "}
              {pendingRemoval
                ? `${recipientLabel(pendingRemoval).split(/\s+/)[0]}?`
                : "contact?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="max-w-[290px] text-center text-[13px] leading-[1.45]">
              They&apos;ll no longer be alerted with your live location when you
              trigger SMS.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-4 grid gap-2">
            <AlertDialogAction
              onClick={removePending}
              className="h-12 rounded-full bg-[#ff3b30] text-[15px] font-semibold hover:bg-[#ff3b30]/90"
            >
              Remove
            </AlertDialogAction>
            <AlertDialogCancel className="mt-0 h-12 rounded-full border-0 bg-[#efeff4] text-[15px] font-semibold">
              Cancel
            </AlertDialogCancel>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
