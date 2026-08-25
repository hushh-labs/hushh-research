"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  Search,
  Share2,
  ShieldCheck,
  Trash2,
  UsersRound,
  MoreVertical,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { INPUT_CLASSNAME } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SheetClose,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SectionLabel, TrailingValue } from "@/components/app-ui/typography";
import {
  EmptyState,
  TaskFlowHeader,
} from "@/components/one-location/redesign/primitives";
import {
  CARD_SURFACE,
  MUTED_TEXT,
} from "@/components/one-location/redesign/tokens";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { ROUTES } from "@/lib/navigation/routes";
import {
  CIRCLE_NAME_INPUT_CLASSNAME,
  CIRCLE_NAME_ROW_CLASSNAME,
} from "@/components/one-location/redesign/circles/circle-name-row-layout";
import {
  CIRCLE_MEMBERS_CARD_SCROLL_CLASSNAME,
  CIRCLE_MEMBERS_CARD_SHELL_CLASSNAME,
  CIRCLE_MEMBER_ACTION_CLASSNAME,
  CIRCLE_MEMBER_AVATAR_CLASSNAME,
  CIRCLE_MEMBER_MENU_CLASSNAME,
  CIRCLE_MEMBER_ROW_CLASSNAME,
  CIRCLE_MEMBER_TRAILING_CLASSNAME,
} from "@/components/one-location/redesign/circles/circle-member-row-layout";
import type {
  OneLocationCircleDetail,
  OneLocationCircleEligibleConnection,
  OneLocationCircleEligibleConnections,
  OneLocationCircleInviteCode,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
  OneLocationCircleMember,
  OneLocationCircleMemberInvite,
  OneLocationCircleSummary,
} from "@/lib/one-location/types";
import {
  filterPeopleByQuery,
  sortPeopleByName,
} from "@/lib/one-location/people-search";
import { BLOCKED_CTA } from "@/components/one-location/redesign/circles/blocked-cta";
import { LOCATION_SEARCH_INPUT_CLASSNAME } from "@/components/one-location/redesign/selectors";
import { relationshipCta } from "@/lib/connections/relationship-label";
import { othersCountLabel } from "@/lib/one-location/circle-member-count";
import { cn } from "@/lib/utils";

const CIRCLES_GROUP_SURFACE =
  "[--settings-group-radius:17px] !rounded-[17px] !bg-[color:var(--app-primary-surface)] !shadow-none";

const CIRCLES_EMPTY_STATE_WRAPPER =
  "[&>[data-ui-role=grouped-card]]:rounded-[var(--app-radius-md)] [&>[data-ui-role=grouped-card]]:!bg-[color:var(--app-primary-surface)] [&>[data-ui-role=grouped-card]]:shadow-[var(--app-card-shadow-standard)]";

/**
 * Leave / Delete circle.
 *
 * `variant="outline"` gave these a filled neutral slab with a red hairline and
 * red label -- a painted button that reads as the loudest control on a screen
 * whose actual primary action is "Add people". iOS puts a destructive row on
 * the same card surface as everything else and lets the red label carry it,
 * which is what this does.
 */
const CIRCLE_DESTRUCTIVE_ACTION =
  "h-12 w-full rounded-full text-[17px] font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive";

/**
 * A circle is a group of trusted people, so its glyph carries the PEOPLE role
 * rather than the accent used for things you can DO. The action controls that
 * sit alongside it (New circle, Join, Share, Add people) stay accent, which is
 * what keeps "this is a group" and "this is a button" from looking alike.
 *
 * Glyph only. The wells this sits in ask for `--app-accent-soft`, a token that
 * is defined nowhere, so they have always rendered unpainted — giving them a
 * tint would add painted area rather than recolour it, so the recolour stops
 * at the icon.
 *
 * Used on the two surfaces where the viewer is NOT yet a member (an incoming
 * invite, a join preview), so the "nobody but you in here" neutral state the
 * circle LIST applies cannot arise and there is nothing to resolve.
 */
const CIRCLE_PEOPLE_GLYPH = roleClasses("people").glyph;

function circleInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

/**
 * Subtitle for the "Your circles" list row, e.g. "2 members".
 *
 * Counts OTHER members (everyone except the viewer) so it matches the Circle
 * Detail subtitle, which filters out the current user. The backend
 * `memberCount` includes the viewer — always a member of a circle shown in
 * their own list — so subtracting one yields the same number both places.
 * `Math.max(0, ...)` guards a transient zero.
 *
 * The kind used to lead this line — "Family · 0 members". Reported from QA:
 * the circle created during onboarding is filed under Family by default and
 * the person was never asked, so the row opened by telling them a category
 * they had not picked, ahead of the only number on the line that was true.
 * There are three kinds and nothing on this screen acts on any of them, so
 * the word was decoration in front of the fact. The count stands alone.
 */
/** Re-exported so existing importers keep working; the rule itself now lives
 *  in `lib/one-location/circle-member-count`, because four other screens were
 *  rendering the raw server count and disagreeing with this one. */
export { othersCountLabel };

function circleListPeopleLabel(memberCount: number | null | undefined): string {
  const others = Math.max(0, Number(memberCount || 0) - 1);
  if (others <= 0) return "Only you";
  return `${others} ${others === 1 ? "person" : "people"}`;
}

function circleDetailMemberCountLabel(count: number): string {
  if (count <= 1) return "Only you";
  return `${count} people`;
}

function circleFlowErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export function CirclesSection({
  circles,
  incomingInvites,
  incomingInvitesLoading,
  incomingInvitesError,
  focusedInviteId,
  focusedInviteResolutionReady,
  inviteBusy,
  onCreate,
  onJoin,
  onOpen,
  onAcceptInvite,
  onDeclineInvite,
  onRetryInvites,
  onDismissFocusedInvite,
}: {
  circles: OneLocationCircleSummary[];
  incomingInvites: OneLocationCircleMemberInvite[];
  incomingInvitesLoading: boolean;
  incomingInvitesError: string | null;
  focusedInviteId: string | null;
  focusedInviteResolutionReady: boolean;
  inviteBusy: boolean;
  onCreate: () => void;
  onJoin: () => void;
  onOpen: (circleId: string) => void;
  onAcceptInvite: (inviteId: string) => Promise<void>;
  onDeclineInvite: (inviteId: string) => Promise<void>;
  onRetryInvites: () => void;
  onDismissFocusedInvite: () => void;
}) {
  const [respondingInviteId, setRespondingInviteId] = useState<string | null>(
    null,
  );
  const responseInFlightRef = useRef(false);
  const focusedInviteElementRef = useRef<HTMLDivElement | null>(null);
  const focusedInvite = focusedInviteId
    ? (incomingInvites.find((invite) => invite.id === focusedInviteId) ?? null)
    : null;

  const orderedCircles = useMemo(() => {
    return [...circles].sort((left, right) => {
      const isSystemLeft = Boolean(left.systemKind || left.isSystem);
      const isSystemRight = Boolean(right.systemKind || right.isSystem);
      if (isSystemLeft !== isSystemRight) {
        return isSystemLeft ? 1 : -1;
      }
      return 0;
    });
  }, [circles]);

  useEffect(() => {
    if (
      !focusedInvite ||
      incomingInvitesLoading ||
      !focusedInviteElementRef.current
    ) {
      return;
    }
    const element = focusedInviteElementRef.current;
    element.focus({ preventScroll: true });
    if (typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusedInvite, incomingInvitesError, incomingInvitesLoading]);

  const respondToInvite = async (
    invite: OneLocationCircleMemberInvite,
    decision: "accept" | "decline",
  ) => {
    if (responseInFlightRef.current || inviteBusy) return;
    responseInFlightRef.current = true;
    setRespondingInviteId(invite.id);
    try {
      if (decision === "accept") {
        await onAcceptInvite(invite.id);
      } else {
        await onDeclineInvite(invite.id);
      }
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(
          error,
          decision === "accept"
            ? "Could not join this Circle."
            : "Could not decline this invitation.",
        ),
      );
    } finally {
      responseInFlightRef.current = false;
      setRespondingInviteId(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="one-location-named-circles">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[15px] font-medium leading-5 tracking-[-0.01em] text-[color:var(--app-section-label)]">
          Circles
        </h2>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Add Circle"
              className="h-11 w-11 rounded-full text-[color:var(--app-accent)] hover:bg-[color:var(--app-neutral-fill)] hover:text-[color:var(--app-accent-hover)]"
            >
              <Plus className="h-[21px] w-[21px]" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="w-[186px] rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] p-1 shadow-[0_12px_28px_rgba(0,0,0,0.12)]"
          >
            <DropdownMenuItem
              onSelect={onCreate}
              data-voice-control-id="one-location-action-create-circle"
              className="flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-[15px] font-normal leading-5 text-[color:var(--app-primary-label)] focus:bg-[color:var(--app-neutral-fill)] dark:focus:bg-white/10"
            >
              <Plus
                className="h-4 w-4 text-[color:var(--app-secondary-label)]"
                aria-hidden="true"
              />
              Create Circle
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onJoin}
              data-voice-control-id="one-location-action-join-circle"
              className="flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-[15px] font-normal leading-5 text-[color:var(--app-primary-label)] focus:bg-[color:var(--app-neutral-fill)] dark:focus:bg-white/10"
            >
              <KeyRound
                className="h-4 w-4 text-[color:var(--app-secondary-label)]"
                aria-hidden="true"
              />
              Join with code
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {incomingInvitesError ? (
        <div className={CIRCLES_EMPTY_STATE_WRAPPER}>
          <EmptyState
            title="Circle invitations unavailable"
            description={incomingInvitesError}
            action={
              <Button
                type="button"
                variant="outline"
                disabled={incomingInvitesLoading}
                isLoading={incomingInvitesLoading}
                onClick={onRetryInvites}
                className="h-11 rounded-full px-5"
              >
                Retry
              </Button>
            }
          />
        </div>
      ) : null}

      {incomingInvitesLoading &&
      !incomingInvites.length &&
      !incomingInvitesError ? (
        <div
          role="status"
          className="flex min-h-16 items-center justify-center gap-2 rounded-[var(--app-radius-md)] bg-[color:var(--app-primary-surface)] text-sm text-[color:var(--app-secondary-label)] shadow-[var(--app-card-shadow-standard)]"
        >
          <Loader2 className="h-5 w-5 animate-spin" />
          Checking Circle invitations…
        </div>
      ) : null}

      {incomingInvites.length ? (
        <SettingsGroup
          title="Circle invitations"
          shellClassName={CIRCLES_GROUP_SURFACE}
          testId="one-location-circle-member-invites"
        >
          {incomingInvites.map((invite) => {
            const responding = respondingInviteId === invite.id;
            const isFocused = invite.id === focusedInviteId;
            return (
              <div
                key={invite.id}
                ref={isFocused ? focusedInviteElementRef : undefined}
                tabIndex={isFocused ? -1 : undefined}
                className={cn(
                  "flex min-h-[64px] flex-col gap-3 px-4 py-3 outline-none sm:flex-row sm:items-center",
                  isFocused &&
                    "bg-[color:var(--app-accent-soft)] ring-2 ring-inset ring-[color:var(--app-accent-ring)]",
                )}
                data-focused={isFocused || undefined}
                data-testid={`one-location-circle-invite-${invite.id}`}
              >
                <span
                  className={cn(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[color:var(--app-accent-soft)]",
                    CIRCLE_PEOPLE_GLYPH,
                  )}
                >
                  <UsersRound className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-foreground">
                    {invite.circleName}
                  </p>
                  <p className={MUTED_TEXT}>
                    Invited by {invite.inviterDisplayName}
                  </p>
                </div>
                <div className="grid w-full grid-cols-2 gap-2 sm:w-auto">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={inviteBusy || Boolean(respondingInviteId)}
                    onClick={() => void respondToInvite(invite, "decline")}
                    className="h-11 rounded-full px-4"
                  >
                    Decline
                  </Button>
                  <Button
                    type="button"
                    disabled={inviteBusy || Boolean(respondingInviteId)}
                    isLoading={responding}
                    onClick={() => void respondToInvite(invite, "accept")}
                    className="h-11 rounded-full px-4"
                  >
                    Join
                  </Button>
                </div>
              </div>
            );
          })}
        </SettingsGroup>
      ) : null}

      {focusedInviteId &&
      focusedInviteResolutionReady &&
      !focusedInvite &&
      !incomingInvitesLoading &&
      !incomingInvitesError ? (
        <div className={CIRCLES_EMPTY_STATE_WRAPPER}>
          <EmptyState
            title="Circle invitation no longer available"
            description="It may have expired, been cancelled or already been answered."
            action={
              <Button
                type="button"
                variant="outline"
                onClick={onDismissFocusedInvite}
                className="h-11 rounded-full px-5"
              >
                Dismiss
              </Button>
            }
          />
        </div>
      ) : null}

      {orderedCircles.length ? (
        <SettingsGroup
          separatorInset
          shellClassName={CIRCLES_GROUP_SURFACE}
          testId="one-location-circle-list"
        >
          {orderedCircles.map((circle) => {
            const isSmsCircle = circle.systemKind === "sms";
            const initials = circleInitials(circle.name);
            const showInitials =
              !isSmsCircle && circle.systemKind !== "trusted" && initials;
            return (
              <SettingsRow
                key={circle.id}
                leading={
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center",
                      isSmsCircle
                        ? "rounded-full bg-[#FF3B30] text-[11px] font-bold leading-none tracking-[-0.2px] text-white"
                        : "rounded-[10px] bg-[#E5E5EA] text-[13px] font-semibold text-[#6E6E73] dark:bg-[rgba(142,142,147,0.28)] dark:text-[#F2F2F7]",
                    )}
                    data-testid={
                      isSmsCircle
                        ? "one-location-circle-sms-mark"
                        : "one-location-circle-neutral-mark"
                    }
                  >
                    {isSmsCircle ? (
                      "SMS"
                    ) : showInitials ? (
                      initials
                    ) : (
                      <UsersRound className="h-[17px] w-[17px]" />
                    )}
                  </span>
                }
                title={circle.name}
                description={
                  isSmsCircle
                    ? `Save My Soul · ${circleListPeopleLabel(circle.memberCount)}`
                    : circleListPeopleLabel(circle.memberCount)
                }
                chevron
                onClick={() => onOpen(circle.id)}
                className={cn(
                  "[--settings-row-gap:12px] [--settings-row-px:16px] [--settings-row-py:10px]",
                  "[&>button]:min-h-[60px] sm:[&>button]:min-h-16",
                  "[&_[data-slot=settings-row-title]]:!text-[17px] [&_[data-slot=settings-row-title]]:!font-medium [&_[data-slot=settings-row-title]]:!leading-[22px] [&_[data-slot=settings-row-title]]:!tracking-[-0.3px]",
                  "[&_[data-slot=settings-row-description]]:!mt-0.5 [&_[data-slot=settings-row-description]]:!text-[13px] [&_[data-slot=settings-row-description]]:!font-normal [&_[data-slot=settings-row-description]]:!leading-[18px] [&_[data-slot=settings-row-description]]:!tracking-[-0.2px]",
                )}
                testId={`one-location-circle-${circle.id}`}
              />
            );
          })}
        </SettingsGroup>
      ) : (
        <div className={CIRCLES_EMPTY_STATE_WRAPPER}>
          <EmptyState
            title="No circles yet"
            description="Create one for family or friends, or join with a code."
          />
        </div>
      )}
    </div>
  );
}

const CIRCLE_KIND_OPTIONS: {
  value: OneLocationCircleKind;
  label: string;
}[] = [
  {
    value: "family",
    label: "Family",
  },
  {
    value: "friends",
    label: "Friends",
  },
  {
    value: "other",
    label: "Other",
  },
];

