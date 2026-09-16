"use client";

/**
 * The confirmation card for a `pending_action` frame.
 *
 * The card is the receipt the model narrates from: the summary, the real
 * entities (names and photos the server sent, never ids), the tier, and a
 * countdown to `expires_at`. Voice-tier actions accept a spoken yes or a tap;
 * tap-tier actions accept only the tap (the receipt token rides with it).
 *
 * Focus lands on the card when it mounts so a screen reader hears the ask;
 * Cancel is the first tab stop so the safe exit is the nearest one. Nothing
 * here says "done" — that comes from `pending_action.resolved executed`.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  roleClasses,
  type SemanticRole,
} from "@/lib/morphy-ux/tokens/semantic-roles";
import type { PendingActionView } from "@/lib/one-voice/session-types";
import { cn } from "@/lib/utils";

import { EntityCard } from "./entity-card";

export type PendingActionCardProps = {
  action: PendingActionView;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Skip the mount focus (the control does this while the panel is collapsed). */
  autoFocus?: boolean;
};

const DESTRUCTIVE_TOOLS = new Set<string>([
  "delete_circle",
  "leave_circle",
  "remove_circle_member",
  "remove_connection",
  "remove_emergency_contact",
  "revoke_public_link",
  "stop_share",
  "stop_save_my_soul",
  "trigger_save_my_soul",
  "turn_sharing_off",
  "cancel_connection_request",
  "cancel_circle_invite",
  "withdraw_request",
]);
const DESTRUCTIVE_PREFIXES = [
  "delete_",
  "remove_",
  "revoke_",
  "stop_",
  "leave_",
];

/** Real consequence earns the danger role; a consent tap is still an action. */
export function pendingActionRole(
  action: Pick<PendingActionView, "tool" | "tier">,
): SemanticRole {
  const tool = String(action.tool || "").trim();
  if (DESTRUCTIVE_TOOLS.has(tool)) return "danger";
  if (
    action.tier === "tap" &&
    DESTRUCTIVE_PREFIXES.some((prefix) => tool.startsWith(prefix))
  )
    return "danger";
  return "action";
}

/** The instruction line under the summary; the tier decides it. */
export function pendingActionInstruction(
  action: Pick<PendingActionView, "requiresTap">,
): string {
  return action.requiresTap
    ? "Tap Confirm to continue"
    : "Say yes, or tap Confirm";
}

export const RESOLVED_LABEL: Record<
  NonNullable<PendingActionView["resolvedStatus"]>,
  string
> = {
  executed: "Done",
  failed: "Didn't go through",
  cancelled: "Cancelled",
  expired: "Expired",
  not_pending: "No longer waiting",
};

/** Milliseconds until `expires_at`, clamped at zero; null when there is none. */
export function remainingMs(
  expiresAt: string | null | undefined,
  now: number,
): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function useCountdown(
  expiresAt: string | null | undefined,
  active: boolean,
): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !expiresAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, active]);
  return remainingMs(expiresAt, now);
}

export function PendingActionCard({
  action,
  onConfirm,
  onCancel,
  busy = false,
  autoFocus = true,
}: PendingActionCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const resolved = action.resolvedStatus;
  const open = resolved === null;
  const remaining = useCountdown(action.expires_at, open);
  const expired = open && remaining !== null && remaining <= 0;
  const role = pendingActionRole(action);
  const palette = roleClasses(role);
  const Icon = role === "danger" ? AlertTriangle : ShieldCheck;

  useEffect(() => {
    if (!autoFocus || !open) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [action.pending_action_id, autoFocus, open]);

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label={
        open
          ? "Confirm this action"
          : `Action ${RESOLVED_LABEL[resolved].toLowerCase()}`
      }
      data-testid="one-voice-pending-action"
      data-pending-action-id={action.pending_action_id}
      data-tier={action.tier}
      data-resolved={resolved ?? undefined}
      className={cn(
        "rounded-[var(--app-card-radius-standard,24px)] border bg-[color:var(--app-primary-surface)] p-4 shadow-[var(--app-card-shadow-standard)] outline-none dark:shadow-none",
        "focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]",
        role === "danger" && open
          ? palette.border
          : "border-[color:var(--app-separator)]",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            palette.tile,
            palette.glyph,
          )}
          aria-hidden
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-5 text-[color:var(--app-label)]">
            {action.summary}
          </p>
          {open ? (
            <p
              data-testid="one-voice-pending-instruction"
              className="mt-0.5 text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]"
            >
              {pendingActionInstruction(action)}
            </p>
          ) : (
            <p
              data-testid="one-voice-pending-resolved"
              className={cn(
                "mt-0.5 inline-flex items-center gap-1 text-[13px] font-medium leading-[18px]",
                resolved === "executed"
                  ? roleClasses("success").glyph
                  : "text-[color:var(--app-secondary-label)]",
              )}
            >
              {resolved === "executed" ? (
                <Check className="h-3.5 w-3.5" aria-hidden />
              ) : null}
              {RESOLVED_LABEL[resolved]}
            </p>
          )}
        </div>
        {open && remaining !== null ? (
          <span
            data-testid="one-voice-pending-countdown"
            aria-live="off"
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-[12px] tabular-nums",
              expired
                ? roleClasses("warning").glyph
                : "text-[color:var(--app-tertiary-label)]",
            )}
          >
            <Clock className="h-3 w-3" aria-hidden />
            <span className="sr-only">
              {expired ? "Expired" : "Expires in"}{" "}
            </span>
            {expired ? "Expired" : formatCountdown(remaining)}
          </span>
        ) : null}
      </div>

      {action.entities.length > 0 ? (
        <div className="mt-2 flex flex-col divide-y divide-[color:var(--app-separator)] pl-11">
          {action.entities.map((entity, index) => (
            <EntityCard key={`${entity.kind}:${index}`} card={entity} compact />
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="mt-3 flex items-center gap-2">
          <Button
            data-testid="one-voice-pending-cancel"
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onCancel}
            className="min-h-11 min-w-11 px-4"
          >
            <X className="h-4 w-4" aria-hidden />
            Cancel
          </Button>
          <Button
            data-testid="one-voice-pending-confirm"
            type="button"
            variant={role === "danger" ? "destructive" : "default"}
            size="sm"
            isLoading={busy}
            disabled={expired}
            onClick={onConfirm}
            className="min-h-11 flex-1 px-4"
          >
            Confirm
          </Button>
        </div>
      ) : null}
    </div>
  );
}
