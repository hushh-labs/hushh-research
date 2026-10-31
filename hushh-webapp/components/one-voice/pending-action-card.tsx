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

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Loader2,
  Pencil,
  ShieldCheck,
  X,
} from "@/components/icons";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  roleClasses,
  type SemanticRole,
} from "@/lib/morphy-ux/tokens/semantic-roles";
import {
  NAME_EDITABLE_TOOLS,
  NAME_EDIT_MAX_CHARS,
  SOS_GRANTS_CREATED,
} from "@/lib/one-voice/protocol";
import {
  isNeutralStatus,
  isPendingStatus,
} from "@/lib/one-voice/session-reducer";
import type {
  NameEditOutcome,
  PendingActionView,
} from "@/lib/one-voice/session-types";
import { cn } from "@/lib/utils";

import { EntityCard } from "./entity-card";

export type PendingActionCardProps = {
  action: PendingActionView;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Skip the mount focus (the control does this while the panel is collapsed). */
  autoFocus?: boolean;
  /**
   * Submit a typed name for this card. Passed only while the relay accepts
   * `name_edit`; the card offers "Edit name" only on an open card of a tool
   * in `NAME_EDITABLE_TOOLS`.
   */
  onEditName?: (name: string) => Promise<NameEditOutcome>;
};

/** The name as the relay will read it: trimmed, inner whitespace collapsed. */
export function collapseTypedName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

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

/**
 * Save My Soul labels by the RESULT status, not the resolution. The trigger
 * card resolves twice: first `executed` with `sos_grants_created`, which only
 * means the shares exist and the device is sending the position, and again
 * with the server-verified delivery report. "Done" is never written for an
 * armed alert; "Sent" only when the server saw every envelope.
 */
const SOS_RESOLVED_LABEL: Record<string, string> = {
  [SOS_GRANTS_CREATED]: "Armed · sending your position",
  sos_sent: "Sent",
  sos_partial: "Partly sent",
  sos_not_sent: "Not sent",
  // The check itself could not run: not a verdict either way.
  sos_unverified: "Couldn't confirm delivery",
  sos_stopped: "Stopped",
  sos_partially_stopped: "Partly stopped",
};

/**
 * Emergency-contact cards by RESULT status. The action executed, but
 * `roster_full`, `not_phone_verified`, `not_connected`, `already_contact` and
 * `not_a_contact` changed nothing, so they never earn the success check.
 */
const EMERGENCY_CONTACT_LABEL: Record<
  string,
  Record<string, { label: string; kind: ResolvedLabelKind }>
> = {
  add_emergency_contact: {
    added: { label: "Added", kind: "success" },
    already_contact: { label: "Not added", kind: "neutral" },
    not_phone_verified: { label: "Not added", kind: "neutral" },
    not_connected: { label: "Not added", kind: "neutral" },
    roster_full: { label: "Not added", kind: "neutral" },
  },
  remove_emergency_contact: {
    removed: { label: "Removed", kind: "success" },
    not_a_contact: { label: "No change", kind: "neutral" },
  },
};

export type ResolvedLabelKind = "success" | "pending" | "neutral";

/**
 * The line under the summary once the card has resolved. Derived from the
 * result status when it names an outcome of its own (Save My Soul, the
 * emergency roster), otherwise from the resolution. An executed action whose
 * result is a truthful "nothing changed" (a neutral status) reads "No change",
 * never "Done".
 */
export function resolvedLabel(
  action: Pick<PendingActionView, "resolvedStatus" | "resolvedResult"> &
    Partial<Pick<PendingActionView, "tool">>,
): { label: string; kind: ResolvedLabelKind } | null {
  const resolved = action.resolvedStatus;
  if (resolved === null) return null;
  const status = String(action.resolvedResult?.status || "").trim();
  if (status === "draft_open_requested") return { label: "Opening draft…", kind: "pending" };
  if (status === "draft_opened") return { label: "Draft opened", kind: "success" };
  if (status === "draft_not_opened") return { label: "Draft did not open", kind: "neutral" };
  if (status === "draft_open_unconfirmed") return { label: "Draft may be open · review it before sending", kind: "neutral" };
  const sos = SOS_RESOLVED_LABEL[status];
  if (sos) {
    return {
      label: sos,
      kind: isPendingStatus(status)
        ? "pending"
        : resolved === "executed" &&
            (status === "sos_sent" || status === "sos_stopped")
          ? "success"
          : "neutral",
    };
  }
  const byTool = EMERGENCY_CONTACT_LABEL[String(action.tool || "").trim()];
  const contact = byTool?.[status];
  if (contact) {
    return resolved === "executed"
      ? contact
      : { label: RESOLVED_LABEL[resolved], kind: "neutral" };
  }
  if (resolved === "executed" && status && isNeutralStatus(status)) {
    return { label: "No change", kind: "neutral" };
  }
  return {
    label: RESOLVED_LABEL[resolved],
    kind: resolved === "executed" ? "success" : "neutral",
  };
}

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

const NAME_EDIT_FALLBACK = "That didn't go through. Please try again.";

/**
 * The inline "Edit name" form. Mounted fresh each time it opens, prefilled
 * with the card's current name. Submitting hands the collapsed name to the
 * relay, which replaces the card; a refusal stays here, under the input. A
 * refusal that arrives after the form is gone (the relay cancelled the card
 * before it could prepare the new one) is shown as a toast instead.
 */
