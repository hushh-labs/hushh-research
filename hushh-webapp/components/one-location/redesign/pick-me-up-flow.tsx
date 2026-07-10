"use client";

/**
 * One Location redesign — Pick Me Up flow (Quick Action).
 *
 * "Ask a trusted person to come get you." The inbound counterpart to Drive To:
 * instead of telling people where you're going, you ask someone to come to
 * exactly where you are right now (stranded, no ride, unsafe late night, a
 * child/elder who needs a lift, car trouble, airport/station pickup).
 *
 * PRESENTATION + LOCAL SELECTION STATE ONLY.
 * - The list of people ("Who can come get you?") is the SAME trusted circle used
 *   by SOS / Check-In (`vm.sosRecipients`), so help comes from people you already
 *   trust with your live location.
 * - On confirm it hands the chosen recipient ids + duration + a pickup message to
 *   `vm.onPickMeUp`, which runs the exact same createGrant + encrypt + publish
 *   path as a normal share (no new crypto, no new consent surface). Recipients
 *   receive your LIVE location, so they can navigate straight to you and watch
 *   you until they arrive.
 */

import { useMemo, useState } from "react";
import { Check, Clock, Hand, MapPin, Navigation, RefreshCw, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlainLocationPoint } from "@/lib/one-location/types";

import { TaskFlowHeader } from "./primitives";
import { PersonSearchInput } from "./selectors";
import { CARD_SURFACE, MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
import type { LocationHubViewModel } from "./location-redesign-hub";

/** How long to keep sharing your live location while you wait for the pickup. */
const PICK_ME_UP_DURATIONS: { value: string; label: string }[] = [
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "2", label: "2 hours" },
];
/** "Until I'm picked up" maps to the longest supported live-share window. */
const UNTIL_PICKED_UP_VALUE = "4";

/**
 * Urgency shapes the message the recipient sees in their notification, so a
 * casual "whenever you can" pickup reads differently from an "I need a ride
 * now" one. The user can still add their own detail on top.
 */
