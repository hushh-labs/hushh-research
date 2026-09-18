"use client";

/**
 * `/one/location?action=circle-detail&circle=<id>` — one circle: its name,
 * kind, the people in it (names only), and the owner's tools.
 *
 * Voice reflects, never asserts: `rename_circle`, `add_circle_member`,
 * `remove_circle_member` and a resolved `delete_circle` / `leave_circle`
 * refetch or leave the screen only from a `tool.result` / `pending_action.
 * resolved executed` frame. A join link shown here is the URL the server
 * returned from `create_circle_invite_link`, never one assembled from speech.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Link2,
  Loader2,
  LogOut,
  Pencil,
  Share2,
  Trash2,
  UserRoundPlus,
  UsersRound,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { INPUT_CLASSNAME } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  hrefForLocationAction,
  hrefForLocationView,
} from "@/lib/location/screen-ids";
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
import {
  buildCircleJoinUrl,
  resolveCircleJoinOrigin,
} from "@/lib/one-location/circle-join-url";
import { circleOthersLabel } from "@/lib/one-location/circle-member-count";
import { OneLocationService } from "@/lib/one-location/service";
import {
  buildCircleInviteShareText,
  circleShareLabel,
  isShareCancellationError,
  shareNamedCircleCode,
} from "@/lib/one-location/share-circle-code";
import type {
  OneLocationCircleMember,
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

import { circleKindLabel } from "./location-circles";

const SCREEN_ID = "one_location_circle";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);
const MEMBERS_PAGE_SIZE = 50;
const CIRCLE_NAME_MAX = 80;

/** Voice tools whose confirmation card, while it is up, blocks this screen's own action. */
const PENDING_TOOLS = new Set([
  "delete_circle",
  "leave_circle",
  "remove_circle_member",
  "rename_circle",
  "set_circle_kind",
  "add_circle_member",
]);

function isOkResult(result: ToolResultPublic | null | undefined): boolean {
  if (!result || typeof result.status !== "string") return false;
  return !NOT_SUCCESS_STATUSES.has(result.status);
}

function refreshKeys(result: ToolResultPublic | null | undefined): string[] {
  return Array.isArray(result?.ui_refresh)
    ? result.ui_refresh.filter((key): key is string => typeof key === "string")
    : [];
}

