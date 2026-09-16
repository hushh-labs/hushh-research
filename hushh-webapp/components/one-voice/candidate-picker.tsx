"use client";

/**
 * "Which one did you mean?" — the relay's `candidate_picker` frame.
 *
 * Single-select rows, one per candidate the server sent, each with the real
 * photo and a disambiguator (relationship, location readiness). A tap hands
 * the server the candidate's canonical id; the id itself is never rendered.
 * "None of these" sends `candidate.choose none:true` so the model asks again.
 */

import { useId } from "react";
import { Check, MapPin, Users } from "lucide-react";

import { AvatarBubble } from "@/lib/morphy-ux/ui/surface-primitives";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import type { CandidatePublic } from "@/lib/one-voice/protocol";
import type { CandidatePickerView } from "@/lib/one-voice/session-types";
import { cn } from "@/lib/utils";

import { entityDisplayName, initialsFor } from "./entity-card";

export type CandidatePickerProps = {
  picker: CandidatePickerView;
  onPick: (id: string) => void;
  onNone: () => void;
  /** The id the user already tapped (server acknowledgement pending). */
  selectedId?: string | null;
  disabled?: boolean;
};

const RELATIONSHIP_LABEL: Record<string, string> = {
  connected: "Connected",
  pending_outgoing: "Request pending",
  pending_incoming: "Asked to connect",
  none: "Not connected",
  self: "You",
};

/** The canonical id the server expects back; null when the row has none. */
export function candidateId(
  kind: CandidatePickerView["kind"],
  candidate: CandidatePublic,
): string | null {
  const raw = kind === "circle" ? candidate.circle_id : candidate.user_id;
  const id = String(raw || "").trim();
  return id || null;
}

/** The secondary line that tells two same-named people apart. */
export function candidateDisambiguator(
  kind: CandidatePickerView["kind"],
  candidate: CandidatePublic,
): string {
  const parts: string[] = [];
  if (kind === "person") {
    const relationship = String(candidate.relationship || "").trim();
    if (relationship)
      parts.push(
        RELATIONSHIP_LABEL[relationship] ?? relationship.replace(/_/g, " "),
      );
    if (candidate.has_location_key === true) parts.push("Ready for location");
  }
  return parts.join(" · ");
}

export function CandidatePicker({
  picker,
  onPick,
  onNone,
  selectedId = null,
  disabled = false,
}: CandidatePickerProps) {
  const headingId = useId();
  const rows = picker.candidates
    .map((candidate) => ({
      candidate,
      id: candidateId(picker.kind, candidate),
    }))
    .filter(
      (row): row is { candidate: CandidatePublic; id: string } =>
        row.id !== null,
    );

  return (
    <section
      data-testid="one-voice-candidate-picker"
      aria-labelledby={headingId}
      className="rounded-[var(--app-card-radius-standard,24px)] bg-[color:var(--app-card-surface-default-solid)] p-3 shadow-[var(--app-card-shadow-standard)]"
    >
      <p
        id={headingId}
        className="px-1 pb-2 text-[15px] font-semibold text-[color:var(--app-label)]"
      >
        {picker.question ||
          (picker.kind === "circle" ? "Which circle?" : "Which person?")}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        className="flex flex-col gap-1"
      >
        {rows.map(({ candidate, id }) => {
          const name = entityDisplayName({ ...candidate, kind: picker.kind });
          const detail = candidateDisambiguator(picker.kind, candidate);
          const selected = selectedId === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={detail ? `${name}, ${detail}` : name}
              disabled={disabled}
              onClick={() => onPick(id)}
              data-testid="one-voice-candidate"
              className={cn(
                "flex min-h-11 w-full touch-manipulation items-center gap-3 rounded-[var(--app-card-radius-compact,16px)] px-2.5 py-2 text-left transition-colors motion-reduce:transition-none",
                "hover:bg-[color:var(--app-neutral-fill)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]",
                selected && "bg-[color:var(--app-accent-tint)]",
                disabled && "opacity-60",
              )}
            >
              {picker.kind === "circle" ? (
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                    roleClasses("people").tile,
                    roleClasses("people").glyph,
                  )}
                  aria-hidden
                >
                  <Users className="h-4 w-4" aria-hidden />
                </span>
              ) : (
                <AvatarBubble
                  initials={initialsFor(name)}
                  size={36}
                  imageUrl={candidate.photo_url ?? null}
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[15px] font-medium text-[color:var(--app-label)]">
                  {name}
                </span>
                {detail ? (
                  <span className="truncate text-[12px] text-[color:var(--app-secondary-label)]">
                    {detail}
                  </span>
                ) : null}
              </span>
              {candidate.has_location_key === true &&
              picker.kind === "person" ? (
                <MapPin
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    roleClasses("success").glyph,
                  )}
                  aria-hidden
                />
              ) : null}
              {selected ? (
                <Check
                  className={cn(
                    "h-4 w-4 shrink-0",
                    roleClasses("action").glyph,
                  )}
                  aria-hidden
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-testid="one-voice-candidate-none"
        disabled={disabled}
        onClick={onNone}
        className={cn(
          "mt-1 flex min-h-11 w-full touch-manipulation items-center justify-center rounded-[var(--app-card-radius-compact,16px)] px-3 text-[15px] font-medium",
          roleClasses("action").glyph,
          "hover:bg-[color:var(--app-accent-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]",
          disabled && "opacity-60",
        )}
      >
        None of these
      </button>
    </section>
  );
}
