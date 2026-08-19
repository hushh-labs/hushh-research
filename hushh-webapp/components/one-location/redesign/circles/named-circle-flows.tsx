"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  LogOut,
  MoreVertical,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Send,
  Share2,
  ShieldCheck,
  Trash2,
  Siren,
  UsersRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CREATE_CIRCLE_CTA_CLASSNAME,
  CREATE_CIRCLE_NAME_INPUT_CLASSNAME,
  CREATE_CIRCLE_NAME_PLACEHOLDER,
} from "@/components/one-location/redesign/circles/create-circle-layout";
import {
  createCircleCreateAttemptId,
  logCircleCreate,
  logCircleCreateLockCheck,
  logCircleCreateLockGuard,
  type CircleCreateAttemptId,
} from "@/lib/one-location/circle-create-diagnostics";
import type { OneLocationLockState } from "@/lib/one-location/circle-lock-state";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  EmptyState,
  TaskFlowHeader,
} from "@/components/one-location/redesign/primitives";
import { MUTED_TEXT } from "@/components/one-location/redesign/tokens";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import {
  CIRCLE_NAME_ACTION_CLASSNAME,
  CIRCLE_NAME_INPUT_CLASSNAME,
  CIRCLE_NAME_ROW_CLASSNAME,
} from "@/components/one-location/redesign/circles/circle-name-row-layout";
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
import { relationshipCta } from "@/lib/connections/relationship-label";
import { cn } from "@/lib/utils";

const CIRCLES_GROUP_SURFACE =
  "[--settings-group-radius:var(--app-radius-md)] !rounded-[var(--app-radius-md)] !bg-[color:var(--app-primary-surface)] !shadow-[var(--app-card-shadow-standard)]";

const CIRCLES_EMPTY_STATE_WRAPPER =
  "[&>[data-ui-role=grouped-card]]:rounded-[var(--app-radius-md)] [&>[data-ui-role=grouped-card]]:!bg-[color:var(--app-primary-surface)] [&>[data-ui-role=grouped-card]]:shadow-[var(--app-card-shadow-standard)]";

/**
 * A circle is a group of trusted people, so its glyph carries the PEOPLE role
 * rather than the accent used for things you can DO. The action controls that
 * sit alongside it (Create circle, Join, Share, Add people) stay accent, which is
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
/** Wording for a member count that has already excluded the viewer. */
export function othersCountLabel(others: number): string {
  if (others <= 0) return "No members yet";
  return `${others} ${others === 1 ? "person" : "people"}`;
}

