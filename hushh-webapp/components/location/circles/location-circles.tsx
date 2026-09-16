"use client";

/**
 * `/one/location?view=circles` — the circles the signed-in person belongs to.
 *
 * Every row is a name the server sent (never an id in text; ids live only in
 * hrefs and React keys). Voice never writes UI state here: a `tool.result`
 * whose `ui_refresh` names `location_circles`, or a circle read, refetches
 * the list, and `create_circle` with status `created` navigates to the new
 * circle's detail. Nothing on this screen is derived from transcript text.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  KeyRound,
  Loader2,
  Plus,
  UsersRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { hrefForLocationAction } from "@/lib/location/screen-ids";
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
import { circleMemberCountLabel } from "@/lib/one-location/circle-member-count";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationCircleMemberInvite,
  OneLocationCircleSummary,
} from "@/lib/one-location/types";
import {
  ONE_VOICE_REFRESH_EVENT,
  type OneVoiceRefreshDetail,
} from "@/lib/one-voice/directives";
import {
  NOT_SUCCESS_STATUSES,
  type ToolResultPublic,
} from "@/lib/one-voice/protocol";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const SCREEN_ID = "one_location_circles";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);

/** Tools whose successful result means the roster of circles may have changed. */
const CIRCLE_TOOLS = new Set([
  "list_circles",
  "create_circle",
  "rename_circle",
  "delete_circle",
  "add_circle_member",
  "remove_circle_member",
  "leave_circle",
  "list_circle_invites",
  "respond_circle_invite",
  "cancel_circle_invite",
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

function touchesCircles(
  tool: string | null,
  result: ToolResultPublic | null,
): boolean {
  if (!isOkResult(result)) return false;
  if (refreshKeys(result).includes("location_circles")) return true;
  return tool !== null && CIRCLE_TOOLS.has(tool);
}

/** The circle id a `create_circle` result names, or null. Never a spoken name. */
function createdCircleId(result: ToolResultPublic | null): string | null {
  if (!result || result.status !== "created") return null;
  const circle = result.circle;
  if (!circle || typeof circle !== "object") return null;
  const id = (circle as { circle_id?: unknown }).circle_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function circleKindLabel(
  kind: OneLocationCircleSummary["kind"],
): string {
  switch (kind) {
    case "family":
      return "Family";
    case "friends":
      return "Friends";
    default:
      return "Circle";
  }
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

export type LocationCirclesProps = {
  /** `?circle=<id>` focus from `open_screen`; the matching row is highlighted. */
  circleId?: string | null;
};

type LoadStatus = "idle" | "loading" | "ready" | "error";

export function LocationCircles({ circleId = null }: LocationCirclesProps) {
  const router = useRouter();
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [circles, setCircles] = useState<OneLocationCircleSummary[]>([]);
  const [invites, setInvites] = useState<OneLocationCircleMemberInvite[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [respondingInviteId, setRespondingInviteId] = useState<string | null>(
    null,
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "Circles",
          purpose: "The circles you belong to, and the people in each one.",
          spokenSubject: "Location, Circles",
          actions: VOICE_ACTIONS,
          availableActions: VOICE_ACTIONS.map((action) => action.label),
        }
      : null,
  );

  const load = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const [nextCircles, nextInvites] = await Promise.all([
        OneLocationService.listCircles(vaultOwnerToken),
        OneLocationService.listNamedCircleMemberInvites({
          vaultOwnerToken,
          direction: "incoming",
          status: "pending",
        }).catch(() => [] as OneLocationCircleMemberInvite[]),
      ]);
      if (!mountedRef.current) return;
      setCircles(nextCircles);
      setInvites(nextInvites);
      setError(null);
      setStatus("ready");
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't load your circles.",
      );
      setStatus("error");
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  // A `refresh` directive the provider ran on the app's behalf.
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<OneVoiceRefreshDetail>).detail;
      const keys = detail?.uiRefresh ?? [];
      if (!keys.length || keys.includes("location_circles")) void load();
    };
    window.addEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
  }, [load]);

  // The relay mirrors a confirmed action as BOTH `pending_action.resolved`
  // and `tool.result`; navigate once per created id, not once per frame.
  const openedRef = useRef<string | null>(null);
  const reconcile = useCallback(
    (tool: string | null, result: ToolResultPublic | null) => {
      const created =
        tool === "create_circle" || tool === null
          ? createdCircleId(result)
          : null;
      if (created) {
        if (openedRef.current === created) return;
        openedRef.current = created;
        router.push(
          hrefForLocationAction("circle-detail", { circleId: created }),
        );
        return;
      }
      if (touchesCircles(tool, result)) void load();
    },
    [load, router],
  );

  useVoiceToolEffects({
    onToolResult: (tool, result) => reconcile(tool, result),
    onPendingResolved: (_id, resolved, result) => {
      if (resolved !== "executed") return;
      reconcile(null, result);
    },
  });

  const respondToInvite = useCallback(
    async (invite: OneLocationCircleMemberInvite, accept: boolean) => {
      if (!vaultOwnerToken || respondingInviteId) return;
      setRespondingInviteId(invite.id);
      try {
        if (accept) {
          await OneLocationService.acceptNamedCircleMemberInvite({
            vaultOwnerToken,
            inviteId: invite.id,
          });
          morphyToast.success(`You joined ${invite.circleName}.`);
        } else {
          await OneLocationService.declineNamedCircleMemberInvite({
            vaultOwnerToken,
            inviteId: invite.id,
          });
          morphyToast.success("Invitation declined.");
        }
        await load();
      } catch (caught) {
        morphyToast.error(
          caught instanceof Error && caught.message
            ? caught.message
            : "That didn't go through.",
        );
      } finally {
        if (mountedRef.current) setRespondingInviteId(null);
      }
    },
    [load, respondingInviteId, vaultOwnerToken],
  );

  const sorted = useMemo(
    () =>
      circles.slice().sort((a, b) => {
        if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [circles],
  );

  return (
    <section className="space-y-5" data-testid="one-location-circles">
      <TaskFlowHeader
        eyebrow="Location"
        title="Circles"
        description="Groups of people you can share with together."
      />

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href={hrefForLocationAction("create-circle")}>
            <Plus className="h-4 w-4" aria-hidden />
            New circle
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={hrefForLocationAction("join-circle")}>
            <KeyRound className="h-4 w-4" aria-hidden />
            Join with code
          </Link>
        </Button>
      </div>

      {invites.length ? (
        <div
          className={cn(CARD_SURFACE, "space-y-3 p-4")}
          data-testid="circle-invites"
        >
          <p className="ui-text-section-title">Invitations</p>
          <ul className="space-y-2">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className={cn(
                  SUBCARD_SURFACE,
                  "flex flex-wrap items-center gap-3 p-3",
                )}
              >
                <AvatarBubble
                  initials={initialsFor(invite.inviterDisplayName)}
                  imageUrl={invite.inviterPhotoUrl}
                />
                <div className="min-w-0 flex-1">
                  <p className="ui-text-row-label-emphasized">
                    {invite.circleName}
                  </p>
                  <p className={MUTED_TEXT}>
                    {invite.inviterDisplayName} invited you
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={respondingInviteId === invite.id}
                    onClick={() => void respondToInvite(invite, false)}
                  >
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    disabled={respondingInviteId === invite.id}
                    onClick={() => void respondToInvite(invite, true)}
                  >
                    Accept
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status === "loading" && !sorted.length ? (
        <div className="flex items-center gap-2 py-6" role="status">
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span className={MUTED_TEXT}>Loading your circles…</span>
        </div>
      ) : null}

      {status === "error" && !sorted.length ? (
        <EmptyState
          title="Couldn't load your circles"
          description={error ?? "Try again in a moment."}
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {status === "ready" && !sorted.length ? (
        <EmptyState
          icon={<UsersRound className="h-6 w-6" aria-hidden />}
          title="No circles yet"
          description="Create one for your family or friends, or join one with a code."
        />
      ) : null}

      {sorted.length ? (
        <ul className="space-y-2" data-testid="circle-list">
          {sorted.map((circle) => {
            const focused = circleId != null && circle.id === circleId;
            return (
              <li key={circle.id}>
                <Link
                  href={hrefForLocationAction("circle-detail", {
                    circleId: circle.id,
                  })}
                  data-testid="circle-row"
                  aria-current={focused ? "true" : undefined}
                  className={cn(
                    SUBCARD_SURFACE,
                    "flex min-h-11 w-full items-center gap-3 p-3.5 text-left transition-colors",
                    "hover:border-[color:var(--app-accent-ring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]",
                    focused && "ring-2 ring-[color:var(--app-accent)]",
                  )}
                >
                  <AvatarBubble initials={initialsFor(circle.name)} />
                  <span className="min-w-0 flex-1">
                    <span className="ui-text-row-label-emphasized block truncate">
                      {circle.name}
                    </span>
                    <span className={cn(MUTED_TEXT, "block")}>
                      {circleKindLabel(circle.kind)} ·{" "}
                      {circleMemberCountLabel(circle.memberCount)}
                    </span>
                  </span>
                  {circle.role === "owner" ? (
                    <StatusPill tone="neutral" className="shrink-0">
                      Yours
                    </StatusPill>
                  ) : null}
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
