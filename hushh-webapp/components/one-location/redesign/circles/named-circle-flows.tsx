"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  RotateCw,
  Share2,
  ShieldCheck,
  Trash2,
  UserMinus,
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
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  EmptyState,
  TaskFlowHeader,
  TrustNoteCard,
} from "@/components/one-location/redesign/primitives";
import type {
  OneLocationCircleDetail,
  OneLocationCircleInviteCode,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
  OneLocationCircleMember,
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

function circleFlowErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export function CirclesSection({
  circles,
  onCreate,
  onJoin,
  onOpen,
}: {
  circles: OneLocationCircleSummary[];
  onCreate: () => void;
  onJoin: () => void;
  onOpen: (circleId: string) => void;
}) {
  return (
    <div className="space-y-3" data-testid="one-location-named-circles">
      <div className="flex items-center justify-between gap-3 px-1">
        <div>
          <p className="text-[12px] font-bold uppercase tracking-[0.4px] text-black/40 dark:text-muted-foreground">
            Your circles
          </p>
          <p className="mt-0.5 text-[13px] text-black/50 dark:text-muted-foreground">
            Family and friends you choose to group together.
          </p>
        </div>
      </div>

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
              description={`${circleKindLabel(circle.kind)} · ${circle.memberCount} ${
                circle.memberCount === 1 ? "member" : "members"
              }`}
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
          className="h-11 rounded-full font-semibold"
        >
          <Plus className="mr-2 h-4 w-4" />
          Create
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onJoin}
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
        description="Give this group a name. Joining never starts location sharing automatically."
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
        title="Private by default"
        description="Membership only makes people eligible to share. Every live-location share still needs an explicit duration and confirmation."
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
}: {
  busy: boolean;
  onResolve: (code: string) => Promise<OneLocationCircleInvitePreview>;
  onJoin: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState("");
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
            Joining adds you to this Circle. It does not share your current or
            live location.
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
        description="A valid code joins the Circle immediately, while location access remains explicit and revocable."
      />
    </div>
  );
}

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
        <p className="truncate text-[13px] text-muted-foreground">
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
              size="icon"
              variant="ghost"
              disabled={busy}
              aria-label={`Remove ${member.displayName}`}
              className="h-11 w-11 rounded-full text-destructive"
            >
              <UserMinus className="h-4 w-4" />
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
  onGenerateCode: (circleId: string) => Promise<OneLocationCircleInviteCode>;
  onCopyCode: (code: string) => Promise<void>;
  onShareCode: (
    circle: OneLocationCircleDetail,
    code: string,
  ) => Promise<void>;
  onShareWithMember: (circleId: string, userId: string) => void;
  onRemoveMember: (circleId: string, userId: string) => Promise<void>;
  onLeave: (circleId: string) => Promise<void>;
  onDelete: (circleId: string) => Promise<void>;
}) {
  const [loadedCircle, setCircle] =
    useState<OneLocationCircleDetail | null>(null);
  const [inviteCode, setInviteCode] =
    useState<OneLocationCircleInviteCode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [circleName, setCircleName] = useState("");
  const loadRequestRef = useRef(0);

  const reload = async () => {
    const requestId = ++loadRequestRef.current;
    setLoadError(null);
    if (!circleId) {
      setCircle(null);
      setLoadError("This Circle link is incomplete.");
      return;
    }
    try {
      const nextCircle = await onLoad(circleId);
      if (requestId !== loadRequestRef.current) return;
      setCircle(nextCircle);
      setCircleName(nextCircle.name);
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      setLoadError(
        error instanceof Error ? error.message : "Could not load this Circle.",
      );
    }
  };

  useEffect(() => {
    setCircle(null);
    setInviteCode(null);
    void reload();
    // `onLoad` is a stable page callback. Reload only when the selected id
    // changes; unrelated page refreshes must not refetch the focused detail.
    return () => {
      loadRequestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circleId]);

  const circle =
    loadedCircle?.id === circleId ? loadedCircle : null;
  const isOwner = circle?.role === "owner";
  const members = useMemo(() => circle?.members ?? [], [circle?.members]);

  const generateCode = async () => {
    if (!circle) return;
    try {
      setInviteCode(await onGenerateCode(circle.id));
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not create an invite code."),
      );
    }
  };

  const renameCircle = async () => {
    if (!circle || circleName.trim().length < 2) return;
    try {
      const updated = await onRename(circle.id, circleName.trim());
      setCircle(updated);
      setCircleName(updated.name);
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not rename this Circle."),
      );
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
            ? `${circleKindLabel(circle.kind)} · ${circle.memberCount} members`
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
            <div className="space-y-4 rounded-[22px] border border-border bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-sm">
              <label className="block space-y-2">
                <span className="text-sm font-semibold text-foreground">
                  Circle name
                </span>
                <span className="flex gap-2">
                  <input
                    value={circleName}
                    onChange={(event) => setCircleName(event.target.value)}
                    maxLength={80}
                    autoComplete="off"
                    className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-base outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={
                      busy ||
                      circleName.trim().length < 2 ||
                      circleName.trim() === circle.name
                    }
                    aria-label="Save Circle name"
                    onClick={() => void renameCircle()}
                    className="h-11 w-11 shrink-0 rounded-xl"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </span>
              </label>

              <div className="border-t border-border/70 pt-4">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
                  <KeyRound className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground">
                    Invite people
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Codes expire after 72 hours. Rotating immediately disables
                    the previous code.
                  </p>
                </div>
              </div>
              {inviteCode ? (
                <div className="mt-4 rounded-2xl bg-muted/55 p-4 text-center">
                  <p className="font-mono text-xl font-bold tracking-[0.12em] text-foreground">
                    {inviteCode.code}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
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
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  isLoading={busy}
                  onClick={() => void generateCode()}
                  className="mt-4 h-11 w-full rounded-full font-semibold"
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  Generate invite code
                </Button>
              )}
              {inviteCode ? (
                <Button
                  type="button"
                  variant="ghost"
                  isLoading={busy}
                  onClick={() => void generateCode()}
                  className="mt-2 h-11 w-full rounded-full"
                >
                  <RotateCw className="mr-2 h-4 w-4" />
                  Rotate code
                </Button>
              ) : null}
              </div>
            </div>
          ) : null}

          <SettingsGroup
            title="Members"
            description="Membership never shares location automatically."
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
            title="Explicit sharing only"
            description="Circle membership is not a live-view permission. Every recipient still gets a separate encrypted, time-limited grant."
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
