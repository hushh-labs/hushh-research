"use client";

/**
 * A person or circle the relay has confirmed, rendered from the server's
 * `entity_card` payload (or a pending action's `entities`).
 *
 * The card renders ONLY what the server sent: the real name, the photo, the
 * relationship. It never renders an id, and a spoken name never reaches here
 * on its own. The relationship label is the persisted fact ("Connected"), not
 * an inference from what was said.
 */

import { MapPin, Users } from "lucide-react";

import { AvatarBubble } from "@/lib/morphy-ux/ui/surface-primitives";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import type { EntityCardPayload } from "@/lib/one-voice/protocol";
import { cn } from "@/lib/utils";

export type EntityCardProps = {
  card: EntityCardPayload;
  /** Small inline row (inside a pending action card). */
  compact?: boolean;
  className?: string;
};

const RELATIONSHIP_LABEL: Record<
  NonNullable<EntityCardPayload["relationship"]>,
  string
> = {
  connected: "Connected",
  pending_outgoing: "Request pending",
  pending_incoming: "Asked to connect",
  none: "Not connected",
  self: "You",
};

/** The visible name for an entity, never its id. */
export function entityDisplayName(
  card: Pick<EntityCardPayload, "display_name" | "name" | "kind">,
): string {
  const name = String(card.display_name || card.name || "").trim();
  if (name) return name;
  return card.kind === "circle" ? "Circle" : "Someone";
}

/** Up to two initials from a display name (letters and digits only). */
export function initialsFor(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (parts.length === 0) return "•";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "•";
}

/** The human relationship label for a person card; circles report membership. */
export function entityRelationshipLabel(
  card: EntityCardPayload,
): string | null {
  if (card.kind === "circle") {
    const count =
      typeof card.member_count === "number" ? card.member_count : null;
    const kind = String(card.kind_label || "").trim();
    if (count !== null) {
      const members = `${count} ${count === 1 ? "member" : "members"}`;
      return kind ? `${kind} · ${members}` : members;
    }
    return kind || null;
  }
  if (!card.relationship) return null;
  return RELATIONSHIP_LABEL[card.relationship] ?? null;
}

export function EntityCard({
  card,
  compact = false,
  className,
}: EntityCardProps) {
  const name = entityDisplayName(card);
  const label = entityRelationshipLabel(card);
  const people = roleClasses("people");
  const readyForLocation =
    card.kind === "person" && card.has_location_key === true;
  const size = compact ? 28 : 36;

  return (
    <div
      data-testid="one-voice-entity-card"
      data-entity-kind={card.kind}
      className={cn(
        "flex min-w-0 items-center gap-3",
        compact
          ? "py-1"
          : "rounded-[var(--app-card-radius-compact,16px)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-compact)] px-3 py-2.5",
        className,
      )}
    >
      {card.kind === "circle" ? (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full",
            people.tile,
            people.glyph,
          )}
          style={{ width: size, height: size }}
          aria-hidden
        >
          <Users className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden />
        </span>
      ) : (
        <AvatarBubble
          initials={initialsFor(name)}
          size={size}
          imageUrl={card.photo_url ?? null}
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span
          data-testid="one-voice-entity-name"
          className={cn(
            "truncate text-[color:var(--app-label)]",
            compact ? "text-[13px] font-medium" : "text-[15px] font-semibold",
          )}
        >
          {name}
        </span>
        {label ? (
          <span
            data-testid="one-voice-entity-relationship"
            className="truncate text-[12px] text-[color:var(--app-secondary-label)]"
          >
            {label}
          </span>
        ) : null}
      </span>
      {readyForLocation ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center",
            roleClasses("success").glyph,
          )}
          title="Ready for location"
        >
          <MapPin className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Ready for location</span>
        </span>
      ) : null}
    </div>
  );
}
