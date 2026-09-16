"use client";

/**
 * `/one/location?action=invite-circle&circle=<id>` — add people you are
 * connected with to one circle.
 *
 * Before anything is sent the screen states exactly who will receive the
 * invite and which circle it is for, both by the names the server returned.
 * Afterwards every row shows the state the service reports — pending,
 * accepted, declined, cancelled or expired — never a state inferred from what
 * was said. The voice path (`add_circle_member`) only refetches.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, UserRoundPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { INPUT_CLASSNAME } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  CARD_SURFACE,
  MUTED_TEXT,
  SUBCARD_SURFACE,
} from "@/lib/morphy-ux/tokens/surfaces";
import {
  AvatarBubble,
  EmptyState,
  StatusPill,
  TaskFlowHeader,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { circleInviteSelectionLimit } from "@/lib/one-location/circle-invite-contract";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationCircleEligibleConnection,
  OneLocationCircleMemberInvite,
  OneLocationCircleMemberInviteStatus,
  OneLocationCircleOverview,
} from "@/lib/one-location/types";
import {
  ONE_VOICE_REFRESH_EVENT,
  type OneVoiceRefreshDetail,
} from "@/lib/one-voice/directives";
import {
  NOT_SUCCESS_STATUSES,
  type ToolResultPublic,
} from "@/lib/one-voice/protocol";
import {
  useVoiceSessionSelector,
  useVoiceToolEffects,
} from "@/lib/one-voice/session-store";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const SCREEN_ID = "one_location_circle";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);

const INVITE_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
] as const;
type KnownInviteStatus = (typeof INVITE_STATUSES)[number];

const STATUS_LABEL: Record<KnownInviteStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
};

function inviteStatusTone(
  status: OneLocationCircleMemberInviteStatus,
): "ready" | "pending" | "neutral" {
  if (status === "accepted") return "ready";
  if (status === "pending") return "pending";
  return "neutral";
}

function inviteStatusLabel(
  status: OneLocationCircleMemberInviteStatus,
): string {
  return (STATUS_LABEL as Record<string, string>)[status] ?? status;
}

function isOkResult(result: ToolResultPublic | null | undefined): boolean {
  if (!result || typeof result.status !== "string") return false;
  return !NOT_SUCCESS_STATUSES.has(result.status);
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1)
    return (parts[0] ?? "").slice(0, 2).toUpperCase() || "?";
  return (
    `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase() ||
    "?"
  );
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export type InviteToCircleFlowProps = {
  circleId: string;
  /** `?person=<user_id>` preselects that connection when eligible. */
  userId?: string | null;
  /** Alias of `userId`. */
  personId?: string | null;
};

type LoadStatus = "idle" | "loading" | "ready" | "error";

type Outcome = {
  added: string[];
  invited: string[];
  skipped: Array<{ userId: string; reason: string }>;
};

