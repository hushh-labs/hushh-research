"use client";

/**
 * One Location redesign — Check-In flow (Quick Action).
 *
 * "Let trusted people know you're here." A focused, full-screen task flow that
 * reuses the existing encrypted location-share pipeline via `vm.onCheckIn`.
 *
 * Visual spec: Apple Blue v2 design (Location Agent - Apple Blue v2.dc.html,
 * `data-screen-label="Check in"`). Literal design values (12px cards, gray
 * segmented duration control, blue pill CTA) are used deliberately, with dark
 * variants layered on so the screen stays legible in dark mode.
 *
 * PRESENTATION + LOCAL SELECTION STATE ONLY.
 * - The list of people ("Who should know?") is the SAME trusted contacts used by
 *   SOS (`vm.sosRecipients`), so a user's emergency circle is exactly who they
 *   check in with.
 * - Selection is local checkbox state; on confirm it hands the chosen recipient
 *   ids + duration to `vm.onCheckIn`, which runs the same createGrant + encrypt +
 *   publish path as a normal share (no new crypto, no new consent surface).
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  RefreshCw,
  Search,
  Shield,
  UsersRound,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import {
  mergeRecipientsByUserId,
  type CircleRecipientSelection,
} from "@/lib/one-location/circle-recipient-selection";
import { CircleGrowActions } from "@/components/one-location/redesign/circles/circle-grow-actions";

import type { LocationHubViewModel } from "./location-redesign-hub";


/** Check-in durations. "until_stop" maps to the maximum supported window. */
const CHECK_IN_DURATIONS: { value: string; label: string }[] = [
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "2", label: "2 hours" },
];
const UNTIL_STOP_VALUE = "24";

/** Default Check-In note sent to recipients and shown in their notification. */
const DEFAULT_CHECK_IN_MESSAGE = "I've checked in here, let's catch up";
const CHECK_IN_MESSAGE_MAX_LENGTH = 120;

/** White surface card — design radius 12px, with a dark-mode variant. */
const CARD =
  "rounded-[12px] border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-white/[0.05]";

// Contact list cap: trusted circles can be long, so show ~4 rows then scroll.
// A thin, touch-friendly scrollbar keeps it unobtrusive on mobile.
const CONTACT_LIST_SCROLL_CLASS =
  "max-h-[280px] overflow-y-auto overscroll-contain [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/15 dark:[&::-webkit-scrollbar-thumb]:bg-white/20";

function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  }
  return (words[0]?.slice(0, 1) || "?").toUpperCase();
}

function avatarTone(index: number): string {
  const tones = [
    "bg-red-500 text-white",
    "bg-sky-500 text-white",
    "bg-violet-500 text-white",
    "bg-emerald-500 text-white",
    "bg-amber-500 text-white",
  ];
  return tones[index % tones.length]!;
}

function accuracyLine(point: PlainLocationPoint | null): string | null {
  if (!point) return null;
  const accuracyM = point.accuracyM;
  if (typeof accuracyM !== "number" || !Number.isFinite(accuracyM) || accuracyM <= 0) {
    return null;
  }
  return `Accurate to about ${Math.round(accuracyM)} meters`;
}