function resultCircleId(result: ToolResultPublic | null): string | null {
  if (!result) return null;
  const direct = result.circle_id;
  if (typeof direct === "string" && direct) return direct;
  const nested = result.circle;
  if (nested && typeof nested === "object") {
    const id = (nested as { circle_id?: unknown }).circle_id;
    if (typeof id === "string" && id) return id;
  }
  return null;
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

type JoinLink = { url: string; expiresAt: string | null };

export type CircleDetailProps = {
  circleId: string;
};

type LoadStatus = "idle" | "loading" | "ready" | "error";

export function CircleDetail({ circleId }: CircleDetailProps) {
  const router = useRouter();
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [overview, setOverview] = useState<OneLocationCircleOverview | null>(
    null,
  );
  const [members, setMembers] = useState<OneLocationCircleMember[]>([]);
  const [membersHasMore, setMembersHasMore] = useState(false);
  const [membersPage, setMembersPage] = useState(1);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "rename" | "link" | "remove" | "leave" | "delete" | "more" | null
  >(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [joinLink, setJoinLink] = useState<JoinLink | null>(null);
  const [removeTarget, setRemoveTarget] =
    useState<OneLocationCircleMember | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pendingVoiceAction = useVoiceSessionSelector((state) =>
    state.pendingAction &&
    state.pendingAction.resolvedStatus === null &&
    PENDING_TOOLS.has(state.pendingAction.tool)
      ? state.pendingAction
      : null,
  );

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "Circle",
          purpose: "One circle: who is in it and what you can do with it.",
          spokenSubject: overview
            ? `Location, ${overview.name}`
            : "Location, Circle",
          primaryEntity: overview?.name ?? null,
          actions: VOICE_ACTIONS,
          availableActions: VOICE_ACTIONS.map((action) => action.label),
          // The one id this surface publishes: lets One resolve "this circle"
          // through the authorized service. Never in screenState.
          activeCircleId: circleId,
        }
      : null,
  );

  const load = useCallback(async () => {
    if (!vaultOwnerToken || !circleId) return;
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const [nextOverview, page] = await Promise.all([
        OneLocationService.getCircleOverview({ vaultOwnerToken, circleId }),
        OneLocationService.listCircleMembersPage({
          vaultOwnerToken,
          circleId,
          page: 1,
          limit: MEMBERS_PAGE_SIZE,
        }),
      ]);
      if (!mountedRef.current) return;
      setOverview(nextOverview);
      setMembers(page.items);
      setMembersHasMore(page.hasMore);
      setMembersPage(page.page);
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't load this circle.",
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

  const leaveScreen = useCallback(() => {
    router.replace(hrefForLocationView("circles"));
  }, [router]);

  const reconcile = useCallback(
    (tool: string | null, result: ToolResultPublic | null) => {
      if (!isOkResult(result) || !result) return;
      const target = resultCircleId(result);
      const aboutThisCircle = target === null || target === circleId;
      if (
        aboutThisCircle &&
        (result.status === "deleted" || result.status === "left")
      ) {
        leaveScreen();
        return;
      }
      if (
        aboutThisCircle &&
        result.status === "link_ready" &&
        typeof result.url === "string" &&
        result.url
      ) {
        setJoinLink({
          url: result.url,
          expiresAt:
            typeof result.expires_at === "string" ? result.expires_at : null,
        });
      }
      const keys = refreshKeys(result);
      if (
        keys.includes("location_circles") ||
        tool === "list_circles" ||
        result.status === "renamed" ||
        result.status === "added" ||
        result.status === "removed" ||
        result.status === "invite_pending"
      ) {
        void load();
      }
    },
    [circleId, leaveScreen, load],
  );

  useVoiceToolEffects({
    onToolResult: (tool, result) => reconcile(tool, result),
    onPendingResolved: (_id, resolved, result) => {
      if (resolved !== "executed") return;
      reconcile(null, result);
    },
  });

  const capabilities = overview?.viewerCapabilities;
  const isOwner = overview?.role === "owner";
  const canManage = Boolean(capabilities?.canManageCircle ?? isOwner);
  const canInvite = Boolean(capabilities?.canInviteMembers ?? isOwner);
  const canViewCode = Boolean(capabilities?.canViewInviteCode ?? isOwner);
  const canDelete = Boolean(
    (capabilities?.canDeleteCircle ?? isOwner) && !overview?.isSystem,
  );
  const canLeave = Boolean(
    capabilities?.canLeaveCircle ?? (overview ? !isOwner : false),
  );

  const startRename = useCallback(() => {
    if (!overview) return;
    setDraftName(overview.name);
    setRenaming(true);
  }, [overview]);

  const submitRename = useCallback(async () => {
    if (!vaultOwnerToken || !overview) return;
    const name = draftName.trim().slice(0, CIRCLE_NAME_MAX);
    if (!name || name === overview.name) {
      setRenaming(false);
      return;
    }
    setBusy("rename");
    try {
      const updated = await OneLocationService.updateNamedCircle({
        vaultOwnerToken,
        circleId,
        name,
      });
      if (!mountedRef.current) return;
      setOverview((current) =>
        current ? { ...current, name: updated.name } : current,
      );
      setRenaming(false);
      morphyToast.success(`Renamed to ${updated.name}.`);
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't rename.",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [circleId, draftName, overview, vaultOwnerToken]);

  const shareJoinLink = useCallback(async () => {
    if (!vaultOwnerToken || !overview) return;
    setBusy("link");
    try {
      const code =
        overview.activeInviteCode && !overview.inviteCodeNeedsOwnerRotation
          ? overview.activeInviteCode
          : await OneLocationService.createNamedCircleInviteCode({
              vaultOwnerToken,
              circleId,
              rotate: Boolean(overview.inviteCodeNeedsOwnerRotation),
            });
      const origin = resolveCircleJoinOrigin();
      const url = origin ? buildCircleJoinUrl(origin, code.code) : null;
      if (mountedRef.current) {
        setJoinLink(url ? { url, expiresAt: code.expiresAt } : null);
        setOverview((current) =>
          current
            ? {
                ...current,
                activeInviteCode: code,
                inviteCodeNeedsOwnerRotation: false,
              }
            : current,
        );
      }
      const label = circleShareLabel(overview.name);
      const delivery = await shareNamedCircleCode({
        title: `Join my ${label}`,
        text: buildCircleInviteShareText({
          circleLabel: label,
          code: code.code,
          hasJoinLink: Boolean(url),
        }),
        dialogTitle: "Share circle invite",
        ...(url ? { url } : {}),
      });
      if (delivery === "copied") morphyToast.success("Invite copied.");
    } catch (caught) {
      if (isShareCancellationError(caught)) return;
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't share the invite.",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [circleId, overview, vaultOwnerToken]);

  const removeMember = useCallback(async () => {
    const target = removeTarget;
    if (!vaultOwnerToken || !target) return;
    setBusy("remove");
    try {
      await OneLocationService.removeNamedCircleMember({
        vaultOwnerToken,
        circleId,
        memberUserId: target.userId,
      });
      morphyToast.success(`Removed ${target.displayName}.`);
      setRemoveTarget(null);
      await load();
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't remove them.",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [circleId, load, removeTarget, vaultOwnerToken]);

  const leaveCircle = useCallback(async () => {
    if (!vaultOwnerToken || !overview) return;
    setBusy("leave");
    try {
      await OneLocationService.leaveNamedCircle({ vaultOwnerToken, circleId });
      morphyToast.success(`You left ${overview.name}.`);
      leaveScreen();
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't leave.",
      );
      if (mountedRef.current) setBusy(null);
    }
  }, [circleId, leaveScreen, overview, vaultOwnerToken]);

  const deleteCircle = useCallback(async () => {
    if (!vaultOwnerToken || !overview) return;
    setBusy("delete");
    try {
      await OneLocationService.deleteNamedCircle({ vaultOwnerToken, circleId });
      morphyToast.success(`Deleted ${overview.name}.`);
      leaveScreen();
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't delete.",
      );
      if (mountedRef.current) setBusy(null);
    }
  }, [circleId, leaveScreen, overview, vaultOwnerToken]);

  const loadMoreMembers = useCallback(async () => {
    if (!vaultOwnerToken || busy) return;
    setBusy("more");
    try {
      const page = await OneLocationService.listCircleMembersPage({
        vaultOwnerToken,
        circleId,
        page: membersPage + 1,
        limit: MEMBERS_PAGE_SIZE,
      });
      if (!mountedRef.current) return;
      setMembers((current) => {
        const seen = new Set(current.map((member) => member.userId));
        return [
          ...current,
          ...page.items.filter((member) => !seen.has(member.userId)),
        ];
      });
      setMembersHasMore(page.hasMore);
      setMembersPage(page.page);
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't load more people.",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [busy, circleId, membersPage, vaultOwnerToken]);

  const sortedMembers = useMemo(
    () =>
      members.slice().sort((a, b) => {
        if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
        if (a.userId === userId) return -1;
        if (b.userId === userId) return 1;
        return a.displayName.localeCompare(b.displayName);
      }),
    [members, userId],
  );

  return (
    <section className="space-y-5" data-testid="one-location-circle-detail">
      <TaskFlowHeader
        eyebrow="Location"
        title="Circle"
        description={
          overview
            ? `${circleKindLabel(overview.kind)} · ${circleOthersLabel(overview.memberCount)}`
            : undefined
        }
      />

      {pendingVoiceAction ? (
        <div
          className={cn(SUBCARD_SURFACE, "p-3.5")}
          role="status"
          data-testid="circle-voice-pending"
        >
          <p className="ui-text-row-label-emphasized">
            Confirm on the card to continue
          </p>
          <p className={MUTED_TEXT}>{pendingVoiceAction.summary}</p>
        </div>
      ) : null}

      {status === "loading" && !overview ? (
        <div className="flex items-center gap-2 py-6" role="status">
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span className={MUTED_TEXT}>Loading this circle…</span>
        </div>
      ) : null}

      {status === "error" && !overview ? (
        <EmptyState
          title="Couldn't load this circle"
          description={
            error ?? "It may have been deleted, or you may have left it."
          }
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Try again
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href={hrefForLocationView("circles")}>All circles</Link>
              </Button>
            </div>
          }
        />
      ) : null}

      {overview ? (
        <>
          <div className={cn(CARD_SURFACE, "space-y-4 p-5")}>
            <div className="flex items-start gap-3">
              <AvatarBubble initials={initialsFor(overview.name)} size={44} />
              <div className="min-w-0 flex-1">
                {renaming ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitRename();
                    }}
                  >
                    <label className="sr-only" htmlFor="circle-rename-input">
                      Circle name
                    </label>
                    <input
                      id="circle-rename-input"
                      className={cn(INPUT_CLASSNAME, "min-h-11 flex-1")}
                      value={draftName}
                      maxLength={CIRCLE_NAME_MAX}
                      autoFocus
                      onChange={(event) => setDraftName(event.target.value)}
                    />
                    <Button
                      type="submit"
                      size="icon-lg"
                      aria-label="Save name"
                      disabled={busy === "rename" || !draftName.trim()}
                    >
                      {busy === "rename" ? (
                        <Loader2
                          className="h-4 w-4 animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
                      ) : (
                        <Check className="h-4 w-4" aria-hidden />
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="icon-lg"
                      variant="outline"
                      aria-label="Cancel rename"
                      onClick={() => setRenaming(false)}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2
                      className="ui-text-section-title truncate"
                      data-testid="circle-name"
                    >
                      {overview.name}
                    </h2>
                    {canManage ? (
                      <Button
                        size="icon-lg"
                        variant="ghost"
                        aria-label="Rename circle"
                        onClick={startRename}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                )}
                <p className={MUTED_TEXT}>
                  {isOwner
                    ? "You own this circle."
                    : "You're a member of this circle."}
                </p>
              </div>
            </div>

            {canInvite || canViewCode ? (
              <div className="flex flex-wrap gap-2">
                {canInvite ? (
                  <Button asChild size="sm">
                    <Link
                      href={hrefForLocationAction("invite-circle", {
                        circleId,
                      })}
                    >
                      <UserRoundPlus className="h-4 w-4" aria-hidden />
                      Invite people
                    </Link>
                  </Button>
                ) : null}
                {canViewCode && !overview.isSystem ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === "link"}
                    onClick={() => void shareJoinLink()}
                  >
                    {busy === "link" ? (
                      <Loader2
                        className="h-4 w-4 animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                    ) : (
                      <Share2 className="h-4 w-4" aria-hidden />
                    )}
                    Share join link
                  </Button>
                ) : null}
              </div>
            ) : null}

            {joinLink ? (
              <div
                className={cn(SUBCARD_SURFACE, "flex items-start gap-3 p-3.5")}
                data-testid="circle-join-link"
              >
                <Link2
                  className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--app-accent)]"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="ui-text-row-label-emphasized">
                    Join link ready
                  </p>
                  <p className={cn(MUTED_TEXT, "break-all")}>{joinLink.url}</p>
                  {joinLink.expiresAt ? (
                    <p className={MUTED_TEXT}>
                      Anyone with it can join until{" "}
                      {new Date(joinLink.expiresAt).toLocaleString()}.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className={cn(CARD_SURFACE, "space-y-3 p-4")}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="ui-text-section-title">People</h2>
              <StatusPill tone="neutral">
                {circleOthersLabel(overview.memberCount)}
              </StatusPill>
            </div>
            {sortedMembers.length ? (
              <ul className="space-y-2" data-testid="circle-members">
                {sortedMembers.map((member) => {
                  const self = member.userId === userId;
                  const ready =
                    member.secureLocationReady ||
                    member.canReceiveLocation === true;
                  return (
                    <li
                      key={member.userId}
                      className={cn(
                        SUBCARD_SURFACE,
                        "flex items-center gap-3 p-3",
                      )}
                      data-testid="circle-member"
                    >
                      <AvatarBubble
                        initials={initialsFor(member.displayName)}
                        imageUrl={member.photoUrl}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="ui-text-row-label-emphasized truncate">
                          {member.displayName}
                          {self ? " (you)" : ""}
                        </p>
                        <p className={MUTED_TEXT}>
                          {member.role === "owner" ? "Owner" : "Member"}
                          {!self
                            ? ready
                              ? " · Can receive location"
                              : " · Location setup needed"
                            : ""}
                        </p>
                      </div>
                      {canManage && !self && member.role !== "owner" ? (
                        <Button
                          size="icon-lg"
                          variant="ghost"
                          aria-label={`Remove ${member.displayName}`}
                          className="text-[color:var(--app-destructive)]"
                          onClick={() => setRemoveTarget(member)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                icon={<UsersRound className="h-6 w-6" aria-hidden />}
                title="Just you so far"
                description="Invite people you're connected with, or share the join link."
              />
            )}
            {membersHasMore ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy === "more"}
                onClick={() => void loadMoreMembers()}
              >
                {busy === "more" ? "Loading…" : "Show more"}
              </Button>
            ) : null}
          </div>

          {canLeave || canDelete ? (
            <div className="flex flex-wrap gap-2">
              {canLeave ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setConfirmLeave(true)}
                >
                  <LogOut className="h-4 w-4" aria-hidden />
                  Leave circle
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-[color:var(--app-destructive)]"
                  disabled={busy !== null}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Delete circle
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removeTarget?.displayName ?? "this person"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They leave this circle. Any location you share with them directly
              is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "remove"}>
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy === "remove"}
              onClick={(event) => {
                event.preventDefault();
                void removeMember();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Leave {overview?.name ?? "this circle"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You stop being a member. You can rejoin later with a new invite.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "leave"}>
              Stay
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy === "leave"}
              onClick={(event) => {
                event.preventDefault();
                void leaveCircle();
              }}
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {overview?.name ?? "this circle"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Everyone is removed and the circle is gone. Direct shares with
              these people continue until they end.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete"}>
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy === "delete"}
              onClick={(event) => {
                event.preventDefault();
                void deleteCircle();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