export function CreateCircleFlow({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (name: string, kind: OneLocationCircleKind) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OneLocationCircleKind>("family");
  // One typed character is a name. Requiring two silently withheld the button
  // from anyone naming a circle "A", with nothing on screen saying why.
  const canSubmit = name.trim().length >= 1 && !busy;

  // Held past the caller's `busy` flag on purpose.
  //
  // A host that clears busy in a `finally` clears it BEFORE the navigation it
  // then starts has committed, so there is a guaranteed render with this form
  // still mounted, the name still in state and the button live again. One
  // impatient double-tap made two identically-named Circles and two success
  // toasts. Reset only on failure: after a success this form is on its way off
  // screen and must not accept another submission on the way.
  const submittingRef = useRef(false);
  const submit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onSubmit(name.trim(), kind);
    } catch (error) {
      submittingRef.current = false;
      toast.error(
        circleFlowErrorMessage(error, "Could not create this Circle."),
      );
    }
  };

  return (
    <div className="space-y-6" data-testid="one-location-create-circle-flow">
      <TaskFlowHeader title="Create Circle" />

      <label className="block space-y-2">
        <span className="text-[15px] font-semibold leading-5 text-foreground">
          Circle name
        </span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoComplete="off"
          spellCheck
          placeholder="e.g. Family"
          className="h-[52px] w-full rounded-2xl border-0 bg-[color:var(--app-card-surface-default-solid)] px-4 text-[17px] leading-[22px] shadow-[var(--app-card-shadow-standard)] outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
        />
      </label>

      <SettingsGroup
        title="Type"
        separatorInset
        shellClassName="!rounded-[18px]"
      >
        {CIRCLE_KIND_OPTIONS.map((option) => (
          <SettingsRow
            key={option.value}
            icon={UsersRound}
            iconTone="gray"
            title={option.label}
            trailing={
              kind === option.value ? (
                <Check className="h-5 w-5 text-[color:var(--app-accent)]" />
              ) : null
            }
            onClick={() => setKind(option.value)}
            testId={`one-location-circle-kind-${option.value}`}
          />
        ))}
      </SettingsGroup>

      <Button
        type="button"
        disabled={!canSubmit}
        isLoading={busy}
        onClick={() => void submit()}
        className={cn(
          "h-12 w-full rounded-full text-base font-semibold",
          BLOCKED_CTA,
        )}
      >
        Create Circle
      </Button>
    </div>
  );
}

function normalizeCodeInput(value: string): string {
  const upper = value.toUpperCase();
  const codeAfterMarker = upper.match(
    /\bCODE\b[^2-9A-HJ-KM-NP-Z]{0,8}([23456789A-HJ-KM-NP-Z]{4})[\s-]*([23456789A-HJ-KM-NP-Z]{4})[\s-]*([23456789A-HJ-KM-NP-Z]{4})/,
  );
  const hyphenatedCode = upper.match(
    /\b([23456789A-HJ-KM-NP-Z]{4})-([23456789A-HJ-KM-NP-Z]{4})-([23456789A-HJ-KM-NP-Z]{4})\b/,
  );
  const messageCode = codeAfterMarker ?? hyphenatedCode;
  const isCodeOnlyInput = /^[\s2-9A-HJ-KM-NP-Z-]*$/.test(upper);
  const normalized = (
    messageCode
      ? messageCode.slice(1, 4).join("")
      : isCodeOnlyInput
        ? upper.replace(/[^2-9A-HJ-KM-NP-Z]/g, "")
        : ""
  ).slice(0, 12);
  return normalized.replace(/(.{4})(?=.)/g, "$1-");
}

export function JoinCircleFlow({
  busy,
  onResolve,
  onJoin,
  initialCode,
}: {
  busy: boolean;
  onResolve: (code: string) => Promise<OneLocationCircleInvitePreview>;
  onJoin: (code: string) => Promise<void>;
  /** Pre-fills the code input when arriving from a `/circle/join?code=` link. */
  initialCode?: string;
}) {
  const [code, setCode] = useState(initialCode ?? "");
  const [resolved, setResolved] = useState<{
    code: string;
    preview: OneLocationCircleInvitePreview;
  } | null>(null);
  const resolveRequestRef = useRef(0);
  const preview = resolved?.preview ?? null;
  const normalizedLength = code.replace(/-/g, "").length;

  const resolve = async () => {
    const requestedCode = code;
    const requestId = ++resolveRequestRef.current;
    try {
      const nextPreview = await onResolve(requestedCode);
      if (requestId !== resolveRequestRef.current) return;
      setResolved({ code: requestedCode, preview: nextPreview });
    } catch (error) {
      if (requestId !== resolveRequestRef.current) return;
      toast.error(
        circleFlowErrorMessage(
          error,
          "That Circle code is invalid or no longer available.",
        ),
      );
    }
  };

  // Same guard as CreateCircleFlow, for the same reason: joining navigates on
  // success, and the button comes back before the navigation lands.
  const joiningRef = useRef(false);
  const join = async () => {
    if (!resolved) return;
    if (joiningRef.current) return;
    joiningRef.current = true;
    try {
      await onJoin(resolved.code);
    } catch (error) {
      joiningRef.current = false;
      toast.error(circleFlowErrorMessage(error, "Could not join this Circle."));
    }
  };

  return (
    <div className="space-y-6" data-testid="one-location-join-circle-flow">
      <TaskFlowHeader
        eyebrow="People"
        title="Join a circle"
        description="Enter the 12-character code shared by the Circle owner."
      />

      <label className="block space-y-2">
        <span className="text-sm font-semibold text-foreground">
          Invite code
        </span>
        <input
          value={code}
          onChange={(event) => {
            resolveRequestRef.current += 1;
            setCode(normalizeCodeInput(event.target.value));
            setResolved(null);
          }}
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          aria-label="Circle invite code"
          placeholder="ABCD-EFGH-JKLM"
          className="h-14 w-full rounded-2xl border border-border bg-[color:var(--app-card-surface-default-solid)] px-4 text-center font-mono text-xl font-bold uppercase tracking-[0.12em] outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
        />
      </label>

      {preview ? (
        <div className="rounded-[22px] border border-border bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-2xl bg-[color:var(--app-accent-soft)]",
                CIRCLE_PEOPLE_GLYPH,
              )}
            >
              <UsersRound className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-bold text-foreground">
                {preview.name}
              </p>
              <p className="text-sm text-muted-foreground">
                {preview.ownerDisplayName} · {preview.memberCount} members
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-5 text-muted-foreground">
            Joining connects you with current and future Circle members. Your
            location and SMS contacts stay private until you choose to share.
          </p>
        </div>
      ) : null}

      {preview ? (
        <Button
          type="button"
          onClick={() => void join()}
          isLoading={busy}
          disabled={busy}
          className="h-12 w-full rounded-full text-base font-semibold"
        >
          {preview.alreadyMember ? "Open circle" : "Join circle"}
        </Button>
      ) : (
        <Button
          type="button"
          disabled={normalizedLength !== 12 || busy}
          isLoading={busy}
          onClick={() => void resolve()}
          className={cn(
            "h-12 w-full rounded-full text-base font-semibold",
            BLOCKED_CTA,
          )}
        >
          Preview circle
        </Button>
      )}
    </div>
  );
}

/** Ties the visible "Circle name" label to its input without wrapping the
 *  trailing Save/Edit button in the `<label>` (a wrapped button steals the
 *  label's activation click and refocuses the field mid-tap). */
const CIRCLE_NAME_INPUT_ID = "one-location-circle-name-input";

/** Names the roster section for `aria-labelledby`, so the list announces as
 *  "Members" rather than as an unlabelled region between two cards. */
const CIRCLE_MEMBERS_HEADING_ID = "one-location-circle-members-heading";