export function circleListMemberCountLabel(memberCount: number): string {
  return othersCountLabel(Math.max(0, memberCount - 1));
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
    ? incomingInvites.find((invite) => invite.id === focusedInviteId) ?? null
    : null;

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
    <div className="space-y-[14px]" data-testid="one-location-named-circles">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-normal leading-[17px] tracking-[-0.2px] text-[color:var(--app-section-label)]">
          Your circles
        </h2>

        {/* The static phone reference omits Join, but it remains a shipped
            action. Both controls keep their handlers and voice IDs while the
            quiet treatment matches the reference hierarchy. */}
        <div className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-2 sm:gap-x-6">
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={onCreate}
            data-voice-control-id="one-location-action-create-circle"
            className="relative !h-auto !min-h-0 !rounded-none !px-0 !py-0 text-[16px] font-normal leading-5 tracking-[-0.24px] after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] sm:text-[15px]"
          >
            Create circle
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={onJoin}
            data-voice-control-id="one-location-action-join-circle"
            className="relative !h-auto !min-h-0 !rounded-none !px-0 !py-0 text-[16px] font-normal leading-5 tracking-[-0.24px] text-[color:var(--app-secondary-label)] after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] hover:text-foreground sm:text-[15px]"
          >
            Join with code
          </Button>
        </div>
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
          description="Join first. Sharing stays private."
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
                  "flex min-h-20 flex-col gap-3 px-4 py-3 outline-none sm:flex-row sm:items-center",
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

      {circles.length ? (
        <SettingsGroup
          separatorInset
          shellClassName={CIRCLES_GROUP_SURFACE}
          testId="one-location-circle-list"
        >
          {circles.map((circle) => {
            // STATE BEATS CATEGORY: a circle is the people role, but one
            // holding nobody except the viewer has nothing to report and
            // stays neutral. `memberCount` includes the viewer, so the
            // count that decides this is `memberCount - 1` — the same
            // test the check-in flow and the SMS contacts list apply.
            const circleRole = roleClasses("people", {
              inactive: Math.max(0, circle.memberCount - 1) === 0,
            });
            return (
            <SettingsRow
              key={circle.id}
              leading={
                <span
                  className={cn(
                    "flex h-11 w-11 items-center justify-center rounded-[12px]",
                    circleRole.tile,
                    circleRole.glyph,
                  )}
                >
                  {/* A different glyph, not just a different name. The SMS
                      Circle is the one row here that does something on its own
                      -- SOS reads it -- and a person scanning the list should
                      be able to tell it apart without reading. */}
                  {circle.isSystem ? (
                    <Siren className="h-5 w-5" />
                  ) : (
                    <UsersRound className="h-5 w-5" />
                  )}
                </span>
              }
              title={circle.name}
              description={
                circle.isSystem
                  ? `Emergency SMS · ${circleListMemberCountLabel(circle.memberCount)}`
                  : circleListMemberCountLabel(circle.memberCount)
              }
              trailing={circle.role === "owner" ? "Owner" : "Member"}
              chevron
              onClick={() => onOpen(circle.id)}
              className={cn(
                "[--settings-row-gap:16px] [--settings-row-px:20px] [--settings-row-py:20px] sm:[--settings-row-gap:18px] sm:[--settings-row-px:24px] sm:[--settings-row-py:22px]",
                "[&>button]:min-h-[84px] sm:[&>button]:min-h-[92px]",
                "[&_[data-slot=settings-row-title]]:!text-[18px] [&_[data-slot=settings-row-title]]:!font-semibold [&_[data-slot=settings-row-title]]:!leading-[22px] [&_[data-slot=settings-row-title]]:!tracking-[-0.35px] sm:[&_[data-slot=settings-row-title]]:!text-[19px] sm:[&_[data-slot=settings-row-title]]:!leading-6 sm:[&_[data-slot=settings-row-title]]:!tracking-[-0.4px]",
                "[&_[data-slot=settings-row-description]]:!text-[14px] [&_[data-slot=settings-row-description]]:!leading-[18px] [&_[data-slot=settings-row-description]]:!tracking-[-0.2px] sm:[&_[data-slot=settings-row-description]]:!text-[15px] sm:[&_[data-slot=settings-row-description]]:!leading-5 sm:[&_[data-slot=settings-row-description]]:!tracking-[-0.24px]",
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
  description: string;
}[] = [
  {
    value: "family",
    label: "Family",
    description: "Home, relatives and caregivers",
  },
  {
    value: "friends",
    label: "Friends",
    description: "Friends, roommates and travel groups",
  },
  {
    value: "other",
    label: "Other",
    description: "A custom trusted group",
  },
];

export function CreateCircleFlow({
  busy,
  lockState,
  onSubmit,
  renderUnlock,
}: {
  busy: boolean;
  /**
   * Whether this account currently holds a lock token. Circles are reachable
   * without one (VaultLockGuard admits a no-lock account), so the screen has to
   * know, rather than discovering it in the failure path of the last tap.
   */
  lockState: OneLocationLockState;
  onSubmit: (name: string, kind: OneLocationCircleKind) => Promise<void>;
  /**
   * Renders the unlock sheet. Owned by the caller so this file keeps no vault
   * dependency and the sheet stays the same one the rest of the app uses.
   * `onDone(true)` on a successful unlock, `onDone(false)` when dismissed.
   */
  renderUnlock?: (props: {
    open: boolean;
    onDone: (unlocked: boolean) => void;
  }) => React.ReactNode;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OneLocationCircleKind>("family");
  const [unlockOpen, setUnlockOpen] = useState(false);
  // An attempt that unlocked and is waiting for the token to actually reach
  // this component. See `handleUnlockDone` for why it cannot resume inline.
  const [pendingResume, setPendingResume] = useState<CircleCreateAttemptId | null>(
    null,
  );
  // A submit already in flight. `busy` cannot carry this on its own: the page
  // only raises it once the request starts, so a second tap during the lock
  // decision — or during the unlock sheet — would otherwise start a second
  // create. Held in a ref because it must be readable in the same tick as the
  // tap that sets it.
  const submittingRef = useRef(false);
  // The attempt the unlock sheet was opened for. Kept so a successful unlock
  // resumes THAT create, and a stale sheet cannot resurrect an abandoned one.
  const pendingAttemptRef = useRef<CircleCreateAttemptId | null>(null);
  const trimmedName = name.trim();
  // "Not known yet" is not "locked". While identity settles the CTA waits
  // rather than accusing an unlocked person of being locked.
  const lockResolving = lockState === "resolving";
  // One typed character is a name. Requiring two silently withheld the button
  // from anyone naming a circle "A", with nothing on screen saying why.
  const canSubmit = trimmedName.length >= 1 && !busy && !lockResolving;

  const runCreate = async (attemptId: CircleCreateAttemptId, resumed: boolean) => {
    const startedAt = Date.now();
    logCircleCreate("API", {
      attemptId,
      endpoint: "POST /api/one/location/circles",
      started: true,
      resumed,
    });
    try {
      await onSubmit(trimmedName, kind);
      logCircleCreate("Success", {
        attemptId,
        durationMs: Date.now() - startedAt,
        resumed,
        circleKind: kind,
      });
    } catch (error) {
      // A server rejection is a server rejection. It keeps its own message and
      // is never relabelled as a lock problem.
      logCircleCreate("Failure", {
        attemptId,
        stage: "api",
        reason: error instanceof Error ? error.name : "unknown",
        durationMs: Date.now() - startedAt,
        resumed,
      });
      toast.error(
        circleFlowErrorMessage(error, "Could not create this Circle."),
      );
    }
  };

  const submit = async () => {
    if (submittingRef.current) return;
    const attemptId = createCircleCreateAttemptId();
    logCircleCreate("Click", {
      attemptId,
      route: "/one/location?action=create-circle",
      circleKind: kind,
      hasName: trimmedName.length > 0,
    });
    logCircleCreateLockCheck(attemptId, lockState);

    if (lockResolving) {
      // Unreachable from the CTA (it is disabled), kept so a programmatic
      // caller cannot turn an unsettled state into a refusal.
      logCircleCreateLockGuard(attemptId, "wait", "lock_state_unsettled");
      return;
    }

    if (lockState === "locked") {
      logCircleCreateLockGuard(attemptId, "unlock_required", "no_owner_token");
      if (!renderUnlock) {
        // No sheet available (a caller that did not wire one). Fall through to
        // the handler so its own typed error surfaces rather than nothing
        // happening at all.
        submittingRef.current = true;
        try {
          await runCreate(attemptId, false);
        } finally {
          submittingRef.current = false;
        }
        return;
      }
      submittingRef.current = true;
      pendingAttemptRef.current = attemptId;
      logCircleCreate("Unlock", { attemptId, phase: "opened" });
      setUnlockOpen(true);
      return;
    }

    logCircleCreateLockGuard(attemptId, "allow", "owner_token_present");
    submittingRef.current = true;
    try {
      await runCreate(attemptId, false);
    } finally {
      submittingRef.current = false;
    }
  };

  const handleUnlockDone = (unlocked: boolean) => {
    const attemptId = pendingAttemptRef.current;
    pendingAttemptRef.current = null;
    setUnlockOpen(false);
    if (!attemptId) {
      submittingRef.current = false;
      return;
    }
    if (!unlocked) {
      // Cancelled. Nothing was created, the typed name and the chosen kind are
      // untouched, and the screen is exactly where it was.
      logCircleCreate("Unlock", { attemptId, phase: "cancelled" });
      logCircleCreate("Resume", { attemptId, resumed: false, reason: "unlock_cancelled" });
      submittingRef.current = false;
      return;
    }
    logCircleCreate("Unlock", { attemptId, phase: "succeeded" });
    // Park it. Do NOT create here: VaultFlow calls unlockVault() and onSuccess()
    // in the SAME tick (components/vault/vault-flow.tsx:341-342), and
    // unlockVault is plain state setters, so React has not re-rendered yet.
    // Creating now would run the submit handler this render closed over — the
    // one holding the null token — and throw the very error the unlock just
    // cleared. The effect below runs it once the token has actually arrived.
    setPendingResume(attemptId);
  };

  useEffect(() => {
    if (!pendingResume) return;
    // Still settling: keep waiting rather than deciding on an unknown.
    if (lockState === "resolving") return;
    const attemptId = pendingResume;
    setPendingResume(null);
    if (lockState === "locked") {
      // The sheet reported success but no token reached us. Release the form
      // instead of leaving it spinning on a create that can never run.
      logCircleCreate("Resume", {
        attemptId,
        resumed: false,
        reason: "lock_not_ready",
      });
      submittingRef.current = false;
      return;
    }
    logCircleCreate("Resume", {
      attemptId,
      resumed: true,
      preservedName: trimmedName.length > 0,
      preservedKind: kind,
    });
    void (async () => {
      try {
        await runCreate(attemptId, true);
      } finally {
        submittingRef.current = false;
      }
    })();
    // `runCreate` is recreated every render and re-running this effect for that
    // alone would double-submit. The parked attempt id is the trigger; the
    // lock state is the condition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingResume, lockState]);

  return (
    <div className="space-y-6" data-testid="one-location-create-circle-flow">
      {/* No `eyebrow` — a single-screen flow does not need the route name
          repeated above the title (location-header-system treats the
          eyebrow as optional). */}
      <TaskFlowHeader
        title="Create a circle"
        description="A private group for people you trust."
      />

      <label className="block space-y-2">
        <span className="text-sm font-semibold text-foreground">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoComplete="off"
          spellCheck
          placeholder={CREATE_CIRCLE_NAME_PLACEHOLDER}
          className={CREATE_CIRCLE_NAME_INPUT_CLASSNAME}
        />
      </label>

      <SettingsGroup title="Who is it for?" separatorInset>
        {CIRCLE_KIND_OPTIONS.map((option) => (
          <SettingsRow
            key={option.value}
            // Stays on SettingsRow's own `icon` slot: that slot is what carries
            // `data-slot="settings-row-icon"` (global CSS thins the glyph
            // stroke through it), the `data-ui-role`/`data-icon-tone` hooks,
            // and the group's density switch. A people tone is missing from the
            // shared tone map, so the row keeps the tones it already had and
            // the missing entry is recorded as deferred rather than worked
            // around by re-implementing the slot here.
            icon={UsersRound}
            iconTone={option.value === "family" ? "purple" : "blue"}
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

      <p className="flex items-center gap-1.5 text-[14px] leading-4 text-[color:var(--app-secondary-label)]">
        <ShieldCheck
          className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        Sharing starts only when you choose.
      </p>

      <Button
        type="button"
        disabled={!canSubmit}
        // Spins while the request runs AND while identity is still settling, so
        // an unsettled lock reads as "one moment" rather than as a dead button.
        isLoading={busy || lockResolving}
        onClick={() => void submit()}
        className={cn(CREATE_CIRCLE_CTA_CLASSNAME, BLOCKED_CTA)}
        data-lock-state={lockState}
      >
        Create circle
      </Button>

      {renderUnlock
        ? renderUnlock({
            open: unlockOpen,
            onDone: (unlocked) => void handleUnlockDone(unlocked),
          })
        : null}
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

  const join = async () => {
    if (!resolved) return;
    try {
      await onJoin(resolved.code);
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not join this Circle."),
      );
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

function CircleMemberRow({
  member,
  currentUserId,
  isOwner,
  busy,
  onShare,
  onRemove,
  onConnect,
  connecting = false,
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
}) {
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const isCurrentUser = member.userId === currentUserId;
  const canShare =
    !isCurrentUser && member.phoneVerified && member.secureLocationReady;
  const canRemove = isOwner && member.role !== "owner";
  // Only where a request is actually possible. 'self' and 'connected' have
  // nothing to ask for; the two pending states already have one in flight and
  // render as a disabled "Requested"/"Respond" so the row still reports where
  // things stand rather than going blank.
  const connectCta =
    !isCurrentUser && member.relationship && member.relationship !== "self"
      ? relationshipCta(member.relationship)
      : null;

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Avatar className="mt-0.5 h-11 w-11 shrink-0">
        {member.photoUrl ? (
          <AvatarImage src={member.photoUrl} alt="" />
        ) : null}
        <AvatarFallback>{circleInitials(member.displayName)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 py-1">
        <p className="break-words text-[15px] font-semibold leading-snug text-foreground">
          {member.displayName}
          {isCurrentUser ? " (you)" : ""}
        </p>
        <p className={cn(MUTED_TEXT, "truncate")}>
          {member.role === "owner"
            ? "Circle owner"
            : member.secureLocationReady
              ? "Ready for private sharing"
              : "Location setup needed"}
        </p>
      </div>
      {connectCta ? (
        <Button
          type="button"
          size="sm"
          variant={connectCta.disabled ? "secondary" : "default"}
          disabled={busy || connecting || connectCta.disabled}
          aria-label={
            connectCta.disabled
              ? `${member.displayName}: ${connectCta.label}`
              : `Connect with ${member.displayName}`
          }
          data-testid={`circle-member-connect-${member.userId}`}
          className="mt-0.5 h-9 shrink-0 rounded-full"
          onClick={() => {
            if (connectCta.action === "connect") void onConnect?.();
          }}
        >
          {connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            connectCta.label
          )}
        </Button>
      ) : null}
      {canShare || canRemove ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={busy}
              aria-label={`Actions for ${member.displayName}`}
              className="mt-0.5 h-11 w-11 shrink-0 rounded-full"
            >
              <MoreVertical className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canShare ? (
              <DropdownMenuItem onSelect={() => onShare()}>
                <Share2 className="h-4 w-4" />
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
      ) : null}
      {canRemove ? (
        <AlertDialog open={confirmRemoveOpen} onOpenChange={setConfirmRemoveOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Remove {member.displayName}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Circle-sourced live shares involving this member will stop.
                Their other connections and shares stay unchanged.
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
  onShareCode: (
    circle: OneLocationCircleDetail,
    code: string,
  ) => Promise<void>;
  onShareWithMember: (circleId: string, userId: string) => void;
  onRemoveMember: (circleId: string, userId: string) => Promise<void>;
  /**
   * Sends a connection request to a co-member.
   *
   * Sharing a Circle does not connect two people -- a joiner is paired with
   * whoever invited them and nobody else -- so the roster is where that
   * introduction can be asked for explicitly, and answered by the other person.
   */
  onConnectMember: (circleId: string, userId: string) => Promise<void>;
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
  const [loadedCircle, setCircle] =
    useState<OneLocationCircleDetail | null>(null);
  const [inviteCode, setInviteCode] =
    useState<OneLocationCircleInviteCode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [circleName, setCircleName] = useState("");
  const [peopleSheetOpen, setPeopleSheetOpen] = useState(false);
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

  const circle =
    loadedCircle?.id === circleId ? loadedCircle : null;
  const isOwner = circle?.role === "owner";
  // Dirty-tracked rename: the trailing control only presents as an explicit
  // "Save" once the typed name differs from the one every member currently
  // sees, so an untouched field never offers a no-op write.
  const trimmedCircleName = circleName.trim();
  const circleNameDirty =
    Boolean(circle) && trimmedCircleName !== circle?.name;
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
  // Single source of truth for the member count shown on BOTH the "Your
  // circles" list row and this detail subtitle: the number of OTHER people in
  // the circle (everyone except the viewer). `circle.memberCount` from the
  // backend includes the viewer, so the list row subtracts one; here we filter
  // the loaded members by the current user id, which yields the same number.
  // Excluding only the current user (not the owner role) keeps the two views
  // in agreement for members viewing a circle they do not own.
  const externalMembersCount = useMemo(
    () => members.filter((member) => member.userId !== currentUserId).length,
    [members, currentUserId],
  );

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

  const filteredEligibleConnections = useMemo(
    () =>
      // Sorted before filtering, like every other people picker in Location.
      // These two sheets were rendering whatever order the server returned, so
      // the same two connections could swap places between two openings and a
      // long list had nowhere to start looking.
      filterPeopleByQuery(
        sortPeopleByName(eligibleConnections, (connection) => connection.displayName),
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
    if (
      !circle ||
      !canViewInviteCode ||
      (rotate && !canRotateInviteCode)
    ) {
      return;
    }
    try {
      setInviteCode(await onGenerateCode(circle.id, rotate));
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not create an invite code."),
      );
    }
  };

  // The rename is written server-side against the shared Circle row, so once it
  // resolves every member reads the new name on their next load. Reflect it
  // locally right away (header, delete/leave copy, "Add people to …") instead of
  // waiting for a refetch.
  const renameCircle = async () => {
    const nextName = circleName.trim();
    if (!circle || savingName || nextName.length < 1 || nextName === circle.name)
      return;
    setSavingName(true);
    try {
      const updated = await onRename(circle.id, nextName);
      setCircle(updated);
      setCircleName(updated.name);
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not rename this Circle."),
      );
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
    <div className="space-y-6" data-testid="one-location-circle-detail-flow">
      <TaskFlowHeader
        eyebrow="Your circles"
        title={circle?.name ?? "Circle"}
        description={
          circle
            ? // Same line as the list row this screen was opened from, so the
              // count does not change wording between the two. The kind is
              // dropped here for the same reason it is dropped there.
              othersCountLabel(externalMembersCount)
            : "Loading Circle…"
        }
      />

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
          {isOwner ? (
            <div className="rounded-[22px] border border-border bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-sm">
              <label
                htmlFor={CIRCLE_NAME_INPUT_ID}
                className="block text-sm font-semibold text-foreground"
              >
                Circle name
              </label>
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
                    } else if (event.key === "Escape" && circleNameDirty) {
                      event.preventDefault();
                      setCircleName(circle.name);
                    }
                  }}
                  maxLength={80}
                  autoComplete="off"
                  className={CIRCLE_NAME_INPUT_CLASSNAME}
                />
                {circleNameDirty ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canSaveCircleName}
                    isLoading={savingName}
                    onClick={() => void renameCircle()}
                    className={CIRCLE_NAME_ACTION_CLASSNAME}
                    data-testid="one-location-circle-name-save"
                  >
                    Save
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label="Edit Circle name"
                    onClick={() => nameInputRef.current?.focus()}
                    className={CIRCLE_NAME_ACTION_CLASSNAME}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <p className={cn(MUTED_TEXT, "mt-2")}>
                {circleNameDirty && trimmedCircleName.length < 1
                  ? "Enter a name."
                  : circleNameDirty
                    ? "Tap Save to rename."
                    : "Circle members see this."}
              </p>
            </div>
          ) : null}

          {canInviteMembers ? (
            <div
              className="rounded-[22px] border border-border bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-sm"
              data-testid="one-location-circle-invite-card"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
                  <KeyRound className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground">
                    Invite people
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Every Circle member can invite an existing connection or
                    share the same Circle code.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={openPeopleSheet}
                className="mt-4 h-11 w-full rounded-full font-semibold"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add people
              </Button>
              {canViewInviteCode && inviteCode ? (
                <div className="mt-4 rounded-2xl bg-muted/55 p-4 text-center">
                  <p className="break-all font-mono text-lg font-bold tracking-[0.08em] text-foreground min-[360px]:text-xl min-[360px]:tracking-[0.12em]">
                    {inviteCode.code}
                  </p>
                  <p className={cn(MUTED_TEXT, "mt-2")}>
                    Joining connects Circle members. Location and SMS stay
                    private until each person chooses to share.
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void onCopyCode(inviteCode.code)}
                      className="h-11 rounded-full"
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </Button>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void onShareCode(circle, inviteCode.code)
                      }
                      className="h-11 rounded-full"
                    >
                      <Share2 className="mr-2 h-4 w-4" />
                      Share
                    </Button>
                  </div>
                </div>
              ) : canViewInviteCode && inviteCodeNeedsOwnerRotation ? (
                canRotateInviteCode ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    isLoading={busy}
                    onClick={() => void generateCode(true)}
                    className="mt-2 h-11 w-full rounded-full font-semibold"
                  >
                    <RotateCw className="mr-2 h-4 w-4" />
                    Refresh invite code
                  </Button>
                ) : (
                  <p className="mt-3 rounded-2xl bg-muted/55 px-4 py-3 text-sm leading-5 text-muted-foreground">
                    Ask the Circle owner to refresh the older invite code. It
                    will appear here for every member as soon as they do.
                  </p>
                )
              ) : canViewInviteCode ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  isLoading={busy}
                  onClick={() => void generateCode()}
                  className="mt-2 h-11 w-full rounded-full font-semibold"
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  Generate invite code
                </Button>
              ) : null}
              {inviteCode && canRotateInviteCode ? (
                <Button
                  type="button"
                  variant="ghost"
                  isLoading={busy}
                  onClick={() => void generateCode(true)}
                  className="mt-2 h-11 w-full rounded-full"
                >
                  <RotateCw className="mr-2 h-4 w-4" />
                  Rotate code
                </Button>
              ) : null}
            </div>
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
                <SheetTitle>Add people to {circle.name}</SheetTitle>
                <SheetDescription>
                  {/* No Circle sends invitations any more. Only existing
                      connections can be picked here, and two people who are
                      already connected have already agreed to know each other
                      -- so the membership is written on tap and the person is
                      notified. Saying "they join after accepting" would
                      describe a step that no longer happens, on the screen
                      where believing it means thinking you still have time to
                      change your mind. */}
                  {circle.isSystem
                    ? "Choose existing connections. They are added straight away, so SMS alerts reach them immediately."
                    : "Choose existing connections. They are added straight away and told you added them."}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
                <label className="relative block">
                  <span className="sr-only">Search connections</span>
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={peopleSearch}
                    onChange={(event) => setPeopleSearch(event.target.value)}
                    placeholder="Search connections"
                    className="h-12 w-full rounded-full border border-border bg-muted/40 pl-11 pr-4 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
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
                        <SettingsGroup
                          title="Your connections"
                          description={
                            remainingCapacity === 1
                              ? "You can add 1 more person right now."
                              : `You can add ${remainingCapacity} more people right now.`
                          }
                          testId="one-location-circle-eligible-connections"
                        >
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
                                description="Connected on One"
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
                                    } else if (
                                      next.size < remainingCapacity
                                    ) {
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
                                ? "Try a different name."
                                : "Add someone in Connect first."
                          }
                        />
                      )}

                      {pendingInvites.length ? (
                        <SettingsGroup
                          title="Pending invitations"
                          description="Cancel anytime before acceptance."
                        >
                          {pendingInvites.map((invite) => (
                            <SettingsRow
                              key={invite.id}
                              icon={Send}
                              // Awaiting acceptance is PENDING, not an action.
                              iconTone="orange"
                              title={
                                invite.inviteeDisplayName || "One connection"
                              }
                              description="Waiting for them to join"
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
                    : "Select people"}
                </Button>
              </div>
            </SheetContent>
          </Sheet>

          <div className="space-y-3">
            {members.length ? (
              <label className="relative block">
                <span className="sr-only">Search members</span>
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  placeholder="Search members"
                  autoComplete="off"
                  className="h-11 w-full rounded-full border border-border bg-[color:var(--app-card-surface-default-solid)] pl-11 pr-4 text-base outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
                  data-testid="one-location-circle-member-search"
                />
              </label>
            ) : null}

            {filteredMembers.length ? (
              <SettingsGroup
                title="Members"
                description="Members connect through this Circle."
                testId="one-location-circle-members"
                // A synced Circle can hold up to 100 members (migration 158).
                // Capping the card's own height and scrolling inside it keeps
                // "Delete circle" and everything below reachable without
                // paging through the whole roster first.
                shellClassName="flex max-h-[60vh] flex-col"
                contentClassName="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
              >
                {filteredMembers.map((member) => (
                  <CircleMemberRow
                    key={member.userId}
                    member={member}
                    currentUserId={currentUserId}
                    isOwner={Boolean(isOwner)}
                    busy={busy}
                    onShare={() =>
                      onShareWithMember(circle.id, member.userId)
                    }
                    onRemove={async () => {
                      await removeMember(member.userId);
                    }}
                    connecting={connectingUserId === member.userId}
                    onConnect={async () => {
                      if (connectingUserId) return;
                      setConnectingUserId(member.userId);
                      try {
                        await onConnectMember(circle.id, member.userId);
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
          </div>

          {/* A system Circle (today: SMS Contacts) is provisioned by the product
              and read by SOS, so deleting it would switch emergency alerts off
              with nothing on screen saying so. Every other owner power stays --
              rename, invite, remove. The API and a database trigger refuse the
              delete too; this only keeps the person from being offered
              something that cannot happen. */}
          {isOwner && !circle.isSystem ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full rounded-full border-destructive/35 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete circle
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {circle.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Members will lose this Circle and Circle-sourced shares will
                    stop. Unrelated connections and direct shares stay intact.
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
                    Delete circle
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  className="h-11 w-full rounded-full border-destructive/35 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Leave circle
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Leave {circle.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Circle-sourced live shares involving you will stop. Your
                    unrelated connections and direct shares stay unchanged.
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
                    Leave circle
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </>
      ) : !loadError ? (
        <div className="flex min-h-40 items-center justify-center rounded-[22px] bg-muted/35">
          <ShieldCheck className="h-8 w-8 animate-pulse text-muted-foreground" />
        </div>
      ) : null}
    </div>
  );
}