type UrgencyValue = "flexible" | "soon" | "urgent";
const URGENCY_OPTIONS: {
  value: UrgencyValue;
  label: string;
  lead: string;
  tone: string;
}[] = [
  {
    value: "flexible",
    label: "Whenever you can",
    lead: "Could you pick me up when you get a chance?",
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  {
    value: "soon",
    label: "Soon",
    lead: "Could you come pick me up soon?",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  {
    value: "urgent",
    label: "Urgent",
    lead: "I need a ride now — please pick me up ASAP.",
    tone: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  },
];

const PICK_ME_UP_NOTE_MAX_LENGTH = 120;

// Contact list cap: trusted circles can be long, so show ~4 rows then scroll.
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

/**
 * Compose the message the recipient reads. The urgency lead is always present so
 * the intent is unmistakable; the optional detail is appended verbatim.
 */
export function composePickMeUpMessage(urgency: UrgencyValue, note: string): string {
  const lead =
    URGENCY_OPTIONS.find((option) => option.value === urgency)?.lead ??
    URGENCY_OPTIONS[0]!.lead;
  const detail = note.trim();
  const composed = detail ? `${lead} ${detail}` : lead;
  return composed.slice(0, 160);
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

export function PickMeUpFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const contacts = vm.sosRecipients;
  const busy = vm.busy === "share" || vm.busy === "selfLocation";

  const [search, setSearch] = useState("");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [durationValue, setDurationValue] = useState("1");
  const [untilPickedUp, setUntilPickedUp] = useState(true);
  const [urgency, setUrgency] = useState<UrgencyValue>("soon");
  const [note, setNote] = useState("");

  // No default selection: the user explicitly chooses who can come get them.

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

  const effectiveDuration = untilPickedUp ? UNTIL_PICKED_UP_VALUE : durationValue;
  const point = vm.myLocationPoint;
  const accuracy = accuracyLine(point);
  const previewMessage = composePickMeUpMessage(urgency, note);

  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Pick Me Up"
        title="Ask someone to come get you"
        description="Share your live location so a trusted person can drive straight to you."
        onBack={onClose}
      />

      {/* YOUR LOCATION — the exact point the helper will drive to. */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#d4a574]/12 text-[#d4a574]">
            <MapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Where to pick you up
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
                  Capture your current location so they know where to come.
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

      {/* WHO CAN COME GET YOU? */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Who can come get you?
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

      {/* URGENCY — sets the tone of the request in the recipient's alert. */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          How soon do you need it?
        </p>
        <div className="grid grid-cols-3 gap-2">
          {URGENCY_OPTIONS.map((option) => {
            const active = urgency === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setUrgency(option.value)}
                className={cn(
                  "flex h-10 items-center justify-center rounded-full border px-2 text-[13px] font-semibold transition-colors",
                  active
                    ? option.tone
                    : "border-border/70 bg-background text-muted-foreground hover:border-[#d4a574]/40",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* DURATION */}
      <section
        className={cn(
          "rounded-[var(--app-card-radius-standard)] border border-amber-500/20 bg-amber-500/[0.06] p-4 dark:bg-amber-400/[0.08]",
        )}
      >
        <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
          <Clock className="h-3.5 w-3.5" />
          Keep sharing for
        </p>
        <div className="flex flex-wrap gap-2">
          {PICK_ME_UP_DURATIONS.map((option) => {
            const active = !untilPickedUp && option.value === durationValue;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setUntilPickedUp(false);
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
          onClick={() => setUntilPickedUp((value) => !value)}
          className={cn(
            "mt-3 flex w-full items-center gap-2 rounded-[12px] border px-3 py-2.5 text-left text-sm font-medium transition-colors",
            untilPickedUp
              ? "border-[#d4a574]/50 bg-[#d4a574]/10 text-foreground"
              : "border-border/70 bg-background text-foreground hover:border-[#d4a574]/40",
          )}
        >
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full border-2",
              untilPickedUp ? "border-[#d4a574] bg-[#d4a574]" : "border-border",
            )}
          >
            {untilPickedUp ? (
              <span className="h-2 w-2 rounded-full bg-white" />
            ) : null}
          </span>
          Until I&apos;m picked up
        </button>
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" />
          Sharing stops automatically · no manual revoke needed
        </p>
      </section>

      {/* DETAIL — optional context appended to the pickup message. */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Add detail (optional)
          </p>
          <span className="text-[11px] font-medium text-muted-foreground">
            {note.length}/{PICK_ME_UP_NOTE_MAX_LENGTH}
          </span>
        </div>
        <textarea
          value={note}
          onChange={(event) =>
            setNote(event.target.value.slice(0, PICK_ME_UP_NOTE_MAX_LENGTH))
          }
          rows={2}
          placeholder="I'm at the north gate near the coffee cart"
          className="w-full rounded-[14px] border border-border/70 bg-background p-3 text-sm text-foreground outline-none transition-shadow focus:ring-2 focus:ring-[#d4a574]/25"
        />
        <div className={cn(SUBCARD_SURFACE, "mt-3 flex items-start gap-2 p-3")}>
          <Navigation className="mt-0.5 h-4 w-4 shrink-0 text-[#d4a574]" />
          <p className="min-w-0 text-xs leading-snug text-muted-foreground">
            They&apos;ll see:{" "}
            <span className="font-medium text-foreground">
              &ldquo;{previewMessage}&rdquo;
            </span>{" "}
            with your live location and one-tap directions to you.
          </p>
        </div>
      </section>

      {/* ACTION BAR */}
      <div className="space-y-2 pt-1">
        <Button
          onClick={() =>
            vm.onPickMeUp(checkedIds, effectiveDuration, previewMessage)
          }
          disabled={!point || selectedReadyCount === 0}
          isLoading={busy}
          className="h-12 w-full rounded-2xl bg-amber-600 text-base font-semibold text-white hover:bg-amber-600/90 disabled:opacity-50"
        >
          <Hand className="mr-1.5 h-5 w-5" />
          {point
            ? selectedReadyCount > 0
              ? `Ask ${selectedReadyCount} ${
                  selectedReadyCount === 1 ? "person" : "people"
                } to pick you up`
              : "Select who can come get you"
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
