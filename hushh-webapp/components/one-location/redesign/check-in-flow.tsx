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

import { ContactSourceBadge } from "@/components/connections/contact-source-badge";
import { circleMemberCountLabel } from "@/lib/one-location/circle-member-count";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import {
  filterPeopleByQuery,
  sortPeopleByName,
} from "@/lib/one-location/people-search";
import {
  ButtonLabel,
  HelperText,
  MediumRowLabel,
  PageSubtitle,
  RowDescription,
  SectionLabel as AppSectionLabel,
  StatusText,
  TrailingAction,
} from "@/components/app-ui/typography";
import {
  isCircleSelectionFullySelected,
  mergeRecipientsByUserId,
  type CircleRecipientSelection,
} from "@/lib/one-location/circle-recipient-selection";
import { ContactAvatar } from "@/components/one-location/redesign/contact-picker/atoms";
import { CircleGrowActions } from "@/components/one-location/redesign/circles/circle-grow-actions";

import { TaskFlowHeader } from "./primitives";
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
  photoUrl,
  verified,
  fromContacts,
  isLast,
  onToggle,
}: {
  checked: boolean;
  ready: boolean;
  locked: boolean;
  completed: boolean;
  label: string;
  photoUrl?: string | null;
  verified?: boolean;
  fromContacts?: boolean;
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
      <ContactAvatar
        label={label}
        photoUrl={photoUrl}
        verified={verified}
        className="h-[42px] w-[42px]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-1.5">
          <MediumRowLabel as="span" className="min-w-0 flex-1 truncate">
            {label}
          </MediumRowLabel>
          {fromContacts ? (
            <ContactSourceBadge className="mt-px shrink-0" />
          ) : null}
        </span>
        {completed ? (
          <StatusText
            as="span"
            className="block truncate text-[color:var(--app-success)]"
          >
            Already shared in this check-in
          </StatusText>
        ) : !ready ? (
          <RowDescription as="span" className="block truncate">
            Hasn't set up sharing yet
          </RowDescription>
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
  // Trusted is an auto-managed contact-sync view and may contain thousands of
  // connections. Private Check-In must stay an explicit, bounded choice, so
  // only user-managed/SMS Circles and direct contacts are selectable here.
  const selectableCircles = useMemo(
    () => vm.circles.filter((circle) => circle.systemKind !== "trusted"),
    [vm.circles],
  );
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
          "No one in this Circle can receive it yet.",
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

  // `contacts` is two lists merged (trusted contacts, then whichever Circle is
  // selected), so its order is "wherever each person happened to come from" —
  // and it changes the moment a Circle is picked. Ordering the rendered list
  // A–Z gives it a fixed place to look instead. Only the rendered list is
  // reordered: seeding, the ready count and every lookup below still read
  // `contacts`, so which person is pre-ticked does not move.
  const filtered = useMemo(
    () =>
      filterPeopleByQuery(
        sortPeopleByName(contacts, (r) => vm.recipientLabel(r)),
        search,
        (r) => vm.recipientLabel(r),
      ),
    [contacts, search, vm],
  );

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

  // Voice's `location.send_check_in` cannot reach this component's local
  // selection state directly, so it bumps `vm.voiceCheckInSendRequestId` and
  // this effect submits the draft that is ALREADY on screen -- same seeded
  // recipient/duration/message the tap button would send. The ref baseline
  // is read from the current prop rather than a fixed literal so a request
  // that fired before this screen was even open is not replayed on mount.
  const voiceSendRequestIdRef = useRef(vm.voiceCheckInSendRequestId);
  useEffect(() => {
    const requestId = vm.voiceCheckInSendRequestId;
    if (requestId === undefined || requestId === voiceSendRequestIdRef.current) {
      return;
    }
    voiceSendRequestIdRef.current = requestId;
    void submit();
    // `submit` deliberately excluded: it closes over this render's state, and
    // only a NEW request id -- not every re-render that recreates it -- should
    // retrigger a send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm.voiceCheckInSendRequestId]);

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
      {/* The last Location flow still drawing its own <h1>, which is how it
          ended up with a title treatment no other screen has: 28px/bold from a
          local class rather than the shared SCREEN_TITLE token. TaskFlowHeader
          owns the <h1> everywhere else; the crumb for ?action=check-in is
          "Check-In", so the title is too.

          Cancel stays. It is a decision ("do not do this thing"), not a back
          control — the shell already owns back — and it discards the pending
          private check-in operation as well as closing. */}
      <div className="flex items-start justify-between gap-3">
        <TaskFlowHeader
          eyebrow="Location"
          title="Check-In"
          description="Let trusted people know you're here."
        />
        <button
          type="button"
          onClick={close}
          className="shrink-0 pt-1 text-[color:var(--app-accent)]"
        >
          <TrailingAction as="span">Cancel</TrailingAction>
        </button>
      </div>

      {entrySource === "nearby" ? (
        <section
          className="mt-4 flex gap-3 rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-accent)]/10 p-4"
          data-testid="nearby-private-share-disclosure"
        >
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]" />
          <div>
            <MediumRowLabel as="p">
              Nearby and private sharing are separate
            </MediumRowLabel>
            <PageSubtitle as="p" className="mt-1">
              Nearby sees your name only. Selected people get this share.
            </PageSubtitle>
          </div>
        </section>
      ) : null}

      {/* YOUR LOCATION */}
      <SectionLabel>Your location</SectionLabel>
      <section className={cn(CARD, "overflow-hidden")}>
        <div className="flex items-center gap-3 px-4 py-[13px]">
          <div className="min-w-0 flex-1">
            <MediumRowLabel as="p">
              {confirmedPoint
                ? "Location confirmed for this share"
                : point
                  ? pointIsFresh
                    ? "Live location ready"
                    : "Location needs a refresh"
                  : "No location yet"}
            </MediumRowLabel>
            <PageSubtitle as="p" className="mt-1">
              {point
                ? confirmedPoint
                  ? `${accuracy ?? "Location found"} · Using the spot you confirmed`
                  : `${accuracy ?? "Location found"} · ${vm.formatDateTime(point.capturedAt)}`
                : "Find your location to check in."}
            </PageSubtitle>
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
            {confirmedPoint ? "Recenter" : point ? "Refresh" : "Find"}
          </button>
        </div>
        {point && !pointIsFresh ? (
          <HelperText className="px-4 pb-3 !text-[color:var(--app-warning)]">
            {confirmationExpired
              ? "That expired. Edit and confirm again."
              : "Refresh so the location you review is no more than one minute old."}
          </HelperText>
        ) : null}
        {recipientKeyChanged ? (
          <HelperText className="px-4 pb-3 !text-[color:var(--app-warning)]">
            A selected person&apos;s secure key changed. Edit and reconfirm this
            private share.
          </HelperText>
        ) : null}
        {vm.myLocationError ? (
          <HelperText className="px-4 pb-3 !text-[color:var(--app-destructive)]">
            {vm.myLocationError}
          </HelperText>
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
      {selectableCircles.length ? (
        <div className={cn(CARD, "mb-2 overflow-hidden")}>
          {selectableCircles.map((circle, index) => {
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
                  index < selectableCircles.length - 1 &&
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
                  <MediumRowLabel as="span" className="block truncate">
                    {circle.name}
                  </MediumRowLabel>
                  <RowDescription as="span" className="block">
                    {selected
                      ? `${circleSelection.ready.length} ready now`
                      : circleMemberCountLabel(circle.memberCount)}
                  </RowDescription>
                </span>
                <TrailingAction as="span">
                  {circleLoadingId === circle.id
                    ? "Loading…"
                    : selected
                      ? "Selected"
                      : "Select all"}
                </TrailingAction>
              </button>
            );
          })}
          {circleSelection ? (
            <>
              <HelperText className="border-t border-[color:var(--app-separator)] px-4 py-2.5">
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
              </HelperText>
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
                  onLoadEligibleConnectionsPage={
                    vm.onLoadNamedCircleEligibleConnectionsPage
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
        className={cn(
          CARD,
          "mb-2 flex items-center gap-2 px-[14px] py-[11px] focus-within:ring-2 focus-within:ring-inset focus-within:ring-[color:var(--app-accent-ring)]",
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-[color:var(--app-tertiary-label)]" />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={retryLocked}
          placeholder="Search contacts…"
          className="ui-text-input-value min-w-0 flex-1 bg-transparent outline-none placeholder:text-[color:var(--app-tertiary-label)] disabled:cursor-not-allowed"
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
                photoUrl={recipient.photoUrl}
                verified={Boolean(recipient.isRia)}
                fromContacts={recipient.connectedFromContacts}
                isLast={index === filtered.length - 1}
                onToggle={() => toggle(recipient.userId)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div
          className={cn(CARD, "p-5 text-center")}
        >
          <PageSubtitle as="span">
            {contacts.length === 0
              ? "No contacts yet. Add people to your Circle."
              : "No matching contacts."}
          </PageSubtitle>
        </div>
      )}
      {completedRecipientIds.length > 0 ? (
        <section
          className="mt-3 rounded-[12px] border border-[color:var(--app-success-border)] bg-[color:var(--app-success-tint)] px-4 py-3"
          data-testid="private-check-in-partial-success"
        >
          <StatusText as="p" className="text-[color:var(--app-success)]">
            Shared with {completedRecipientIds.length}{" "}
            {completedRecipientIds.length === 1 ? "person" : "people"} already
          </StatusText>
          <PageSubtitle as="p" className="mt-1">
            Edits apply only to people still waiting.
          </PageSubtitle>
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
            <StatusText as="span">{option.label}</StatusText>
          </button>
        ))}
      </div>
      <PageSubtitle as="p" className="mt-2 flex items-center gap-1.5 px-1">
        <Shield className="h-3 w-3 shrink-0" strokeWidth={1.5} />
        Stops automatically.
      </PageSubtitle>

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
          className="ui-text-input-value w-full resize-none bg-transparent outline-none placeholder:text-[color:var(--app-tertiary-label)] disabled:cursor-not-allowed"
        />
        <HelperText className="mt-2 text-right !text-[color:var(--app-tertiary-label)]">
          {message.length}/{CHECK_IN_MESSAGE_MAX_LENGTH}
        </HelperText>
      </div>
      <PageSubtitle as="p" className="mb-[18px] mt-2 px-1">
        {retryLocked
          ? "Encrypted. Sends again to the people it missed."
          : "Encrypted with your location."}
      </PageSubtitle>
      {retryLocked ? (
        <button
          type="button"
          className="mb-3 w-full rounded-full border border-[color:var(--app-separator)] py-3 text-[color:var(--app-label)] transition-colors hover:bg-[color:var(--app-secondary-surface)]"
          disabled={busy}
          onClick={editAndReconfirm}
        >
          <ButtonLabel as="span">Edit and confirm again</ButtonLabel>
        </button>
      ) : null}

      {/* Primary CTA — full blue pill (design). */}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit || busy}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] py-4 text-[color:var(--app-accent-fg)] transition-opacity",
          (!canSubmit || busy) && "opacity-50",
        )}
      >
        {busy ? (
          <RefreshCw className="h-[18px] w-[18px] animate-spin" />
        ) : (
          <CheckCircle2 className="h-[18px] w-[18px]" strokeWidth={1.8} />
        )}
        <ButtonLabel as="span">
          {point
            ? recipientKeyChanged
              ? "Their security key changed - confirm again"
              : confirmationExpired
                ? "Confirm your location again"
                : !pointIsFresh
                  ? "Refresh your location first"
                  : selectedReadyCount > 0
                    ? entrySource === "nearby"
                      ? `Share location with ${selectedReadyCount} ${
                          selectedReadyCount === 1 ? "person" : "people"
                        }`
                      : `Check in with ${selectedReadyCount} ${
                          selectedReadyCount === 1 ? "person" : "people"
                        }`
                    : "Choose who to tell"
            : "Get your location first"}
        </ButtonLabel>
      </button>
    </div>
  );
}