function CircleMemberRow({
  member,
  currentUserId,
  isOwner,
  busy,
  onShare,
  onRemove,
  onConnect,
  connecting = false,
  onCancelRequest,
  cancelling = false,
  membersRemovable = true,
}: {
  member: OneLocationCircleMember;
  currentUserId: string | null;
  isOwner: boolean;
  busy: boolean;
  onShare: () => void;
  onRemove: () => Promise<void>;
  /** Sends a connection request to this member. Absent when none is possible. */
  onConnect?: () => Promise<void>;
  connecting?: boolean;
  /** Takes back a request this person has not answered yet.
   *
   *  Absent on a surface that cannot cancel, where the row falls back to a
   *  plain "Requested" status. */
  onCancelRequest?: () => Promise<void>;
  cancelling?: boolean;
  /** False where the roster is not the owner's to edit.
   *
   *  A Trusted Circle's membership is derived from the connection, so
   *  `_end_membership` refuses a removal with
   *  LOCATION_CIRCLE_TRUSTED_FOLLOWS_CONNECTION -- the connection is the thing
   *  to end. Offering Remove there is offering a control that cannot work. */
  membersRemovable?: boolean;
}) {
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const isCurrentUser = member.userId === currentUserId;
  const canShare =
    !isCurrentUser && member.phoneVerified && member.secureLocationReady;
  const canRemove = isOwner && member.role !== "owner" && membersRemovable;
  const hasMenu = canShare || canRemove;

  const relationship =
    !isCurrentUser && member.relationship && member.relationship !== "self"
      ? member.relationship
      : null;
  const cta = relationship ? relationshipCta(relationship) : null;

  /**
   * Only a control the viewer can actually press gets to look like one.
   *
   * Every row used to render `relationshipCta` as a button whatever it said,
   * so a roster of people you already know was a column of grey, dead,
   * button-shaped "Connected" -- the loudest thing on the screen, repeated
   * once per member, saying the one thing that is true of a roster by
   * default. Reported as exactly that: "why is there a need to show the
   * connected section with their name".
   *
   * Connected is now silent (visually -- it stays in the row's accessible
   * name below, because absence is not something a screen reader can read),
   * and the two states that are NOT the default keep their own affordance.
   */
  const actionCta = cta && cta.action !== "none" ? cta : null;
  /** Waiting on them.
   *
   *  This used to be a status and nothing more, on the reasoning that nothing
   *  here could act on it. The Connect directory has always been able to --
   *  it offers Cancel on exactly this state -- so the roster showed the same
   *  fact with one fewer thing you could do about it. Where a caller can
   *  cancel, the row does; where it cannot, the status is still the answer. */
  const pendingLabel =
    cta && cta.action === "none" && relationship === "pending_outgoing"
      ? cta.label
      : null;
  const canCancelRequest = Boolean(pendingLabel && onCancelRequest);

  const secondaryLine = isCurrentUser
    ? member.role === "owner"
      ? "You · Owner"
      : "You"
    : member.role === "owner"
      ? "Owner"
      : member.secureLocationReady
        ? "Connected"
        : "Location setup needed";
  // The one second line that is asking for something rather than reporting.
  const secondaryNeedsSetup =
    member.role !== "owner" && !member.secureLocationReady;

  return (
    <div className={CIRCLE_MEMBER_ROW_CLASSNAME}>
      <Avatar className={CIRCLE_MEMBER_AVATAR_CLASSNAME}>
        {member.photoUrl ? <AvatarImage src={member.photoUrl} alt="" /> : null}
        <AvatarFallback>{circleInitials(member.displayName)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        {/* `truncate`, not `break-words`. A long name used to wrap to three
            lines and push its own row to twice the height of its neighbours,
            which is the other half of what a 320px phone was showing. */}
        <p
          className="truncate text-[15px] font-semibold leading-5 text-foreground"
          title={member.displayName}
        >
          {member.displayName}
        </p>
        <p
          className={cn(
            MUTED_TEXT,
            "truncate",
            // The amber pair `WARNING_SURFACE` already uses for caution copy,
            // not the flat `--app-warning`: that token is the #ff9500 glyph
            // tone and measures ~2.2:1 on this card, well under the 4.5:1 a
            // 13px sentence needs.
            secondaryNeedsSetup && "text-amber-700 dark:text-amber-300",
          )}
        >
          {secondaryLine}
        </p>
        {/* Said once, to the accessibility tree only. The visible row drops
            the default relationship rather than repeating it down the list. */}
        {cta && !actionCta && !pendingLabel ? (
          <span className="sr-only">Connected on One</span>
        ) : null}
      </div>
      <div className={CIRCLE_MEMBER_TRAILING_CLASSNAME}>
        {pendingLabel && !canCancelRequest ? (
          <span
            className="px-1 text-[13px] font-medium leading-5 text-muted-foreground"
            data-testid={`circle-member-relationship-${member.userId}`}
          >
            {pendingLabel}
          </span>
        ) : null}
        {canCancelRequest ? (
          // One word, at the width the other actions in this column use. The
          // directory settled that: "Cancel request" made the widest control
          // on the screen the one belonging to the least common row state.
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || cancelling}
            isLoading={cancelling}
            aria-label={`Cancel your request to ${member.displayName}`}
            data-testid={`circle-member-cancel-${member.userId}`}
            className={CIRCLE_MEMBER_ACTION_CLASSNAME}
            onClick={() => void onCancelRequest?.()}
          >
            Cancel
          </Button>
        ) : null}
        {actionCta?.action === "connect" ? (
          <Button
            type="button"
            size="sm"
            disabled={busy || connecting}
            isLoading={connecting}
            aria-label={`Connect with ${member.displayName}`}
            data-testid={`circle-member-connect-${member.userId}`}
            className={CIRCLE_MEMBER_ACTION_CLASSNAME}
            onClick={() => void onConnect?.()}
          >
            {actionCta.label}
          </Button>
        ) : null}
        {/* `pending_incoming` used to render an ENABLED button whose click
            handler ran only for `action === "connect"` -- so the one row that
            had something waiting on it offered a control that did nothing at
            all. Answering an incoming request lives on Connect, and this is
            now the link that goes there. */}
        {actionCta?.action === "respond" ? (
          <>
            {/* `Link`, not a bare anchor. An <a href> is a full document
              load, and the vault key lives only in React state -- so the
              one control offered here relocked the vault on the way to
              using it. */}
            <Link
              // The consent centre, not `/one/connect`.
              //
              // From a Circle hosted ON Connect, a bare `/one/connect` href is
              // a navigation whose only change is the query string
              // disappearing -- which this repo has measured the App Router to
              // refuse -- so the one row with something waiting on it did
              // nothing at all when tapped. Connect's own Respond goes here
              // too, and a different pathname works from either host.
              href={buildConsentCenterHref("pending")}
              aria-label={`Respond to the connection request from ${member.displayName}`}
              data-testid={`circle-member-respond-${member.userId}`}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                CIRCLE_MEMBER_ACTION_CLASSNAME,
              )}
            >
              {actionCta.label}
            </Link>
          </>
        ) : null}
        {hasMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={busy}
                aria-label={`Actions for ${member.displayName}`}
                className={CIRCLE_MEMBER_MENU_CLASSNAME}
              >
                <MoreVertical className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canShare ? (
                <DropdownMenuItem onSelect={() => onShare()}>
                  <Share2 className="h-4 w-4 text-current" />
                  Share location
                </DropdownMenuItem>
              ) : null}
              {canRemove ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={(event) => {
                    event.preventDefault();
                    setConfirmRemoveOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Remove from Circle
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          // Holds the kebab column open on the rows that have no kebab. Without
          // it the roster's right edge steps in and out by 44px from row to row.
          <span
            aria-hidden="true"
            className={CIRCLE_MEMBER_MENU_CLASSNAME}
            data-testid="circle-member-menu-spacer"
          />
        )}
      </div>
      {canRemove ? (
        <AlertDialog
          open={confirmRemoveOpen}
          onOpenChange={setConfirmRemoveOpen}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {member.displayName}?</AlertDialogTitle>
              <AlertDialogDescription>
                Circle shares with {member.displayName} will stop. Direct shares
                stay unchanged.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => void onRemove()}
                className="h-11 w-full sm:w-auto"
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

export function CircleDetailFlow({
  circleId,
  currentUserId,
  busy,
  onBack,
  onLoad,
  onRename,
  onGenerateCode,
  onCopyCode,
  onShareCode,
  onShareWithMember,
  onRemoveMember,
  onConnectMember,
  onCancelMemberRequest,
  reloadSignal = 0,
  onLoadEligibleConnections,
  onInviteConnections,
  onCancelMemberInvite,
  onLeave,
  onDelete,
}: {
  circleId: string;
  currentUserId: string | null;
  busy: boolean;
  onBack: () => void;
  onLoad: (circleId: string) => Promise<OneLocationCircleDetail>;
  onRename: (
    circleId: string,
    name: string,
  ) => Promise<OneLocationCircleDetail>;
  onGenerateCode: (
    circleId: string,
    rotate?: boolean,
  ) => Promise<OneLocationCircleInviteCode>;
  onCopyCode: (code: string) => Promise<void>;
  onShareCode: (circle: OneLocationCircleDetail, code: string) => Promise<void>;
  onShareWithMember: (circleId: string, userId: string) => void;
  onRemoveMember: (circleId: string, userId: string) => Promise<void>;
  /**
   * Sends a connection request to a co-member.
   *
   * Sharing a Circle does not connect two people -- a joiner is paired with
   * whoever invited them and nobody else -- so the roster is where that
   * introduction can be asked for explicitly, and answered by the other person.
   */
  /** `displayName` and `photoUrl` are passed so a caller can put this person
   *  in front of the same capability review the Connect directory uses,
   *  which needs a name to show. Optional so an older caller still compiles. */
  onConnectMember: (
    circleId: string,
    userId: string,
    person?: { displayName: string | null; photoUrl: string | null },
  ) => Promise<void>;
  /** Takes back a request this viewer sent to a co-member. Absent on a
   *  surface that cannot cancel, where the row shows a plain "Requested". */
  onCancelMemberRequest?: (circleId: string, userId: string) => Promise<void>;
  /** Re-read this Circle without disturbing what the person is doing.
   *
   *  Bumped by the caller when something outside this screen changed the
   *  roster -- a request sent, a member added, somebody joining with a code.
   *  Deliberately NOT a `key` remount: that would close an open add-people
   *  sheet, clear a half-typed search and drop the selection, which is a
   *  worse answer than a stale row. */
  reloadSignal?: number;
  onLoadEligibleConnections: (
    circleId: string,
  ) => Promise<OneLocationCircleEligibleConnections>;
  onInviteConnections: (
    circleId: string,
    inviteeUserIds: string[],
  ) => Promise<void>;
  onCancelMemberInvite: (inviteId: string) => Promise<void>;
  onLeave: (circleId: string) => Promise<void>;
  onDelete: (circleId: string) => Promise<void>;
}) {
  const [loadedCircle, setCircle] = useState<OneLocationCircleDetail | null>(
    null,
  );
  const [cancellingUserId, setCancellingUserId] = useState<string | null>(null);
  const [inviteCode, setInviteCode] =
    useState<OneLocationCircleInviteCode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [circleName, setCircleName] = useState("");
  const [peopleSheetOpen, setPeopleSheetOpen] = useState(false);
  const [renameSheetOpen, setRenameSheetOpen] = useState(false);
  const [inviteCodeSheetOpen, setInviteCodeSheetOpen] = useState(false);
  const [replaceCodeConfirmOpen, setReplaceCodeConfirmOpen] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [eligibleConnections, setEligibleConnections] = useState<
    OneLocationCircleEligibleConnection[]
  >([]);
  const [pendingInvites, setPendingInvites] = useState<
    OneLocationCircleMemberInvite[]
  >([]);
  const [remainingCapacity, setRemainingCapacity] = useState(0);
  const [peopleSearch, setPeopleSearch] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<
    Set<string>
  >(() => new Set());
  const [peopleLoadError, setPeopleLoadError] = useState<string | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleSubmitting, setPeopleSubmitting] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [cancellingInviteId, setCancellingInviteId] = useState<string | null>(
    null,
  );
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const loadRequestRef = useRef(0);
  const peopleRequestRef = useRef(0);
  const peopleSubmitInFlightRef = useRef(false);
  const cancelInviteInFlightRef = useRef(false);

  const reload = async (): Promise<OneLocationCircleDetail | null> => {
    const requestId = ++loadRequestRef.current;
    setLoadError(null);
    if (!circleId) {
      setCircle(null);
      setLoadError("This Circle link is incomplete.");
      return null;
    }
    try {
      const nextCircle = await onLoad(circleId);
      if (requestId !== loadRequestRef.current) return null;
      setCircle(nextCircle);
      setCircleName(nextCircle.name);
      setInviteCode(nextCircle.activeInviteCode ?? null);
      const nextCanInvite =
        nextCircle.viewerCapabilities?.canInviteMembers ??
        nextCircle.role === "owner";
      if (!nextCanInvite) {
        setPeopleSheetOpen(false);
        peopleRequestRef.current += 1;
      }
      return nextCircle;
    } catch (error) {
      if (requestId !== loadRequestRef.current) return null;
      setLoadError(
        error instanceof Error ? error.message : "Could not load this Circle.",
      );
      return null;
    }
  };

  useEffect(() => {
    setCircle(null);
    setInviteCode(null);
    setPeopleSheetOpen(false);
    setPeopleSearch("");
    setSelectedConnectionIds(new Set());
    setMemberSearch("");
    setSavingName(false);
    peopleRequestRef.current += 1;
    void reload();
    // `onLoad` is a stable page callback. Reload only when the selected id
    // changes; unrelated page refreshes must not refetch the focused detail.
    return () => {
      loadRequestRef.current += 1;
      peopleRequestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circleId]);

  // A re-read the caller asked for. Unlike the effect above it resets nothing:
  // the sheet stays open, the search keeps its text, the selection survives.
  const lastReloadSignalRef = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === lastReloadSignalRef.current) return;
    lastReloadSignalRef.current = reloadSignal;
    if (!circleId) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  const circle = loadedCircle?.id === circleId ? loadedCircle : null;
  const isOwner = circle?.role === "owner";
  // Stated by the server rather than inferred here.
  //
  // "Owner" and "not the emergency one" stopped being the right test when
  // Trusted arrived: it is deliberately NOT `is_system`, so it fell through to
  // the Delete button, which the API and a database trigger both refuse. The
  // fallbacks reproduce the old inference for a server that does not send the
  // fields yet.
  const canDeleteCircle =
    circle?.viewerCapabilities?.canDeleteCircle ??
    (isOwner && !circle?.isSystem);
  const canLeaveCircle = circle?.viewerCapabilities?.canLeaveCircle ?? !isOwner;
  // Dirty-tracked rename: the trailing control only presents as an explicit
  // "Save" once the typed name differs from the one every member currently
  // sees, so an untouched field never offers a no-op write.
  const trimmedCircleName = circleName.trim();
  const circleNameDirty = Boolean(circle) && trimmedCircleName !== circle?.name;
  const canSaveCircleName =
    circleNameDirty && trimmedCircleName.length >= 1 && !savingName && !busy;
  const canInviteMembers =
    circle?.viewerCapabilities?.canInviteMembers ?? Boolean(isOwner);
  const canViewInviteCode =
    circle?.viewerCapabilities?.canViewInviteCode ?? Boolean(isOwner);
  const canRotateInviteCode =
    circle?.viewerCapabilities?.canRotateInviteCode ?? Boolean(isOwner);
  const inviteCodeNeedsOwnerRotation = Boolean(
    circle?.inviteCodeNeedsOwnerRotation,
  );
  const members = useMemo(() => circle?.members ?? [], [circle?.members]);
  // One request in flight at a time: the roster re-renders from the reloaded
  // Circle, and two overlapping sends would leave the wrong row spinning.
  const [connectingUserId, setConnectingUserId] = useState<string | null>(null);
  // Circle Detail counts the rows it actually renders. The "Your circles" list
  // still uses the other-member summary helper; this focused screen needs the
  // visible roster count so the title and Members label never disagree.
  const visibleMemberSummary = circleDetailMemberCountLabel(members.length);

  // Filters the already-loaded Members list client-side, same as the "Add
  // people" sheet's connection search — a circle's roster is small enough
  // that there is no server round trip worth making for this.
  const filteredMembers = useMemo(
    () =>
      filterPeopleByQuery(
        sortPeopleByName(members, (member) => member.displayName),
        memberSearch,
        (member) => member.displayName,
      ),
    [members, memberSearch],
  );

  // Beside the "Members" heading. Unfiltered it is the same phrase the screen
  // title and the "Your circles" row use, so the number never changes wording
  // between the three places it appears; filtered it reports the match count
  // against the roster, because that is the list actually on screen.
  const memberCountLabel = memberSearch.trim()
    ? `${filteredMembers.length} of ${members.length}`
    : visibleMemberSummary;
  const showMemberSearch =
    members.length >= 8 || memberSearch.trim().length > 0;

  const filteredEligibleConnections = useMemo(
    () =>
      // Sorted before filtering, like every other people picker in Location.
      // These two sheets were rendering whatever order the server returned, so
      // the same two connections could swap places between two openings and a
      // long list had nowhere to start looking.
      filterPeopleByQuery(
        sortPeopleByName(
          eligibleConnections,
          (connection) => connection.displayName,
        ),
        peopleSearch,
        (connection) => connection.displayName,
      ),
    [eligibleConnections, peopleSearch],
  );

  const loadEligibleConnections = async () => {
    if (!circle || !canInviteMembers) return;
    const requestId = ++peopleRequestRef.current;
    setPeopleLoading(true);
    setPeopleLoadError(null);
    try {
      const result = await onLoadEligibleConnections(circle.id);
      if (requestId !== peopleRequestRef.current) return;
      setEligibleConnections(result.eligibleConnections);
      setPendingInvites(result.pendingInvites);
      setRemainingCapacity(result.remainingCapacity);
      setSelectedConnectionIds((current) => {
        const availableIds = new Set(
          result.eligibleConnections.map((connection) => connection.userId),
        );
        return new Set(
          [...current]
            .filter((id) => availableIds.has(id))
            .slice(0, result.remainingCapacity),
        );
      });
    } catch (error) {
      if (requestId !== peopleRequestRef.current) return;
      setPeopleLoadError(
        circleFlowErrorMessage(error, "Could not load your connections."),
      );
    } finally {
      if (requestId === peopleRequestRef.current) setPeopleLoading(false);
    }
  };

  const openPeopleSheet = () => {
    if (!circle || !canInviteMembers) return;
    setPeopleSheetOpen(true);
    setPeopleSearch("");
    setSelectedConnectionIds(new Set());
    void loadEligibleConnections();
  };

  const sendMemberInvites = async () => {
    if (
      !circle ||
      peopleSubmitInFlightRef.current ||
      !selectedConnectionIds.size
    ) {
      return;
    }
    const inviteeUserIds = [...selectedConnectionIds];
    peopleSubmitInFlightRef.current = true;
    setPeopleSubmitting(true);
    try {
      await onInviteConnections(circle.id, inviteeUserIds);
      toast.success(
        inviteeUserIds.length === 1
          ? "Added to the Circle."
          : `${inviteeUserIds.length} people added to the Circle.`,
      );
      // Adding is the sheet's terminal action for any selection size, so close
      // it and let the toast confirm. Bump the request ref first so a slower
      // in-flight eligibility load cannot repopulate a dismissed sheet, and
      // reload the detail behind it to pick up the new members.
      peopleRequestRef.current += 1;
      setSelectedConnectionIds(new Set());
      setPeopleSearch("");
      setPeopleSheetOpen(false);
      await reload();
    } catch (error) {
      toast.error(circleFlowErrorMessage(error, "Could not add them."));
      // Capacity or eligibility may have changed while the sheet was open.
      // Reconcile against the server before another tap so stale selections
      // are trimmed rather than repeatedly submitting a known conflict.
      const refreshedCircle = await reload();
      const stillCanInvite =
        refreshedCircle?.viewerCapabilities?.canInviteMembers ??
        refreshedCircle?.role === "owner";
      if (stillCanInvite) {
        await loadEligibleConnections();
      } else {
        setPeopleSheetOpen(false);
      }
    } finally {
      peopleSubmitInFlightRef.current = false;
      setPeopleSubmitting(false);
    }
  };

  const cancelMemberInvite = async (inviteId: string) => {
    if (cancelInviteInFlightRef.current) return;
    cancelInviteInFlightRef.current = true;
    setCancellingInviteId(inviteId);
    try {
      await onCancelMemberInvite(inviteId);
      toast.success("Circle invitation cancelled.");
      await loadEligibleConnections();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not cancel the invitation."),
      );
    } finally {
      cancelInviteInFlightRef.current = false;
      setCancellingInviteId(null);
    }
  };

  const generateCode = async (rotate = false) => {
    if (!circle || !canViewInviteCode || (rotate && !canRotateInviteCode)) {
      return;
    }
    try {
      setInviteCode(await onGenerateCode(circle.id, rotate));
      setReplaceCodeConfirmOpen(false);
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not create an invite code."),
      );
    }
  };

  const copyInviteCode = async (code: string) => {
    await onCopyCode(code);
    setCodeCopied(true);
    window.setTimeout(() => setCodeCopied(false), 1600);
  };

  // The rename is written server-side against the shared Circle row, so once it
  // resolves every member reads the new name on their next load. Reflect it
  // locally right away (header, delete/leave copy, "Add people to …") instead of
  // waiting for a refetch.
  const renameCircle = async (): Promise<boolean> => {
    const nextName = circleName.trim();
    if (
      !circle ||
      savingName ||
      nextName.length < 1 ||
      nextName === circle.name
    )
      return false;
    setSavingName(true);
    try {
      const updated = await onRename(circle.id, nextName);
      setCircle(updated);
      setCircleName(updated.name);
      return true;
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not rename this Circle."),
      );
      return false;
    } finally {
      setSavingName(false);
    }
  };

  const removeMember = async (memberUserId: string) => {
    if (!circle) return;
    try {
      await onRemoveMember(circle.id, memberUserId);
      await reload();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not remove this member."),
      );
    }
  };

  const leaveCircle = async () => {
    if (!circle) return;
    try {
      await onLeave(circle.id);
      onBack();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not leave this Circle."),
      );
    }
  };

  const deleteCircle = async () => {
    if (!circle) return;
    try {
      await onDelete(circle.id);
      onBack();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not delete this Circle."),
      );
    }
  };

  return (
    // `space-y-5`, and every section below owns its own internal rhythm. The
    // screen used to pair a 24px stack gap with `SettingsGroup`'s own 28px
    // heading margin, so the one gap on the page that mattered least -- the
    // one above "Members" -- was also the largest.
    <div className="space-y-5" data-testid="one-location-circle-detail-flow">
      {!circle ? (
        <TaskFlowHeader title="Circle" description="Loading Circle…" />
      ) : null}

      {loadError ? (
        <div
          role="alert"
          // Wash and hairline move onto the destructive family; the message
          // itself keeps `text-destructive`, which is the dark red this size
          // needs. The flat --app-destructive is the glyph tone and measures
          // ~3.5:1 here, under the 4.5:1 a 14px sentence requires.
          className="rounded-2xl border border-[color:var(--app-destructive-border)] bg-[color:var(--app-destructive-tint)] p-4 text-sm text-destructive"
        >
          {loadError}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void reload()}
            className="ml-2 h-11 rounded-full"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {circle ? (
        <>
          <div className="flex items-start justify-between gap-4 px-1">
            <TaskFlowHeader
              title={circle.name}
              description={visibleMemberSummary}
            />
            {isOwner && circle.systemKind !== "trusted" ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCircleName(circle.name);
                  setRenameSheetOpen(true);
                  window.setTimeout(() => nameInputRef.current?.focus(), 80);
                }}
                className="h-11 rounded-full px-4 text-[color:var(--app-accent)] hover:bg-[color:var(--app-neutral-fill)] hover:text-[color:var(--app-accent-hover)]"
              >
                Edit
              </Button>
            ) : null}
          </div>

          {isOwner && circle.systemKind !== "trusted" ? (
            <Sheet
              open={renameSheetOpen}
              onOpenChange={(open) => {
                setRenameSheetOpen(open);
                if (!open && circle) setCircleName(circle.name);
              }}
            >
              <SheetContent
                side="bottom"
                aria-describedby={undefined}
                className="mx-auto w-full rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-lg sm:px-6"
              >
                <SheetHeader className="text-left">
                  <SheetTitle>Rename Circle</SheetTitle>
                </SheetHeader>
                <div className="mt-5 space-y-4">
                  <label className="block space-y-2">
                    <span className="text-[15px] font-semibold leading-5 text-foreground">
                      Circle name
                    </span>
                    <div className={CIRCLE_NAME_ROW_CLASSNAME}>
                      <input
                        id={CIRCLE_NAME_INPUT_ID}
                        ref={nameInputRef}
                        value={circleName}
                        onChange={(event) => setCircleName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void renameCircle();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setRenameSheetOpen(false);
                            setCircleName(circle.name);
                          }
                        }}
                        maxLength={80}
                        autoComplete="off"
                        className={CIRCLE_NAME_INPUT_CLASSNAME}
                      />
                    </div>
                  </label>
                  {circleNameDirty && trimmedCircleName.length < 1 ? (
                    <p className="text-sm text-destructive">Enter a name.</p>
                  ) : null}
                  <Button
                    type="button"
                    disabled={!canSaveCircleName}
                    isLoading={savingName}
                    onClick={() =>
                      void renameCircle().then((saved) => {
                        if (saved) setRenameSheetOpen(false);
                      })
                    }
                    className={cn(
                      "h-12 w-full rounded-full text-base font-semibold",
                      BLOCKED_CTA,
                    )}
                    data-testid="one-location-circle-name-save"
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setRenameSheetOpen(false);
                      setCircleName(circle.name);
                    }}
                    className="h-11 w-full rounded-full"
                  >
                    Cancel
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          ) : null}

          {canInviteMembers || canViewInviteCode ? (
            <SettingsGroup
              title="Invite"
              separatorInset
              shellClassName="!rounded-[18px]"
              testId="one-location-circle-invite-card"
            >
              {canInviteMembers ? (
                <SettingsRow
                  icon={Plus}
                  iconTone="accent"
                  title="Add people"
                  chevron
                  onClick={openPeopleSheet}
                  disabled={busy}
                  testId="one-location-circle-add-people-row"
                />
              ) : null}
              {canViewInviteCode ? (
                <SettingsRow
                  icon={KeyRound}
                  iconTone="gray"
                  title="Invite code"
                  trailing={inviteCode ? "Ready" : "Create"}
                  chevron
                  onClick={() => {
                    setCodeCopied(false);
                    setInviteCodeSheetOpen(true);
                  }}
                  disabled={busy}
                  testId="one-location-circle-invite-code-row"
                />
              ) : null}
            </SettingsGroup>
          ) : null}

          {canViewInviteCode ? (
            <Sheet
              open={inviteCodeSheetOpen}
              onOpenChange={(open) => {
                setInviteCodeSheetOpen(open);
                if (!open) {
                  setCodeCopied(false);
                  setReplaceCodeConfirmOpen(false);
                }
              }}
            >
              <SheetContent
                side="bottom"
                aria-describedby={undefined}
                className="mx-auto w-full rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-lg sm:px-6"
              >
                <SheetHeader className="text-left">
                  <SheetTitle>Invite code</SheetTitle>
                  {!inviteCode && !inviteCodeNeedsOwnerRotation ? (
                    <SheetDescription>
                      Create a code to invite someone to this Circle.
                    </SheetDescription>
                  ) : null}
                </SheetHeader>
                {inviteCode ? (
                  <div className="mt-5 space-y-4">
                    <div className="rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] p-5 text-center shadow-[var(--app-card-shadow-standard)]">
                      <p className="break-all font-mono text-2xl font-bold tracking-[0.12em] text-foreground">
                        {inviteCode.code}
                      </p>
                      <p className={cn(MUTED_TEXT, "mt-3")}>
                        Joining does not share location.
                      </p>
                    </div>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => void onShareCode(circle, inviteCode.code)}
                      className="h-12 w-full rounded-full text-base font-semibold"
                    >
                      <Share2 className="mr-2 h-4 w-4" />
                      Share invite
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void copyInviteCode(inviteCode.code)}
                      className="h-12 w-full rounded-full text-base font-semibold"
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      {codeCopied ? "Copied" : "Copy code"}
                    </Button>
                    {canRotateInviteCode ? (
                      <AlertDialog
                        open={replaceCodeConfirmOpen}
                        onOpenChange={setReplaceCodeConfirmOpen}
                      >
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            className="h-11 w-full rounded-full"
                          >
                            Replace code
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent size="sm">
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Replace invite code?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              The current code will stop working.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              disabled={busy}
                              onClick={() => void generateCode(true)}
                            >
                              Replace code
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </div>
                ) : inviteCodeNeedsOwnerRotation && !canRotateInviteCode ? (
                  <div className="mt-5 rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-[var(--app-card-shadow-standard)]">
                    <p className="text-[17px] font-semibold leading-[22px] text-foreground">
                      Invite code unavailable
                    </p>
                    <p className={cn(MUTED_TEXT, "mt-1")}>
                      Ask the Circle owner for a new code.
                    </p>
                  </div>
                ) : (
                  <div className="mt-5 space-y-3">
                    <Button
                      type="button"
                      disabled={busy}
                      isLoading={busy}
                      onClick={() =>
                        void generateCode(inviteCodeNeedsOwnerRotation)
                      }
                      className="h-12 w-full rounded-full text-base font-semibold"
                    >
                      Create code
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setInviteCodeSheetOpen(false)}
                      className="h-11 w-full rounded-full"
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </SheetContent>
            </Sheet>
          ) : null}

          <Sheet
            open={peopleSheetOpen}
            onOpenChange={(open) => {
              if (open && !canInviteMembers) return;
              setPeopleSheetOpen(open);
              if (!open) {
                peopleRequestRef.current += 1;
                setPeopleSearch("");
                setSelectedConnectionIds(new Set());
              }
            }}
          >
            <SheetContent
              side="bottom"
              // Swiping down through the results is how a phone scrolls a list
              // back up. Left on, it drags the sheet away instead and can close
              // it outright, losing the query and every person already ticked.
              dragDismiss={false}
              // The keyboard height MUST stay in this max-height. SheetContent's
              // default is `max-h-[calc(85dvh-var(--kb-height,0px))]` paired with
              // `bottom-[var(--kb-height,0px)]`: the sheet lifts above the
              // keyboard and shrinks by the same amount. A bare dvh max-height
              // wins the tailwind-merge and drops only the shrink — so the sheet
              // still lifts, and the title and the search field the person just
              // tapped slide off the top of the screen. They then type into a
              // field they cannot see.
              className="mx-auto flex max-h-[calc(88dvh-var(--kb-height,0px))] w-full max-w-2xl flex-col rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6"
            >
              <SheetHeader className="text-left">
                <SheetTitle>Add people</SheetTitle>
                <SheetDescription>Choose connections.</SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
                <label className="relative block">
                  <span className="sr-only">Search connections</span>
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={peopleSearch}
                    onChange={(event) => setPeopleSearch(event.target.value)}
                    placeholder="Search people"
                    className={cn(
                      LOCATION_SEARCH_INPUT_CLASSNAME,
                      "h-12 rounded-full bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70",
                    )}
                  />
                </label>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  {peopleLoading ? (
                    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Loading connections…
                    </div>
                  ) : peopleLoadError ? (
                    <div className="space-y-3 rounded-2xl bg-muted/45 p-4">
                      <p className="text-sm text-muted-foreground">
                        {peopleLoadError}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void loadEligibleConnections()}
                        className="h-11 rounded-full"
                      >
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {remainingCapacity > 0 &&
                      filteredEligibleConnections.length ? (
                        <SettingsGroup testId="one-location-circle-eligible-connections">
                          {filteredEligibleConnections.map((connection) => {
                            const selected = selectedConnectionIds.has(
                              connection.userId,
                            );
                            const selectionAtCapacity =
                              selectedConnectionIds.size >= remainingCapacity;
                            return (
                              <SettingsRow
                                key={connection.userId}
                                leading={
                                  <Avatar className="h-10 w-10 rounded-xl">
                                    {connection.photoUrl ? (
                                      <AvatarImage
                                        src={connection.photoUrl}
                                        alt=""
                                      />
                                    ) : null}
                                    <AvatarFallback className="rounded-xl">
                                      {circleInitials(connection.displayName)}
                                    </AvatarFallback>
                                  </Avatar>
                                }
                                title={connection.displayName}
                                ariaPressed={selected}
                                disabled={!selected && selectionAtCapacity}
                                trailing={
                                  <span
                                    className={cn(
                                      "flex h-6 w-6 items-center justify-center rounded-full border",
                                      selected
                                        ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                                        : "border-border bg-background",
                                    )}
                                  >
                                    {selected ? (
                                      <Check className="h-4 w-4" />
                                    ) : null}
                                  </span>
                                }
                                onClick={() =>
                                  setSelectedConnectionIds((current) => {
                                    const next = new Set(current);
                                    if (next.has(connection.userId)) {
                                      next.delete(connection.userId);
                                    } else if (next.size < remainingCapacity) {
                                      next.add(connection.userId);
                                    }
                                    return next;
                                  })
                                }
                                testId={`one-location-circle-eligible-${connection.userId}`}
                              />
                            );
                          })}
                        </SettingsGroup>
                      ) : (
                        <EmptyState
                          title={
                            remainingCapacity === 0
                              ? "No room left in this Circle"
                              : peopleSearch.trim()
                                ? "No matching connections"
                                : "No connections to add"
                          }
                          description={
                            remainingCapacity === 0
                              ? "Circle is full."
                              : peopleSearch.trim()
                                ? undefined
                                : undefined
                          }
                          // A sentence pointing at Connect, shown inside a
                          // sheet that covers Connect, with nothing to press.
                          // A first-run person reaches this two taps after
                          // being told "invite people you're connected to",
                          // having none.
                          action={
                            remainingCapacity !== 0 && !peopleSearch.trim() ? (
                              <SheetClose asChild>
                                <Link
                                  href={`${ROUTES.CONNECT}?tab=all`}
                                  className={cn(
                                    buttonVariants({
                                      variant: "outline",
                                      size: "sm",
                                    }),
                                  )}
                                >
                                  Find people
                                </Link>
                              </SheetClose>
                            ) : undefined
                          }
                        />
                      )}

                      {pendingInvites.length ? (
                        <SettingsGroup title="Pending">
                          {pendingInvites.map((invite) => (
                            <SettingsRow
                              key={invite.id}
                              leading={
                                <Avatar className="h-10 w-10">
                                  {invite.inviteePhotoUrl ? (
                                    <AvatarImage
                                      src={invite.inviteePhotoUrl}
                                      alt=""
                                    />
                                  ) : null}
                                  <AvatarFallback>
                                    {circleInitials(
                                      invite.inviteeDisplayName ||
                                        "One connection",
                                    )}
                                  </AvatarFallback>
                                </Avatar>
                              }
                              title={
                                invite.inviteeDisplayName || "One connection"
                              }
                              description="Waiting"
                              trailing={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  disabled={Boolean(cancellingInviteId)}
                                  isLoading={cancellingInviteId === invite.id}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void cancelMemberInvite(invite.id);
                                  }}
                                  className="h-11 rounded-full px-3 text-destructive hover:text-destructive"
                                >
                                  Cancel
                                </Button>
                              }
                            />
                          ))}
                        </SettingsGroup>
                      ) : null}
                    </div>
                  )}
                </div>

                <Button
                  type="button"
                  disabled={
                    !selectedConnectionIds.size ||
                    peopleLoading ||
                    peopleSubmitting ||
                    Boolean(cancellingInviteId)
                  }
                  isLoading={peopleSubmitting}
                  onClick={() => void sendMemberInvites()}
                  className={cn(
                    "h-12 w-full shrink-0 rounded-full text-base font-semibold",
                    BLOCKED_CTA,
                  )}
                >
                  {selectedConnectionIds.size
                    ? `Add ${selectedConnectionIds.size} ${
                        selectedConnectionIds.size === 1 ? "person" : "people"
                      }`
                    : "Add people"}
                </Button>
              </div>
            </SheetContent>
          </Sheet>

          {/* One section, in reading order: what this is, how to narrow it,
              then the list. The search field used to sit ABOVE the "Members"
              heading, so the screen offered a way to filter a list it had not
              introduced yet -- and the heading it belonged to arrived after
              it, under `SettingsGroup`'s own 28px top margin. */}
          <section
            className="space-y-2.5"
            aria-labelledby={CIRCLE_MEMBERS_HEADING_ID}
          >
            <div className="flex items-baseline justify-between gap-3 px-1.5">
              <SectionLabel
                id={CIRCLE_MEMBERS_HEADING_ID}
                role="heading"
                aria-level={2}
              >
                Members
              </SectionLabel>
              {/* The count, not "Members connect through this Circle." -- the
                  invite card two cards up already says how membership works,
                  and a sentence that repeats it is a line of prose between a
                  heading and the thing it heads.

                  Under an active query it counts what is ON SCREEN. The same
                  "3 people" above a filtered list of one is the heading
                  contradicting the list it heads. */}
              <TrailingValue>{memberCountLabel}</TrailingValue>
            </div>

            {showMemberSearch ? (
              <label className="relative block">
                <span className="sr-only">Search members</span>
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                {/* The app's own field, so this search box and Connect's are
                    one control rather than two that resemble each other. */}
                <input
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  placeholder="Search members"
                  autoComplete="off"
                  className={cn(INPUT_CLASSNAME, "pl-11 pr-3.5")}
                  data-testid="one-location-circle-member-search"
                />
              </label>
            ) : null}

            {filteredMembers.length ? (
              <SettingsGroup
                testId="one-location-circle-members"
                // A synced Circle can hold up to 100 members (migration 158).
                // Capping the card's own height and scrolling inside it keeps
                // "Delete circle" and everything below reachable without
                // paging through the whole roster first.
                shellClassName={CIRCLE_MEMBERS_CARD_SHELL_CLASSNAME}
                contentClassName={CIRCLE_MEMBERS_CARD_SCROLL_CLASSNAME}
              >
                {filteredMembers.map((member) => (
                  <CircleMemberRow
                    key={member.userId}
                    member={member}
                    currentUserId={currentUserId}
                    isOwner={Boolean(isOwner)}
                    busy={busy}
                    membersRemovable={circle.systemKind !== "trusted"}
                    cancelling={cancellingUserId === member.userId}
                    onCancelRequest={
                      onCancelMemberRequest
                        ? async () => {
                            setCancellingUserId(member.userId);
                            try {
                              await onCancelMemberRequest(
                                circle.id,
                                member.userId,
                              );
                            } finally {
                              setCancellingUserId(null);
                            }
                          }
                        : undefined
                    }
                    onShare={() => onShareWithMember(circle.id, member.userId)}
                    onRemove={async () => {
                      await removeMember(member.userId);
                    }}
                    connecting={connectingUserId === member.userId}
                    onConnect={async () => {
                      if (connectingUserId) return;
                      setConnectingUserId(member.userId);
                      try {
                        await onConnectMember(circle.id, member.userId, {
                          displayName: member.displayName ?? null,
                          photoUrl: member.photoUrl ?? null,
                        });
                      } finally {
                        setConnectingUserId(null);
                      }
                    }}
                  />
                ))}
              </SettingsGroup>
            ) : (
              <div className={CIRCLES_EMPTY_STATE_WRAPPER}>
                <EmptyState
                  title="No members found"
                  description="Try a different name."
                />
              </div>
            )}
          </section>

          {/* A system Circle (today: SMS Contacts) is provisioned by the product
              and read by SOS, so deleting it would switch emergency alerts off
              with nothing on screen saying so. Every other owner power stays --
              rename, invite, remove. The API and a database trigger refuse the
              delete too; this only keeps the person from being offered
              something that cannot happen. */}
          {canDeleteCircle ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(CARD_SURFACE, CIRCLE_DESTRUCTIVE_ACTION)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete circle
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete “{circle.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the Circle for everyone. Circle shares will
                    stop. Direct shares stay unchanged.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="h-11 w-full sm:w-auto">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void deleteCircle()}
                    className="h-11 w-full sm:w-auto"
                  >
                    Delete Circle
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : canLeaveCircle ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  className={cn(CARD_SURFACE, CIRCLE_DESTRUCTIVE_ACTION)}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Leave circle
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Leave “{circle.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Circle shares with you will stop. Direct shares stay
                    unchanged.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="h-11 w-full sm:w-auto">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void leaveCircle()}
                    className="h-11 w-full sm:w-auto"
                  >
                    Leave Circle
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </>
      ) : !loadError ? (
        <div className="flex min-h-40 items-center justify-center rounded-[var(--app-card-radius-standard,24px)] bg-muted/35">
          <ShieldCheck className="h-8 w-8 animate-pulse text-muted-foreground" />
        </div>
      ) : null}
    </div>
  );
}
