"use client";

/**
 * One Location redesign — Check-In flow (Quick Action).
 *
 * "Let trusted people know you're here." A focused, full-screen task flow that
 * reuses the existing encrypted location-share pipeline via `vm.onCheckIn`.
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
import { Check, MapPin, RefreshCw, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlainLocationPoint } from "@/lib/one-location/types";

import { TaskFlowHeader } from "./primitives";
import { PersonSearchInput } from "./selectors";
import { CARD_SURFACE, MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
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

// Contact list cap: trusted circles can be long, so show ~4 rows then scroll.
// max-h fits four ~64px rows (avatar h-10 + p-3) plus the 10px space-y gaps,
// with a sliver of the fifth peeking to signal there's more. A thin,
// touch-friendly scrollbar keeps it unobtrusive on mobile. Mirrors the
// People-tab pattern (PEOPLE_LIST_SCROLL_CLASS) for visual consistency.
const CONTACT_LIST_SCROLL_CLASS =
  "max-h-[300px] space-y-2.5 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/15 dark:[&::-webkit-scrollbar-thumb]:bg-white/20";

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

function ContactRow({
  index,
  checked,
  ready,
  label,
  subtitle,
  onToggle,
}: {
  index: number;
  checked: boolean;
  ready: boolean;
  label: string;
  subtitle: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={ready ? onToggle : undefined}
      disabled={!ready}
      aria-pressed={checked}
      className={cn(
        SUBCARD_SURFACE,
        "flex w-full items-center gap-3 p-3 text-left transition-all duration-150",
        ready
          ? "hover:border-[#d4a574]/40 active:scale-[0.99]"
          : "cursor-not-allowed opacity-60",
        checked && "border-[#d4a574]/60 ring-1 ring-[#d4a574]/30",
      )}
    >
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          avatarTone(index),
        )}
        aria-hidden
      >
        {initialsOf(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">
          {label}
        </span>
        <span className={cn(MUTED_TEXT, "block truncate")}>
          {ready ? subtitle : "Not ready to receive location"}
        </span>
      </span>
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border-2 transition-colors",
          checked
            ? "border-[#d4a574] bg-[#d4a574] text-white"
            : "border-border bg-background",
        )}
      >
        {checked ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
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
  const contacts = vm.sosRecipients;
  const busy = vm.busy === "share" || vm.busy === "selfLocation";

  // Local selection state, seeded once from the trusted (ready) contacts so the
  // first ready person is pre-checked (mirrors the reference design).
  const [search, setSearch] = useState("");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [durationValue, setDurationValue] = useState("1");
  const [untilStop, setUntilStop] = useState(false);
  const [message, setMessage] = useState(DEFAULT_CHECK_IN_MESSAGE);
  const [seeded, setSeeded] = useState(false);

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

  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Check-In"
        title="Let trusted people know you're here"
        onBack={onClose}
      />

      {/* YOUR LOCATION */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#d4a574]/12 text-[#d4a574]">
            <MapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Your location
            </p>
            {point ? (
              <>
                <p className="mt-0.5 text-[15px] font-semibold text-foreground">
                  Live location ready
                </p>
                <p className={cn(MUTED_TEXT, "mt-0.5")}>
                  {accuracy ?? "Location captured"} ·{" "}
                  {vm.formatDateTime(point.capturedAt)}
                </p>
              </>
            ) : (
              <>
                <p className="mt-0.5 text-[15px] font-semibold text-foreground">
                  Location not captured yet
                </p>
                <p className={cn(MUTED_TEXT, "mt-0.5")}>
                  Capture your current location to check in.
                </p>
              </>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={vm.onShowMyLocation}
            isLoading={vm.busy === "selfLocation"}
            className="h-9 shrink-0 rounded-full px-3 text-xs"
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {point ? "Refresh" : "Capture"}
          </Button>
        </div>
        {vm.myLocationError ? (
          <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-300">
            {vm.myLocationError}
          </p>
        ) : null}
        {point ? (
          <div className="mt-3">{vm.renderMapPreview(point, false)}</div>
        ) : null}
      </section>

      {/* WHO SHOULD KNOW? */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Who should know?
        </p>
        <PersonSearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search contacts..."
        />
        <div
          className={cn(
            "mt-3",
            filtered.length ? CONTACT_LIST_SCROLL_CLASS : "space-y-2.5",
          )}
        >
          {filtered.length ? (
            filtered.map((recipient, index) => (
              <ContactRow
                key={recipient.userId}
                index={index}
                checked={checkedIds.includes(recipient.userId)}
                ready={vm.isRecipientShareReady(recipient)}
                label={vm.recipientLabel(recipient)}
                subtitle={vm.recipientSubtitle(recipient)}
                onToggle={() => toggle(recipient.userId)}
              />
            ))
          ) : (
            <div
              className={cn(
                SUBCARD_SURFACE,
                "p-5 text-center text-sm text-muted-foreground",
              )}
            >
              {contacts.length === 0
                ? "No trusted contacts yet. Add people to your Circle first."
                : "No matching contacts."}
            </div>
          )}
        </div>
      </section>

      {/* DURATION */}
      <section
        className={cn(
          "rounded-[var(--app-card-radius-standard)] border border-sky-500/20 bg-sky-500/[0.06] p-4 dark:bg-sky-400/[0.08]",
        )}
      >
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
          Duration
        </p>
        <div className="flex flex-wrap gap-2">
          {CHECK_IN_DURATIONS.map((option) => {
            const active = !untilStop && option.value === durationValue;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setUntilStop(false);
                  setDurationValue(option.value);
                }}
                className={cn(
                  "h-9 rounded-full border px-4 text-sm font-medium transition-colors",
                  active
                    ? "border-[#d4a574] bg-[#d4a574] text-white"
                    : "border-border/70 bg-background text-foreground hover:border-[#d4a574]/40",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setUntilStop((value) => !value)}
          className={cn(
            "mt-3 flex w-full items-center gap-2 rounded-[12px] border px-3 py-2.5 text-left text-sm font-medium transition-colors",
            untilStop
              ? "border-[#d4a574]/50 bg-[#d4a574]/10 text-foreground"
              : "border-border/70 bg-background text-foreground hover:border-[#d4a574]/40",
          )}
        >
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full border-2",
              untilStop ? "border-[#d4a574] bg-[#d4a574]" : "border-border",
            )}
          >
            {untilStop ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
          </span>
          Until I say stop
        </button>
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" />
          Sharing stops automatically · no manual revoke needed
        </p>
      </section>

      {/* MESSAGE — sent with the check-in and shown in the recipient's
          notification (e.g. "Alex: I've checked in here, let's catch up"). */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Message
          </p>
          <span className="text-[11px] font-medium text-muted-foreground">
            {message.length}/{CHECK_IN_MESSAGE_MAX_LENGTH}
          </span>
        </div>
        <textarea
          value={message}
          onChange={(event) =>
            setMessage(event.target.value.slice(0, CHECK_IN_MESSAGE_MAX_LENGTH))
          }
          rows={2}
          placeholder={DEFAULT_CHECK_IN_MESSAGE}
          className="w-full rounded-[14px] border border-border/70 bg-background p-3 text-sm text-foreground outline-none transition-shadow focus:ring-2 focus:ring-[#d4a574]/25"
        />
        <p className={cn(MUTED_TEXT, "mt-2")}>
          They&apos;ll see this with your name in the notification, so they know
          who checked in and why.
        </p>
      </section>

      {/* Action bar — inline so it renders above the chat panel, not floating
          over it. Buttons stack directly under the flow content. */}
      <div className="space-y-2 pt-1">
        <Button
          onClick={() =>
            vm.onCheckIn(
              checkedIds,
              effectiveDuration,
              message.trim() || DEFAULT_CHECK_IN_MESSAGE,
            )
          }
          disabled={!point || selectedReadyCount === 0}
          isLoading={busy}
          className="h-12 w-full rounded-2xl bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-600/90 disabled:opacity-50"
        >
          <Check className="mr-1.5 h-5 w-5" strokeWidth={3} />
          {point
            ? selectedReadyCount > 0
              ? `Check in with ${selectedReadyCount} ${
                  selectedReadyCount === 1 ? "person" : "people"
                }`
              : "Select who should know"
            : "Capture your location first"}
        </Button>
        <Button
          variant="ghost"
          onClick={onClose}
          className="h-10 w-full rounded-2xl text-sm text-muted-foreground"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
