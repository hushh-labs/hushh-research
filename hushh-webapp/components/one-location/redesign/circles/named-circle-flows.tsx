"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Send,
  Share2,
  ShieldCheck,
  Trash2,
  UsersRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
  TrustNoteCard,
} from "@/components/one-location/redesign/primitives";
import { MUTED_TEXT, SECTION_TITLE } from "@/components/one-location/redesign/tokens";
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
import { cn } from "@/lib/utils";

function circleInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function circleKindLabel(kind: OneLocationCircleKind): string {
  if (kind === "family") return "Family";
  if (kind === "friends") return "Friends";
  return "Other";
}

/**
 * Subtitle for the "Your circles" list row, e.g. "Friends · 2 members".
 *
 * Counts OTHER members (everyone except the viewer) so it matches the Circle
 * Detail subtitle, which filters out the current user. The backend
 * `memberCount` includes the viewer — always a member of a circle shown in
 * their own list — so subtracting one yields the same number both places.
 * `Math.max(0, ...)` guards a transient zero.
 */
function circleListMemberCountLabel(
  kind: OneLocationCircleKind,
  memberCount: number,
): string {
  const others = Math.max(0, memberCount - 1);
  return `${circleKindLabel(kind)} · ${others} ${
    others === 1 ? "member" : "members"
  }`;
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
    <div className="space-y-3" data-testid="one-location-named-circles">
      <div className="flex items-center justify-between gap-3 px-1">
        <div>
          <h2 className={SECTION_TITLE}>
            Your circles
          </h2>
          <p className={cn(MUTED_TEXT, "mt-1")}>
            Family and friends you choose to group together.
          </p>
        </div>
      </div>

      {incomingInvitesError ? (
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
      ) : null}

      {incomingInvitesLoading &&
      !incomingInvites.length &&
      !incomingInvitesError ? (
        <div
          role="status"
          className="flex min-h-16 items-center justify-center gap-2 rounded-2xl bg-muted/35 text-sm text-muted-foreground"
        >
          <Loader2 className="h-5 w-5 animate-spin" />
          Checking Circle invitations…
        </div>
      ) : null}

      {incomingInvites.length ? (
        <SettingsGroup
          title="Circle invitations"
          description="Joining connects you with current and future Circle members. Location and SMS stay private until you choose to share."
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
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
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
      ) : null}

      {circles.length ? (
        <SettingsGroup separatorInset testId="one-location-circle-list">
          {circles.map((circle) => (
            <SettingsRow
              key={circle.id}
              leading={
                <span
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl",
                    circle.kind === "family"
                      ? "bg-violet-500/12 text-violet-700 dark:text-violet-200"
                      : circle.kind === "friends"
                        ? "bg-sky-500/12 text-sky-700 dark:text-sky-200"
                        : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-200",
                  )}
                >
                  <UsersRound className="h-5 w-5" />
                </span>
              }
              title={circle.name}
              description={circleListMemberCountLabel(
                circle.kind,
                circle.memberCount,
              )}
              trailing={circle.role === "owner" ? "Owner" : "Member"}
              chevron
              onClick={() => onOpen(circle.id)}
              testId={`one-location-circle-${circle.id}`}
            />
          ))}
        </SettingsGroup>
      ) : (
        <EmptyState
          title="No circles yet"
          description="Create one for family or friends, or join with a code."
        />
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          onClick={onCreate}
          data-voice-control-id="one-location-action-create-circle"
          className="h-11 rounded-full font-semibold"
        >
          <Plus className="mr-2 h-4 w-4" />
          Create
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onJoin}
          data-voice-control-id="one-location-action-join-circle"
          className="h-11 rounded-full font-semibold"
        >
          <KeyRound className="mr-2 h-4 w-4" />
          Join with code
        </Button>
      </div>
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
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (name: string, kind: OneLocationCircleKind) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OneLocationCircleKind>("family");
  const canSubmit = name.trim().length >= 2 && !busy;

  const submit = async () => {
    try {
      await onSubmit(name.trim(), kind);
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not create this Circle."),
      );
    }
  };

  return (
    <div className="space-y-6" data-testid="one-location-create-circle-flow">
      <TaskFlowHeader
        eyebrow="People"
        title="Create a circle"
        description="Give this group a name. People join only by accepting an invitation or entering its code."
      />

      <label className="block space-y-2">
        <span className="text-sm font-semibold text-foreground">
          Circle name
        </span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoComplete="off"
          spellCheck
          placeholder="e.g. Meena Family"
          className="h-12 w-full rounded-2xl border border-border bg-[color:var(--app-card-surface-default-solid)] px-4 text-base outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
        />
      </label>

      <SettingsGroup title="Circle type" separatorInset>
        {CIRCLE_KIND_OPTIONS.map((option) => (
          <SettingsRow
            key={option.value}
            icon={UsersRound}
            iconTone={option.value === "family" ? "purple" : "blue"}
            title={option.label}
            description={option.description}
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

      <TrustNoteCard
        title="Connected, still private"
        description="Circle members become connections with current and future members. Location and SMS stay private until each person chooses to share."
      />

      <Button
        type="button"
        disabled={!canSubmit}
        isLoading={busy}
        onClick={() => void submit()}
        className="h-12 w-full rounded-full text-base font-semibold"
      >
        Create circle
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
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
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
          className="h-12 w-full rounded-full text-base font-semibold"
        >
          Preview circle
        </Button>
      )}

      <TrustNoteCard
        title="No request wait"
        description="A valid code is your consent to join and connect with the Circle. Location access remains explicit, time-limited and revocable."
      />
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
}: {
  member: OneLocationCircleMember;
  currentUserId: string | null;
  isOwner: boolean;
  busy: boolean;
  onShare: () => void;
  onRemove: () => Promise<void>;
}) {
  const isCurrentUser = member.userId === currentUserId;
  const canShare =
    !isCurrentUser && member.phoneVerified && member.secureLocationReady;

  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <Avatar className="h-11 w-11">
        {member.photoUrl ? (
          <AvatarImage src={member.photoUrl} alt="" />
        ) : null}
        <AvatarFallback>{circleInitials(member.displayName)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-foreground">
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
      {canShare ? (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={onShare}
          className="h-11 min-w-16 rounded-full"
        >
          Share
        </Button>
      ) : null}
      {isOwner && member.role !== "owner" ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Remove ${member.displayName} from this Circle`}
              className="h-11 shrink-0 rounded-full px-3 font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Remove
            </Button>
          </AlertDialogTrigger>
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
    circleNameDirty && trimmedCircleName.length >= 2 && !savingName && !busy;
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

  const filteredEligibleConnections = useMemo(() => {
    const query = peopleSearch.trim().toLocaleLowerCase();
    if (!query) return eligibleConnections;
    return eligibleConnections.filter((connection) =>
      connection.displayName.toLocaleLowerCase().includes(query),
    );
  }, [eligibleConnections, peopleSearch]);

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
          ? "Circle invitation sent."
          : `${inviteeUserIds.length} Circle invitations sent.`,
      );
      // Sending is the sheet's terminal action for any selection size, so close
      // it and let the toast confirm. Bump the request ref first so a slower
      // in-flight eligibility load cannot repopulate a dismissed sheet, and
      // reload the detail behind it to pick up the new pending invitations.
      peopleRequestRef.current += 1;
      setSelectedConnectionIds(new Set());
      setPeopleSearch("");
      setPeopleSheetOpen(false);
      await reload();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not send the invitation."),
      );
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
    if (!circle || savingName || nextName.length < 2 || nextName === circle.name)
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
            ? `${circleKindLabel(circle.kind)} · ${externalMembersCount} ${
                externalMembersCount === 1 ? "member" : "members"
              }`
            : "Loading Circle…"
        }
      />

      {loadError ? (
        <div
          role="alert"
          className="rounded-2xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive"
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
              <div className="mt-2 flex gap-2">
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
                  className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-base outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
                />
                {circleNameDirty ? (
                  <Button
                    type="button"
                    disabled={!canSaveCircleName}
                    isLoading={savingName}
                    onClick={() => void renameCircle()}
                    className="h-11 shrink-0 rounded-xl px-4 font-semibold"
                    data-testid="one-location-circle-name-save"
                  >
                    <Check className="mr-1.5 h-4 w-4" />
                    Save
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Edit Circle name"
                    onClick={() => nameInputRef.current?.focus()}
                    className="h-11 w-11 shrink-0 rounded-xl"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <p className={cn(MUTED_TEXT, "mt-2")}>
                {circleNameDirty && trimmedCircleName.length < 2
                  ? "Use at least 2 characters."
                  : circleNameDirty
                    ? "Tap Save — everyone in this Circle will see the new name."
                    : "Everyone in this Circle sees this name."}
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
              className="mx-auto flex max-h-[88dvh] w-full max-w-2xl flex-col rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6"
            >
              <SheetHeader className="text-left">
                <SheetTitle>Add people to {circle.name}</SheetTitle>
                <SheetDescription>
                  Choose existing connections. They join only after accepting
                  the Circle invitation; no second Connect request is needed.
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
                              ? "You can invite 1 more person right now."
                              : `You can invite ${remainingCapacity} more people right now.`
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
                              ? "No invitation slots available"
                              : peopleSearch.trim()
                                ? "No matching connections"
                                : "No connections to add"
                          }
                          description={
                            remainingCapacity === 0
                              ? "The Circle is full or your pending-invitation limit is reached. Cancel a pending invitation or try again later."
                              : peopleSearch.trim()
                                ? "Try a different name."
                                : "Members and pending invitations are hidden. Add someone in Connect first if this list is empty."
                          }
                        />
                      )}

                      {pendingInvites.length ? (
                        <SettingsGroup
                          title="Pending invitations"
                          description="You can cancel an invitation before it is accepted."
                        >
                          {pendingInvites.map((invite) => (
                            <SettingsRow
                              key={invite.id}
                              icon={Send}
                              iconTone="blue"
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
                  className="h-12 w-full shrink-0 rounded-full text-base font-semibold"
                >
                  {selectedConnectionIds.size
                    ? `Invite ${selectedConnectionIds.size} ${
                        selectedConnectionIds.size === 1 ? "person" : "people"
                      }`
                    : "Select people"}
                </Button>
              </div>
            </SheetContent>
          </Sheet>

          <SettingsGroup
            title="Members"
            description="Members are connected through this Circle. Location and SMS sharing remain explicit."
            testId="one-location-circle-members"
          >
            {members.map((member) => (
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
              />
            ))}
          </SettingsGroup>

          <TrustNoteCard
            title="Connected does not mean visible"
            description="Circle membership is not live-view permission. Every location recipient still needs a separate encrypted, time-limited grant."
          />

          {isOwner ? (
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
