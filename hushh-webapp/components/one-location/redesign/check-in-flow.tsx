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

import { useEffect, useMemo, useRef, useState } from "react";
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
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import { SectionLabel as AppSectionLabel } from "@/components/app-ui/typography";
import {
  isCircleSelectionFullySelected,
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
const REVIEWED_POINT_MAX_AGE_MS = 60_000;
const REVIEWED_POINT_FUTURE_SKEW_MS = 30_000;
const PRIVATE_CONFIRMATION_MAX_AGE_MS = 10 * 60_000;

/** White surface card — design radius 12px, with a dark-mode variant. */
const CARD =
  "rounded-[var(--app-card-radius-compact)] border border-border/60 bg-[color:var(--app-card-surface-default-solid)]";

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

/**
 * A person avatar reports no state, so it renders in the NEUTRAL role and lets
 * the initials do the identifying.
 *
 * It used to rotate five raw palette colours by list position, which meant the
 * same contact changed colour whenever the search filter reordered the list,
 * and put danger red on a row that carries no danger.
 */
const CONTACT_AVATAR_TONE = cn(
  roleClasses("neutral").tile,
  roleClasses("neutral").glyph,
);


function accuracyLine(point: PlainLocationPoint | null): string | null {
  if (!point) return null;
  const accuracyM = point.accuracyM;
  if (typeof accuracyM !== "number" || !Number.isFinite(accuracyM) || accuracyM <= 0) {
    return null;
  }
  return `Accurate to about ${Math.round(accuracyM)} meters`;
}

function createPrivateCheckInOperationId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `checkin-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 14)}`;
}

function isFreshReviewedPoint(
  point: PlainLocationPoint | null,
  nowMs: number,
): point is PlainLocationPoint {
  if (!point) return false;
  const capturedAtMs = Date.parse(point.capturedAt);
  if (!Number.isFinite(capturedAtMs)) return false;
  const ageMs = nowMs - capturedAtMs;
  return (
    ageMs >= -REVIEWED_POINT_FUTURE_SKEW_MS &&
    ageMs <= REVIEWED_POINT_MAX_AGE_MS
  );
}