function NameEditor({
  initialName,
  canSubmit,
  onSubmit,
  onBack,
}: {
  initialName: string;
  canSubmit: boolean;
  onSubmit: (name: string) => Promise<NameEditOutcome>;
  onBack: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(false);
  const [draft, setDraft] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = collapseTypedName(draft);
  const tooLong = name.length > NAME_EDIT_MAX_CHARS;
  const reviewable = canSubmit && !submitting && name.length > 0 && !tooLong;

  useEffect(() => {
    mounted.current = true;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reviewable) return;
    setSubmitting(true);
    setError(null);
    let outcome: NameEditOutcome;
    try {
      outcome = await onSubmit(name);
    } catch {
      outcome = {
        status: "rejected",
        reasonCode: "not_sent",
        message: NAME_EDIT_FALLBACK,
        pendingActionId: null,
      };
    }
    // Accepted: the relay has already replaced this card with the new one.
    const refusal =
      outcome.status === "accepted" ? null : outcome.message || NAME_EDIT_FALLBACK;
    if (!mounted.current) {
      // The card went first (the relay cancelled it, then could not prepare
      // the new one), so there is no input left to show the refusal under.
      if (refusal) morphyToast.error(refusal);
      return;
    }
    setSubmitting(false);
    if (refusal) setError(refusal);
  };

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <form
      data-testid="one-voice-name-edit"
      aria-label="Edit circle name"
      className="mt-3 flex flex-col gap-2"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <label
        htmlFor={`${id}-input`}
        className="text-[13px] font-medium leading-[18px] text-[color:var(--app-secondary-label)]"
      >
        Circle name
      </label>
      <Input
        ref={inputRef}
        id={`${id}-input`}
        data-testid="one-voice-name-edit-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        autoComplete="off"
        enterKeyHint="done"
        aria-invalid={error !== null || tooLong}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      />
      <p
        id={hintId}
        data-testid="one-voice-name-edit-preview"
        className="min-h-[18px] break-words text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]"
      >
        {tooLong
          ? `Keep it to ${NAME_EDIT_MAX_CHARS} characters or fewer.`
          : name
            ? <>Will be named <span className="font-semibold text-[color:var(--app-label)]">{name}</span></>
            : "Type a name for the circle."}
      </p>
      {error ? (
        <p
          id={errorId}
          role="alert"
          data-testid="one-voice-name-edit-error"
          className={cn("text-[13px] font-medium leading-[18px]", roleClasses("danger").glyph)}
        >
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          data-testid="one-voice-name-edit-back"
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="min-h-11 min-w-11 px-4"
        >
          Back
        </Button>
        <Button
          data-testid="one-voice-name-edit-review"
          type="submit"
          size="sm"
          isLoading={submitting}
          disabled={!reviewable}
          className="min-h-11 flex-1 px-4"
        >
          Review name
        </Button>
      </div>
    </form>
  );
}

export function PendingActionCard({
  action,
  onConfirm,
  onCancel,
  busy = false,
  autoFocus = true,
  onEditName,
}: PendingActionCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreEditFocus = useRef(false);
  const resolved = action.resolvedStatus;
  const open = resolved === null;
  const outcome = resolvedLabel(action);
  const remaining = useCountdown(action.expires_at, open);
  const expired = open && remaining !== null && remaining <= 0;
  const role = pendingActionRole(action);
  const palette = roleClasses(role);
  const Icon = role === "danger" ? AlertTriangle : ShieldCheck;
  // The editor belongs to the card it was opened on: the relay's replacement
  // card (a new id) starts closed, and a card it cancelled never re-arms.
  const [editingId, setEditingId] = useState<string | null>(null);
  const nameEditable =
    onEditName !== undefined && NAME_EDITABLE_TOOLS.has(String(action.tool || ""));
  const editing = nameEditable && editingId === action.pending_action_id;
  const currentName = typeof action.args?.name === "string" ? action.args.name : "";

  useEffect(() => {
    if (!autoFocus || !open) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [action.pending_action_id, autoFocus, open]);

  useEffect(() => {
    if (editing || !restoreEditFocus.current) return;
    restoreEditFocus.current = false;
    editButtonRef.current?.focus({ preventScroll: true });
  }, [editing]);

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label={
        open
          ? "Confirm this action"
          : `Action ${(outcome?.label ?? RESOLVED_LABEL[resolved]).toLowerCase()}`
      }
      data-testid="one-voice-pending-action"
      data-pending-action-id={action.pending_action_id}
      data-tier={action.tier}
      data-resolved={resolved ?? undefined}
      data-outcome={outcome?.kind}
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
                outcome?.kind === "success"
                  ? roleClasses("success").glyph
                  : outcome?.kind === "pending"
                    ? roleClasses("action").glyph
                    : "text-[color:var(--app-secondary-label)]",
              )}
            >
              {outcome?.kind === "success" ? (
                <Check className="h-3.5 w-3.5" aria-hidden />
              ) : outcome?.kind === "pending" ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : null}
              {outcome?.label ?? RESOLVED_LABEL[resolved]}
            </p>
          )}
          {open && nameEditable && !editing ? (
            <Button
              ref={editButtonRef}
              data-testid="one-voice-edit-name"
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditingId(action.pending_action_id)}
              className="-ml-3 mt-1 min-h-11 px-3"
            >
              <Pencil className="h-4 w-4" aria-hidden />
              Edit name
            </Button>
          ) : null}
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

      {editing && onEditName ? (
        <NameEditor
          key={action.pending_action_id}
          initialName={currentName}
          canSubmit={open}
          onSubmit={onEditName}
          onBack={() => {
            restoreEditFocus.current = true;
            setEditingId(null);
          }}
        />
      ) : null}

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
            // Held while the name is being edited: Confirm must act on the
            // card the person reviewed, not on one they are changing.
            disabled={expired || editing}
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