/** Uppercase section label (YOUR LOCATION / WHO SHOULD KNOW? / …). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 mt-5 px-1 text-[13px] font-semibold text-black/45 dark:text-white/45">
      {children}
    </p>
  );
}

function ContactRow({
  index,
  checked,
  ready,
  label,
  isLast,
  onToggle,
}: {
  index: number;
  checked: boolean;
  ready: boolean;
  label: string;
  isLast: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={ready ? onToggle : undefined}
      disabled={!ready}
      aria-pressed={checked}
      className={cn(
        "flex w-full items-center gap-[13px] py-3 text-left transition-opacity",
        !isLast && "border-b border-black/[0.06] dark:border-white/[0.08]",
        ready ? "cursor-pointer" : "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          avatarTone(index),
        )}
        aria-hidden
      >
        {initialsOf(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] font-semibold text-foreground">
          {label}
        </span>
        {!ready ? (
          <span className="block truncate text-[12px] text-black/45 dark:text-white/45">
            Not ready to receive location
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors",
          checked
            ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
            : "border-[1.5px] border-black/25 dark:border-white/25",
        )}
      >
        {checked ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
      </span>
    </button>
  );
}

export function CheckInFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const busy = vm.busy === "share" || vm.busy === "selfLocation";

  // Local selection state, seeded once from the trusted (ready) contacts so the
  // first ready person is pre-checked (mirrors the reference design).
  const [search, setSearch] = useState("");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [durationValue, setDurationValue] = useState("1");
  const [untilStop, setUntilStop] = useState(false);
  const [message, setMessage] = useState(DEFAULT_CHECK_IN_MESSAGE);
  const [seeded, setSeeded] = useState(false);
  const [circleSelection, setCircleSelection] =
    useState<CircleRecipientSelection | null>(null);
  const [circleLoadingId, setCircleLoadingId] = useState<string | null>(null);
  const contacts = useMemo(
    () =>
      mergeRecipientsByUserId(
        vm.sosRecipients,
        (circleSelection?.ready ?? []).map((target) => target.recipient),
      ),
    [circleSelection, vm.sosRecipients],
  );

  const selectCircle = async (circleId: string) => {
    if (circleLoadingId) return;
    if (circleSelection?.circle.id === circleId) {
      setCircleSelection(null);
      setCheckedIds([]);
      setSeeded(false);
      return;
    }
    setCircleLoadingId(circleId);
    try {
      const selection = await vm.onResolveNamedCircleRecipients(
        circleId,
        "location",
      );
      setCircleSelection(selection);
      setCheckedIds(
        selection.ready.map((target) => target.recipient.userId),
      );
      setSeeded(true);
      if (!selection.ready.length) {
        toast.error(
          "No current Circle members are ready to receive encrypted location.",
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not load this Circle.",
      );
    } finally {
      setCircleLoadingId(null);
    }
  };

  useEffect(() => {
    if (seeded) return;
    const firstReady = contacts.find((r) => vm.isRecipientShareReady(r));
    if (firstReady) {
      setCheckedIds([firstReady.userId]);
      setSeeded(true);
    } else if (contacts.length > 0) {
      setSeeded(true);
    }
  }, [contacts, seeded, vm]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((r) =>
      vm.recipientLabel(r).toLowerCase().includes(q),
    );
  }, [contacts, search, vm]);

  const selectedReadyCount = useMemo(
    () =>
      contacts.filter(
        (r) => checkedIds.includes(r.userId) && vm.isRecipientShareReady(r),
      ).length,
    [contacts, checkedIds, vm],
  );

  const toggle = (id: string) =>
    setCheckedIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );

  const effectiveDuration = untilStop ? UNTIL_STOP_VALUE : durationValue;

  const point = vm.myLocationPoint;
  const accuracy = accuracyLine(point);

  const durationOptions = [
    ...CHECK_IN_DURATIONS.map((option) => ({
      key: option.value,
      label: option.label,
      grow: 1,
      active: !untilStop && option.value === durationValue,
      onClick: () => {
        setUntilStop(false);
        setDurationValue(option.value);
      },
    })),
    {
      key: "until_stop",
      label: "Until I stop",
      grow: 1.2,
      active: untilStop,
      onClick: () => setUntilStop(true),
    },
  ];

  const canSubmit = Boolean(point) && selectedReadyCount > 0;

  return (
    <div>
      {/* Header — title + Cancel link (no back arrow; Cancel dismisses). */}
      <div className="flex items-start justify-between gap-3">
        <h1 className="max-w-[250px] text-[23px] font-bold leading-[1.2] tracking-[-0.4px] text-foreground">
          Let trusted people know you&apos;re here
        </h1>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 pt-1 text-[15px] text-[color:var(--app-accent)] dark:text-[color:var(--app-accent)]"
        >
          Cancel
        </button>
      </div>

      {/* YOUR LOCATION */}
      <SectionLabel>YOUR LOCATION</SectionLabel>
      <section className={cn(CARD, "overflow-hidden")}>
        <div className="flex items-center gap-3 px-4 py-[13px]">
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold text-foreground">
              {point ? "Live location ready" : "Location not captured yet"}
            </p>
            <p className="mt-0.5 text-[13px] text-black/45 dark:text-white/45">
              {point
                ? `${accuracy ?? "Location captured"} · ${vm.formatDateTime(point.capturedAt)}`
                : "Capture your current location to check in."}
            </p>
          </div>
          <button
            type="button"
            onClick={vm.onShowMyLocation}
            disabled={vm.busy === "selfLocation"}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-black/[0.14] px-[13px] py-[7px] text-[13px] font-semibold text-[color:var(--app-accent)] disabled:opacity-60 dark:border-white/20 dark:text-[color:var(--app-accent)]"
          >
            <RefreshCw
              className={cn(
                "h-3 w-3",
                vm.busy === "selfLocation" && "animate-spin",
              )}
            />
            {point ? "Refresh" : "Capture"}
          </button>
        </div>
        {vm.myLocationError ? (
          <p className="px-4 pb-3 text-xs font-medium text-red-600 dark:text-red-300">
            {vm.myLocationError}
          </p>
        ) : null}
        {point ? (
          <div className="px-3 pb-3">{vm.renderMapPreview(point, false)}</div>
        ) : null}
      </section>

      {/* WHO SHOULD KNOW? */}
      <SectionLabel>WHO SHOULD KNOW?</SectionLabel>
      {vm.circles.length ? (
        <div className={cn(CARD, "mb-2 overflow-hidden")}>
          {vm.circles.map((circle, index) => {
            const selected = circleSelection?.circle.id === circle.id;
            return (
              <button
                key={circle.id}
                type="button"
                disabled={Boolean(circleLoadingId) || busy}
                onClick={() => void selectCircle(circle.id)}
                aria-pressed={selected}
                className={cn(
                  "flex min-h-[58px] w-full items-center gap-3 px-4 py-2.5 text-left",
                  index < vm.circles.length - 1 &&
                    "border-b border-black/[0.06] dark:border-white/[0.08]",
                  selected &&
                    "bg-[color:var(--app-accent-soft)]",
                )}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
                  <UsersRound className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-foreground">
                    {circle.name}
                  </span>
                  <span className="block text-[12px] text-muted-foreground">
                    {selected
                      ? `${circleSelection.ready.length} ready now`
                      : `${circle.memberCount} members`}
                  </span>
                </span>
                <span className="text-[12px] font-semibold text-[color:var(--app-accent)]">
                  {circleLoadingId === circle.id
                    ? "Loading…"
                    : selected
                      ? "Selected"
                      : "Select all"}
                </span>
              </button>
            );
          })}
          {circleSelection ? (
            <>
              <p className="border-t border-black/[0.06] px-4 py-2.5 text-[12px] leading-5 text-muted-foreground dark:border-white/[0.08]">
                Current ready members only. Future members are not added to this
                check-in.
                {circleSelection.excluded.filter(
                  (item) => item.reason !== "self",
                ).length
                  ? ` ${
                      circleSelection.excluded.filter(
                        (item) => item.reason !== "self",
                      ).length
                    } not ready.`
                  : ""}
              </p>
              {/* Grow this Circle in-context: invite an existing connection or
                  share the invite code, so a user can pull loved ones in right
                  before they check in — especially when few members are ready. */}
              <div className="border-t border-black/[0.06] px-4 py-3 dark:border-white/[0.08]">
                <CircleGrowActions
                  circleId={circleSelection.circle.id}
                  circleName={circleSelection.circle.name}
                  busy={busy || Boolean(circleLoadingId)}
                  canInvite={
                    circleSelection.circle.viewerCapabilities
                      ?.canInviteMembers ??
                    circleSelection.circle.role === "owner"
                  }
                  onShareCode={vm.onShareNamedCircleCodeById}
                  onLoadEligibleConnections={
                    vm.onLoadNamedCircleEligibleConnections
                  }
                  onInviteConnections={vm.onInviteNamedCircleConnections}
                  onCancelMemberInvite={vm.onCancelNamedCircleMemberInvite}
                  testId="check-in-circle-grow-actions"
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className={cn(CARD, "mb-2 flex items-center gap-2 px-[14px] py-[11px]")}>
        <Search className="h-3.5 w-3.5 shrink-0 text-black/35 dark:text-white/40" />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search contacts…"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-black/35 dark:placeholder:text-white/40"
        />
      </div>
      {filtered.length ? (
        <div className={cn(CARD, "px-4")}>
          <div className={CONTACT_LIST_SCROLL_CLASS}>
            {filtered.map((recipient, index) => (
              <ContactRow
                key={recipient.userId}
                index={index}
                checked={checkedIds.includes(recipient.userId)}
                ready={vm.isRecipientShareReady(recipient)}
                label={vm.recipientLabel(recipient)}
                isLast={index === filtered.length - 1}
                onToggle={() => toggle(recipient.userId)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className={cn(CARD, "p-5 text-center text-sm text-muted-foreground")}>
          {contacts.length === 0
            ? "No trusted contacts yet. Add people to your Circle first."
            : "No matching contacts."}
        </div>
      )}

      {/* DURATION — gray segmented control incl. "Until I stop". */}
      <SectionLabel>DURATION</SectionLabel>
      <div className="flex rounded-[9px] bg-[#ededf2] p-0.5 dark:bg-white/[0.08]">
        {durationOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={option.onClick}
            style={{ flexGrow: option.grow, flexBasis: 0 }}
            className={cn(
              "whitespace-nowrap rounded-[7px] py-[9px] text-center text-[13px] transition-colors",
              option.active
                ? "bg-white font-bold text-foreground shadow-sm dark:bg-white/[0.16]"
                : "font-normal text-foreground/80",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-2 flex items-center gap-1.5 px-1 text-[12px] text-black/45 dark:text-white/45">
        <Shield className="h-3 w-3 shrink-0" strokeWidth={1.5} />
        Sharing stops automatically — no manual revoke needed.
      </p>

      {/* MESSAGE — sent with the check-in and shown in the recipient's
          notification (e.g. "Alex: I've checked in here, let's catch up"). */}
      <SectionLabel>MESSAGE</SectionLabel>
      <div className={cn(CARD, "px-4 py-[14px]")}>
        <textarea
          value={message}
          onChange={(event) =>
            setMessage(event.target.value.slice(0, CHECK_IN_MESSAGE_MAX_LENGTH))
          }
          rows={2}
          placeholder={DEFAULT_CHECK_IN_MESSAGE}
          className="w-full resize-none bg-transparent text-[15px] leading-[1.4] text-foreground outline-none placeholder:text-black/35 dark:placeholder:text-white/40"
        />
        <p className="mt-2 text-right text-[12px] text-black/30 dark:text-white/30">
          {message.length}/{CHECK_IN_MESSAGE_MAX_LENGTH}
        </p>
      </div>
      <p className="mb-[18px] mt-2 px-1 text-[12px] leading-[1.45] text-black/45 dark:text-white/45">
        They&apos;ll see this with your name in the notification, so they know
        who checked in and why.
      </p>

      {/* Primary CTA — full blue pill (design). */}
      <button
        type="button"
        onClick={() =>
          vm.onCheckIn(
            checkedIds,
            effectiveDuration,
            message.trim() || DEFAULT_CHECK_IN_MESSAGE,
            circleSelection?.circle.id ?? null,
          )
        }
        disabled={!canSubmit || busy}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] py-4 text-[17px] font-medium text-[color:var(--app-accent-fg)] transition-opacity",
          (!canSubmit || busy) && "opacity-50",
        )}
      >
        {busy ? (
          <RefreshCw className="h-[18px] w-[18px] animate-spin" />
        ) : (
          <CheckCircle2 className="h-[18px] w-[18px]" strokeWidth={1.8} />
        )}
        {point
          ? selectedReadyCount > 0
            ? `Check in with ${selectedReadyCount} ${
                selectedReadyCount === 1 ? "person" : "people"
              }`
            : "Select who should know"
          : "Capture your location first"}
      </button>
    </div>
  );
}