export function InviteToCircleFlow({
  circleId,
  userId: preselectedUserIdProp = null,
  personId = null,
}: InviteToCircleFlowProps) {
  const preselectedUserId = personId ?? preselectedUserIdProp;
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [overview, setOverview] = useState<OneLocationCircleOverview | null>(
    null,
  );
  const [connections, setConnections] = useState<
    OneLocationCircleEligibleConnection[]
  >([]);
  const [invites, setInvites] = useState<OneLocationCircleMemberInvite[]>([]);
  const [remainingCapacity, setRemainingCapacity] = useState(0);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const mountedRef = useRef(true);
  const preselectAppliedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pendingVoiceInvite = useVoiceSessionSelector((state) =>
    state.pendingAction &&
    state.pendingAction.tool === "add_circle_member" &&
    state.pendingAction.resolvedStatus === null
      ? state.pendingAction
      : null,
  );

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "Invite to circle",
          purpose: "Add people you're connected with to this circle.",
          spokenSubject: overview
            ? `Location, invite to ${overview.name}`
            : "Location, Invite to circle",
          primaryEntity: overview?.name ?? null,
          actions: VOICE_ACTIONS,
          availableActions: VOICE_ACTIONS.map((action) => action.label),
        }
      : null,
  );

  const load = useCallback(async () => {
    if (!vaultOwnerToken || !circleId) return;
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const [nextOverview, page, ...byStatus] = await Promise.all([
        OneLocationService.getCircleOverview({ vaultOwnerToken, circleId }),
        OneLocationService.listNamedCircleEligibleConnectionsPage({
          vaultOwnerToken,
          circleId,
          page: 1,
          limit: 50,
        }),
        ...INVITE_STATUSES.filter((value) => value !== "pending").map((value) =>
          OneLocationService.listNamedCircleMemberInvites({
            vaultOwnerToken,
            direction: "outgoing",
            status: value,
          }).catch(() => [] as OneLocationCircleMemberInvite[]),
        ),
      ]);
      if (!mountedRef.current) return;
      const merged = new Map<string, OneLocationCircleMemberInvite>();
      for (const invite of [...page.pendingInvites, ...byStatus.flat()]) {
        if (invite.circleId === circleId) merged.set(invite.id, invite);
      }
      setOverview(nextOverview);
      setConnections(page.eligibleConnections);
      setRemainingCapacity(page.remainingCapacity);
      setInvites(Array.from(merged.values()));
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't load who you can invite.",
      );
      setStatus("error");
    }
  }, [circleId, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<OneVoiceRefreshDetail>).detail;
      const keys = detail?.uiRefresh ?? [];
      if (!keys.length || keys.includes("location_circles")) void load();
    };
    window.addEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
  }, [load]);

  useEffect(() => {
    if (
      preselectAppliedRef.current ||
      !preselectedUserId ||
      !connections.length
    )
      return;
    if (
      connections.some((connection) => connection.userId === preselectedUserId)
    ) {
      preselectAppliedRef.current = true;
      setSelected([preselectedUserId]);
    }
  }, [connections, preselectedUserId]);

  useVoiceToolEffects({
    onToolResult: (tool, result) => {
      if (!isOkResult(result)) return;
      if (
        tool === "add_circle_member" ||
        tool === "cancel_circle_invite" ||
        tool === "respond_circle_invite" ||
        tool === "list_circle_invites" ||
        (Array.isArray(result.ui_refresh) &&
          result.ui_refresh.includes("location_circles"))
      ) {
        void load();
      }
    },
    onPendingResolved: (_id, resolved, result) => {
      if (resolved !== "executed" || !isOkResult(result)) return;
      void load();
    },
  });

  const limit = circleInviteSelectionLimit(remainingCapacity);
  const selectedPeople = useMemo(
    () =>
      connections.filter((connection) => selected.includes(connection.userId)),
    [connections, selected],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return connections;
    return connections.filter((connection) =>
      connection.displayName.toLowerCase().includes(needle),
    );
  }, [connections, query]);

  const toggle = useCallback(
    (targetUserId: string) => {
      setSelected((current) => {
        if (current.includes(targetUserId)) {
          return current.filter((value) => value !== targetUserId);
        }
        if (current.length >= limit) {
          morphyToast.info(
            limit === 0
              ? "This circle is full."
              : `You can add up to ${limit} ${limit === 1 ? "person" : "people"} at once.`,
          );
          return current;
        }
        return [...current, targetUserId];
      });
    },
    [limit],
  );

  const send = useCallback(async () => {
    if (!vaultOwnerToken || !selectedPeople.length || sending) return;
    setSending(true);
    try {
      const result = await OneLocationService.addNamedCircleMembers({
        vaultOwnerToken,
        circleId,
        inviteeUserIds: selectedPeople.map((person) => person.userId),
      });
      if (!mountedRef.current) return;
      setOutcome({
        added: result.added,
        invited: result.invited,
        skipped: result.skipped.map((skippedId) => ({
          userId: skippedId,
          reason: result.skippedReasons[skippedId] ?? "Couldn't be added",
        })),
      });
      setSelected([]);
      if (result.added.length || result.invited.length) {
        const count = result.added.length + result.invited.length;
        morphyToast.success(
          result.invited.length
            ? `Invited ${count} ${count === 1 ? "person" : "people"}.`
            : `Added ${count} ${count === 1 ? "person" : "people"}.`,
        );
      } else {
        morphyToast.warning("Nobody was added.");
      }
      await load();
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "The invite didn't go through.",
      );
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }, [circleId, load, selectedPeople, sending, vaultOwnerToken]);

  const cancelInvite = useCallback(
    async (invite: OneLocationCircleMemberInvite) => {
      if (!vaultOwnerToken || cancellingId) return;
      setCancellingId(invite.id);
      try {
        await OneLocationService.cancelNamedCircleMemberInvite({
          vaultOwnerToken,
          inviteId: invite.id,
        });
        morphyToast.success("Invite cancelled.");
        await load();
      } catch (caught) {
        morphyToast.error(
          caught instanceof Error && caught.message
            ? caught.message
            : "Couldn't cancel that invite.",
        );
      } finally {
        if (mountedRef.current) setCancellingId(null);
      }
    },
    [cancellingId, load, vaultOwnerToken],
  );

  const nameFor = useCallback(
    (targetUserId: string): string =>
      connections.find((connection) => connection.userId === targetUserId)
        ?.displayName ??
      invites.find((invite) => invite.inviteeUserId === targetUserId)
        ?.inviteeDisplayName ??
      "Someone",
    [connections, invites],
  );

  const circleName = overview?.name ?? null;

  return (
    <section className="space-y-5" data-testid="one-location-invite-circle">
      <TaskFlowHeader
        eyebrow="Location"
        title="Invite to circle"
        description={
          circleName
            ? `People you pick join ${circleName}. Only connections can be added here.`
            : "Only people you're connected with can be added."
        }
      />

      {pendingVoiceInvite ? (
        <div
          className={cn(SUBCARD_SURFACE, "p-3.5")}
          role="status"
          data-testid="invite-voice-pending"
        >
          <p className="ui-text-row-label-emphasized">
            Confirm on the card to send
          </p>
          <p className={MUTED_TEXT}>{pendingVoiceInvite.summary}</p>
        </div>
      ) : null}

      {status === "loading" && !overview ? (
        <div className="flex items-center gap-2 py-6" role="status">
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span className={MUTED_TEXT}>Loading…</span>
        </div>
      ) : null}

      {status === "error" && !overview ? (
        <EmptyState
          title="Couldn't load this circle"
          description={error ?? "Try again in a moment."}
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {overview ? (
        <>
          <div className={cn(CARD_SURFACE, "space-y-3 p-4")}>
            <div className="flex items-center gap-2">
              <Search
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <label className="sr-only" htmlFor="invite-search">
                Search your connections
              </label>
              <input
                id="invite-search"
                className={cn(INPUT_CLASSNAME, "min-h-11 flex-1")}
                placeholder="Search connections"
                value={query}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {connections.length === 0 ? (
              <EmptyState
                icon={<UserRoundPlus className="h-6 w-6" aria-hidden />}
                title="No one to add"
                description="Everyone you're connected with is already in this circle, or has an invite waiting."
              />
            ) : filtered.length === 0 ? (
              <p className={MUTED_TEXT}>
                No connections match “{query.trim()}”.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="invite-candidates">
                {filtered.map((connection) => {
                  const checked = selected.includes(connection.userId);
                  const inputId = `invite-${connection.connectionId}`;
                  return (
                    <li key={connection.connectionId}>
                      <label
                        htmlFor={inputId}
                        className={cn(
                          "flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--app-card-radius-compact,16px)] px-2 py-2 transition-colors",
                          checked && "bg-[color:var(--app-accent-tint)]",
                        )}
                      >
                        <Checkbox
                          id={inputId}
                          checked={checked}
                          onCheckedChange={() => toggle(connection.userId)}
                          aria-label={`Add ${connection.displayName}`}
                        />
                        <AvatarBubble
                          initials={initialsFor(connection.displayName)}
                          imageUrl={connection.photoUrl}
                          size={32}
                        />
                        <span className="ui-text-row-label-emphasized min-w-0 flex-1 truncate">
                          {connection.displayName}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div
            className={cn(CARD_SURFACE, "space-y-3 p-4")}
            data-testid="invite-review"
          >
            <h2 className="ui-text-section-title">Review</h2>
            <dl className="space-y-2">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <dt className={cn(MUTED_TEXT, "w-20 shrink-0")}>Circle</dt>
                <dd
                  className="ui-text-row-label-emphasized"
                  data-testid="invite-review-circle"
                >
                  {circleName}
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <dt className={cn(MUTED_TEXT, "w-20 shrink-0")}>Sending to</dt>
                <dd
                  className="ui-text-row-label-emphasized"
                  data-testid="invite-review-recipients"
                >
                  {selectedPeople.length
                    ? joinNames(
                        selectedPeople.map((person) => person.displayName),
                      )
                    : "Nobody yet — pick people above"}
                </dd>
              </div>
            </dl>
            <Button
              disabled={!selectedPeople.length || sending}
              onClick={() => void send()}
              data-testid="invite-send"
            >
              {sending ? (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <UserRoundPlus className="h-4 w-4" aria-hidden />
              )}
              {selectedPeople.length > 1
                ? `Add ${selectedPeople.length} people`
                : "Add to circle"}
            </Button>
          </div>

          {outcome ? (
            <div
              className={cn(SUBCARD_SURFACE, "space-y-1 p-3.5")}
              role="status"
              data-testid="invite-outcome"
            >
              {outcome.added.map((addedId) => (
                <p key={`added-${addedId}`} className="ui-text-row-description">
                  {nameFor(addedId)} is in {circleName}.
                </p>
              ))}
              {outcome.invited.map((invitedId) => (
                <p
                  key={`invited-${invitedId}`}
                  className="ui-text-row-description"
                >
                  {nameFor(invitedId)} — invite pending.
                </p>
              ))}
              {outcome.skipped.map((entry) => (
                <p key={`skipped-${entry.userId}`} className={MUTED_TEXT}>
                  {nameFor(entry.userId)} — {entry.reason}
                </p>
              ))}
            </div>
          ) : null}

          {invites.length ? (
            <div
              className={cn(CARD_SURFACE, "space-y-3 p-4")}
              data-testid="invite-list"
            >
              <h2 className="ui-text-section-title">
                Invites for {circleName}
              </h2>
              <ul className="space-y-2">
                {invites.map((invite) => (
                  <li
                    key={invite.id}
                    className={cn(
                      SUBCARD_SURFACE,
                      "flex flex-wrap items-center gap-3 p-3",
                    )}
                    data-testid="invite-row"
                  >
                    <AvatarBubble
                      initials={initialsFor(invite.inviteeDisplayName ?? "?")}
                      imageUrl={invite.inviteePhotoUrl}
                      size={32}
                    />
                    <span className="ui-text-row-label-emphasized min-w-0 flex-1 truncate">
                      {invite.inviteeDisplayName ?? "Someone"}
                    </span>
                    <StatusPill tone={inviteStatusTone(invite.status)}>
                      {inviteStatusLabel(invite.status)}
                    </StatusPill>
                    {invite.status === "pending" &&
                    (overview.viewerCapabilities?.canModerateInvites ??
                      overview.role === "owner") ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cancellingId === invite.id}
                        onClick={() => void cancelInvite(invite)}
                      >
                        {cancellingId === invite.id ? "Cancelling…" : "Cancel"}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
