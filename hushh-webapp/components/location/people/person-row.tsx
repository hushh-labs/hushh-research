"use client";

/**
 * One connected person on the People tab.
 *
 * Renders only what the server sent about them -- display name, photo,
 * relationship -- never an id, and never a name that came from speech. The
 * two actions navigate to the flows with `?person=<user_id>` so each flow
 * resolves the person again from server state.
 */

import { useEffect, useRef } from "react";
import { Hand, Navigation } from "lucide-react";

import { StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { cn } from "@/lib/utils";

export type PersonRowStatus = {
  label: string;
  tone: "ready" | "pending" | "live" | "neutral";
};

export type PersonRowAction = "ask" | "share";

export type PersonRowProps = {
  userId: string;
  /** Server-sent display name. */
  name: string;
  photoUrl?: string | null;
  /** Server-sent relationship label ("Family", "Friend", ...), if any. */
  relationship?: string | null;
  /** Phone-verified badge on the avatar. */
  verified?: boolean;
  /** False when the person has not finished Location setup (no recipient key). */
  canReceiveLocation?: boolean;
  status?: PersonRowStatus | null;
  /** Highlight + scroll into view (from `?person=`). */
  focused?: boolean;
  onAction: (action: PersonRowAction, userId: string) => void;
  className?: string;
};

const ACTION_BUTTON =
  "press-scale flex min-h-11 min-w-11 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors disabled:opacity-45 sm:flex-none";
const ACTION_PRIMARY =
  "bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]";

export function PersonRow({
  userId,
  name,
  photoUrl,
  relationship,
  verified = false,
  canReceiveLocation = true,
  status,
  focused = false,
  onAction,
  className,
}: PersonRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focused || !ref.current) return;
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current.scrollIntoView?.({
      block: "center",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [focused]);

  const detail = [
    relationship,
    canReceiveLocation ? null : "Hasn't finished Location setup",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      ref={ref}
      className={cn(
        SUBCARD_SURFACE,
        "space-y-3 p-3.5",
        focused && "ring-2 ring-inset ring-[color:var(--app-accent)]",
        className,
      )}
      data-testid="location-person-row"
      data-person-focused={focused ? "true" : undefined}
      aria-current={focused ? "true" : undefined}
    >
      <div className="flex items-center gap-3">
        <ConnectionPersonAvatar
          label={name}
          photoUrl={photoUrl}
          verified={verified}
        />
        <div className="min-w-0 flex-1">
          <p className="ui-text-row-label truncate">{name}</p>
          {detail ? (
            <p className={cn(MUTED_TEXT, "truncate")}>{detail}</p>
          ) : null}
        </div>
        {status ? (
          <StatusPill tone={status.tone} className="shrink-0">
            {status.label}
          </StatusPill>
        ) : null}
      </div>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={`Actions for ${name}`}
      >
        <button
          type="button"
          className={cn(ACTION_BUTTON, ACTION_PRIMARY)}
          onClick={() => onAction("ask", userId)}
          aria-label={`Ask ${name} for their location`}
        >
          <Hand className="h-4 w-4" aria-hidden="true" />
          Ask
        </button>
        <button
          type="button"
          className={cn(ACTION_BUTTON, ACTION_PRIMARY)}
          onClick={() => onAction("share", userId)}
          disabled={!canReceiveLocation}
          aria-label={`Share your location with ${name}`}
        >
          <Navigation className="h-4 w-4" aria-hidden="true" />
          Share
        </button>
      </div>
    </div>
  );
}