/** Section label that follows the shared readable settings scale. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <AppSectionLabel as="p" className="mb-2 mt-7 px-[6px]">
      {children}
    </AppSectionLabel>
  );
}

function ContactRow({
  checked,
  ready,
  locked,
  completed,
  label,
  isLast,
  onToggle,
}: {
  checked: boolean;
  ready: boolean;
  locked: boolean;
  completed: boolean;
  label: string;
  isLast: boolean;
  onToggle: () => void;
}) {
  const disabled = !ready || locked || completed;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onToggle}
      disabled={disabled}
      aria-pressed={checked}
      className={cn(
        "flex w-full items-center gap-[13px] py-3 text-left transition-opacity",
        !isLast && "border-b border-black/[0.06] dark:border-white/[0.08]",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          CONTACT_AVATAR_TONE,
        )}
        aria-hidden
      >
        {initialsOf(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] font-semibold text-foreground">
          {label}
        </span>
        {completed ? (
          <span className="block truncate text-[12px] text-emerald-600 dark:text-emerald-400">
            Already shared in this check-in
          </span>
        ) : !ready ? (
          <span className="block truncate text-[13px] leading-[18px] text-[#8E8E93]">
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
  entrySource,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
  entrySource?: "nearby";
}) {
  const discardPrivateCheckInOperation =
    vm.onDiscardPrivateCheckInOperation;
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || vm.busy === "share" || vm.busy === "selfLocation";

  // A standalone private Check-In preserves the legacy first-recipient shortcut.
  // Nearby entry is deliberately empty: nearby presence never grants precise
  // location access, so every private recipient must be selected explicitly.
  const [search, setSearch] = useState("");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [durationValue, setDurationValue] = useState("1");
  const [untilStop, setUntilStop] = useState(false);
  const [message, setMessage] = useState(DEFAULT_CHECK_IN_MESSAGE);
  const [completedRecipientIds, setCompletedRecipientIds] = useState<string[]>(
    [],
  );
  const [seeded, setSeeded] = useState(entrySource === "nearby");
  const [circleSelection, setCircleSelection] =
    useState<CircleRecipientSelection | null>(null);
  const [circleLoadingId, setCircleLoadingId] = useState<string | null>(null);
  const [confirmedPoint, setConfirmedPoint] =
    useState<PlainLocationPoint | null>(null);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [mapViewportResetKey, setMapViewportResetKey] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const operationIdRef = useRef<string | null>(null);
  const confirmedRecipientKeysRef = useRef<Record<string, string | null> | null>(
    null,
  );
  const contacts = useMemo(
    () =>
      mergeRecipientsByUserId(
        vm.sosRecipients,
        (circleSelection?.ready ?? []).map((target) => target.recipient),
      ),
    [circleSelection, vm.sosRecipients],
  );

  // Choosing a Circle ticks each ready member in the list below, and those rows
  // stay individually untickable. Once one is cleared the check-in is no longer
  // that Circle, so the Circle row stops reading as selected — and the next tap
  // re-ticks the full roster instead of clearing what is left.
  const circleFullySelected = isCircleSelectionFullySelected(
    circleSelection,
    checkedIds,
  );

  const selectCircle = async (circleId: string) => {
    if (circleLoadingId) return;
    if (circleSelection?.circle.id === circleId && circleFullySelected) {
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
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(intervalId);
  }, []);

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
        (r) =>
          checkedIds.includes(r.userId) &&
          !completedRecipientIds.includes(r.userId) &&
          vm.isRecipientShareReady(r),
      ).length,
    [completedRecipientIds, contacts, checkedIds, vm],
  );

  const toggle = (id: string) =>
    setCheckedIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );

  const effectiveDuration = untilStop ? UNTIL_STOP_VALUE : durationValue;

  const point = confirmedPoint ?? vm.myLocationPoint;
  const accuracy = accuracyLine(point);
  const retryLocked = Boolean(confirmedPoint);
  const confirmedAtMs = confirmedAt ? Date.parse(confirmedAt) : Number.NaN;
  const confirmationExpired =
    retryLocked &&
    (!Number.isFinite(confirmedAtMs) ||
      nowMs - confirmedAtMs > PRIVATE_CONFIRMATION_MAX_AGE_MS);
  const recipientKeyChanged =
    retryLocked &&
    checkedIds.some((recipientId) => {
      const originalKeyId =
        confirmedRecipientKeysRef.current?.[recipientId] ?? null;
      const currentKeyId =
        contacts.find((recipient) => recipient.userId === recipientId)?.keyId ??
        null;
      return originalKeyId !== currentKeyId;
    });
  const pointIsFresh =
    retryLocked && !confirmationExpired
      ? true
      : isFreshReviewedPoint(point, nowMs);

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

  const canSubmit =
    Boolean(point) &&
    pointIsFresh &&
    !recipientKeyChanged &&
    selectedReadyCount > 0;

  useEffect(() => {
    if (!confirmationExpired && !recipientKeyChanged) return;
    const operationId = operationIdRef.current;
    if (!operationId) return;
    discardPrivateCheckInOperation(operationId);
    operationIdRef.current = null;
  }, [
    confirmationExpired,
    discardPrivateCheckInOperation,
    recipientKeyChanged,
  ]);

  useEffect(
    () => () => {
      discardPrivateCheckInOperation(operationIdRef.current);
    },
    [discardPrivateCheckInOperation],
  );

  const submit = async () => {
    if (!canSubmit || busy) return;
    const reviewedPoint = confirmedPoint ?? point;
    if (!reviewedPoint) return;
    const operationId =
      operationIdRef.current ?? createPrivateCheckInOperationId();
    const confirmationTime = confirmedAt ?? new Date().toISOString();
    operationIdRef.current = operationId;
    if (!confirmedRecipientKeysRef.current) {
      confirmedRecipientKeysRef.current = Object.fromEntries(
        contacts
          .filter((recipient) => checkedIds.includes(recipient.userId))
          .map((recipient) => [recipient.userId, recipient.keyId ?? null]),
      );
    }
    setConfirmedPoint(reviewedPoint);
    setConfirmedAt(confirmationTime);
    setSubmitting(true);
    try {
      const result = await vm.onCheckIn({
        recipientIds: checkedIds,
        durationHours: effectiveDuration,
        message: message.trim() || DEFAULT_CHECK_IN_MESSAGE,
        point: reviewedPoint,
        clientOperationId: operationId,
        confirmedAt: confirmationTime,
        sourceCircleId: circleSelection?.circle.id ?? null,
      });
      if (result.succeededRecipientIds.length > 0) {
        setCompletedRecipientIds((current) => [
          ...new Set([...current, ...result.succeededRecipientIds]),
        ]);
      }
      if (result.failedRecipientIds.length > 0) {
        setCheckedIds(result.failedRecipientIds);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const editAndReconfirm = () => {
    discardPrivateCheckInOperation(operationIdRef.current);
    setConfirmedPoint(null);
    setConfirmedAt(null);
    setNowMs(Date.now());
    operationIdRef.current = null;
    confirmedRecipientKeysRef.current = null;
  };

  const close = () => {
    discardPrivateCheckInOperation(operationIdRef.current);
    operationIdRef.current = null;
    onClose();
  };

  return (
    <div>
      {/* Header — title + Cancel link (no back arrow; Cancel dismisses). */}
      <div className="flex items-start justify-between gap-3">
        <h1 className="max-w-[310px] text-[28px] font-bold leading-[1.12] tracking-normal text-foreground">
          Let trusted people know you&apos;re here
        </h1>
        <button
          type="button"
          onClick={close}
          className="shrink-0 pt-1 text-[15px] text-[color:var(--app-accent)] dark:text-[color:var(--app-accent)]"
        >
          Cancel
        </button>
      </div>

      {entrySource === "nearby" ? (
        <section
          className="mt-4 flex gap-3 rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-accent)]/10 p-4"
          data-testid="nearby-private-share-disclosure"
        >
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]" />
          <div>
            <p className="text-[15px] font-semibold leading-5 text-foreground">
              Nearby and private sharing are separate
            </p>
            <p className="mt-1 text-[15px] leading-[20px] text-[#8E8E93]">
              Nearby sees your name only. Selected people get this share.
            </p>
          </div>
        </section>
      ) : null}

      {/* YOUR LOCATION */}
      <SectionLabel>Your location</SectionLabel>
      <section className={cn(CARD, "overflow-hidden")}>
        <div className="flex items-center gap-3 px-4 py-[13px]">
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold text-foreground">
              {confirmedPoint
                ? "Location confirmed for this share"
                : point
                  ? pointIsFresh
                    ? "Live location ready"
                    : "Location needs a refresh"
                  : "Location not captured yet"}
            </p>
            <p className="mt-1 text-[15px] leading-[20px] text-[#8E8E93]">
              {point
                ? confirmedPoint
                  ? `${accuracy ?? "Location captured"} · Retrying the exact point you reviewed`
                  : `${accuracy ?? "Location captured"} · ${vm.formatDateTime(point.capturedAt)}`
                : "Capture your current location to check in."}
            </p>
          </div>
          <button
            type="button"
            onClick={
              confirmedPoint
                ? () => setMapViewportResetKey((current) => current + 1)
                : vm.onShowMyLocation
            }
            disabled={vm.busy === "selfLocation"}
            aria-label={
              confirmedPoint
                ? "Recenter map on the confirmed check-in location"
                : undefined
            }
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-black/[0.14] px-[13px] py-[7px] text-[13px] font-semibold text-[color:var(--app-accent)] disabled:opacity-60 dark:border-white/20 dark:text-[color:var(--app-accent)]"
          >
            <RefreshCw
              className={cn(
                "h-3 w-3",
                vm.busy === "selfLocation" && "animate-spin",
              )}
            />
            {confirmedPoint ? "Recenter" : point ? "Refresh" : "Capture"}
          </button>
        </div>
        {point && !pointIsFresh ? (
          <p className="px-4 pb-3 text-xs font-medium text-amber-700 dark:text-amber-300">
            {confirmationExpired
              ? "This confirmation expired. Edit details and reconfirm to continue."
              : "Refresh so the location you review is no more than one minute old."}
          </p>
        ) : null}
        {recipientKeyChanged ? (
          <p className="px-4 pb-3 text-xs font-medium text-amber-700 dark:text-amber-300">
            A selected person&apos;s secure key changed. Edit and reconfirm this
            private share.
          </p>
        ) : null}
        {vm.myLocationError ? (
          <p className="px-4 pb-3 text-xs font-medium text-red-600 dark:text-red-300">
            {vm.myLocationError}
          </p>
        ) : null}
        {point ? (
          <div className="px-3 pb-3">
            {vm.renderMapPreview(
              point,
              false,
              `check-in:${mapViewportResetKey}`,
            )}
          </div>
        ) : null}
      </section>

      {/* WHO SHOULD KNOW? */}
      <SectionLabel>Who should know?</SectionLabel>
      {vm.circles.length ? (
        <div className={cn(CARD, "mb-2 overflow-hidden")}>
          {vm.circles.map((circle, index) => {
            const selected =
              circleSelection?.circle.id === circle.id && circleFullySelected;
            // STATE BEATS CATEGORY: a circle is the people role, but one
            // holding nobody except the viewer has nothing to report and
            // stays neutral. `memberCount` includes the viewer, so the count
            // that decides this is `memberCount - 1` — the same test the
            // Circles list and the SMS contacts list apply.
            const circleRole = roleClasses("people", {
              inactive: Math.max(0, circle.memberCount - 1) === 0,
            });
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
                <span
                  className={cn(
                    "flex h-[34px] w-[34px] items-center justify-center rounded-[10px]",
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
                  <span className="block text-[15px] leading-5 text-muted-foreground">
                    {selected
                      ? `${circleSelection.ready.length} ready now`
                      : `${circle.memberCount} members`}
                  </span>
                </span>
                <span className="text-[13px] font-semibold leading-[18px] text-[color:var(--app-accent)]">
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
              <p className="border-t border-[color:var(--app-separator)] px-4 py-2.5 text-[15px] leading-[20px] text-[#8E8E93]">
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
              <div className="border-t border-[color:var(--app-separator)] px-4 py-3">
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

      <div
        className={cn(CARD, "mb-2 flex items-center gap-2 px-[14px] py-[11px]")}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-[color:var(--app-tertiary-label)]" />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={retryLocked}
          placeholder="Search contacts…"
          className="min-w-0 flex-1 bg-transparent text-[15px] leading-5 text-foreground outline-none placeholder:text-[color:var(--app-tertiary-label)] disabled:cursor-not-allowed"
        />
      </div>
      {filtered.length ? (
        <div className={cn(CARD, "px-4")}>
          <div className={CONTACT_LIST_SCROLL_CLASS}>
            {filtered.map((recipient, index) => (
              <ContactRow
                key={recipient.userId}
                checked={checkedIds.includes(recipient.userId)}
                ready={vm.isRecipientShareReady(recipient)}
                locked={retryLocked}
                completed={completedRecipientIds.includes(recipient.userId)}
                label={vm.recipientLabel(recipient)}
                isLast={index === filtered.length - 1}
                onToggle={() => toggle(recipient.userId)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div
          className={cn(CARD, "p-5 text-center text-sm text-muted-foreground")}
        >
          {contacts.length === 0
            ? "No trusted contacts yet. Add people to your Circle first."
          : "No matching contacts."}
        </div>
      )}
      {completedRecipientIds.length > 0 ? (
        <section
          className="mt-3 rounded-[12px] border border-[color:var(--app-success-border)] bg-[color:var(--app-success-tint)] px-4 py-3"
          data-testid="private-check-in-partial-success"
        >
          <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            Shared with {completedRecipientIds.length}{" "}
            {completedRecipientIds.length === 1 ? "person" : "people"} already
          </p>
          <p className="mt-1 text-[15px] leading-[20px] text-[#8E8E93]">
            Edits apply only to people still waiting.
          </p>
        </section>
      ) : null}

      {/* DURATION — gray segmented control incl. "Until I stop". */}
      <SectionLabel>Duration</SectionLabel>
      <div className="flex rounded-[10px] bg-[color:var(--app-neutral-fill-strong)] p-0.5">
        {durationOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={option.onClick}
            disabled={retryLocked}
            style={{ flexGrow: option.grow, flexBasis: 0 }}
            className={cn(
              "whitespace-nowrap rounded-[7px] py-[9px] text-center text-[13px] transition-colors",
              option.active
                ? "bg-[color:var(--app-card-surface-default-solid)] font-semibold text-foreground shadow-none"
                : "font-normal text-foreground/80",
              retryLocked && "cursor-not-allowed opacity-60",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-2 flex items-center gap-1.5 px-1 text-[15px] leading-[20px] text-[#8E8E93]">
        <Shield className="h-3 w-3 shrink-0" strokeWidth={1.5} />
        Stops automatically.
      </p>

      {/* MESSAGE — encrypted with the reviewed point for selected recipients. */}
      <SectionLabel>Message</SectionLabel>
      <div className={cn(CARD, "px-4 py-[14px]")}>
        <textarea
          value={message}
          onChange={(event) =>
            setMessage(event.target.value.slice(0, CHECK_IN_MESSAGE_MAX_LENGTH))
          }
          disabled={retryLocked}
          rows={2}
          placeholder={DEFAULT_CHECK_IN_MESSAGE}
          className="w-full resize-none bg-transparent text-[15px] leading-5 text-foreground outline-none placeholder:text-[color:var(--app-tertiary-label)] disabled:cursor-not-allowed"
        />
        <p className="mt-2 text-right text-[12px] text-[color:var(--app-tertiary-label)]">
          {message.length}/{CHECK_IN_MESSAGE_MAX_LENGTH}
        </p>
      </div>
      <p className="mb-[18px] mt-2 px-1 text-[15px] leading-[20px] text-[#8E8E93]">
        {retryLocked
          ? "Retry sends only to failed people."
          : "Encrypted with your location."}
      </p>
      {retryLocked ? (
        <button
          type="button"
          className="mb-3 w-full rounded-full border border-black/[0.12] py-3 text-sm font-semibold text-foreground transition-colors hover:bg-black/[0.03] dark:border-white/[0.14] dark:hover:bg-white/[0.05]"
          disabled={busy}
          onClick={editAndReconfirm}
        >
          {completedRecipientIds.length > 0
            ? "Edit remaining details and reconfirm"
            : "Edit details and reconfirm"}
        </button>
      ) : null}

      {/* Primary CTA — full blue pill (design). */}
      <button
        type="button"
        onClick={() => void submit()}
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
          ? recipientKeyChanged
            ? "Secure key changed — reconfirm"
            : confirmationExpired
            ? "Confirmation expired"
            : !pointIsFresh
            ? "Refresh your location first"
            : selectedReadyCount > 0
              ? entrySource === "nearby"
                ? `Share encrypted location with ${selectedReadyCount} ${
                    selectedReadyCount === 1 ? "person" : "people"
                  }`
                : `Check in with ${selectedReadyCount} ${
                    selectedReadyCount === 1 ? "person" : "people"
                  }`
              : "Select who should know"
          : "Capture your location first"}
      </button>
    </div>
  );
}
