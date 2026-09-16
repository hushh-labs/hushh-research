"use client";

/**
 * `/one/location?view=links` — temporary public location links.
 *
 * A link is live for at most two hours and anyone holding it can open it. Every
 * row shows the state the server persisted (active, expired, revoked), and
 * Revoke ends a live one on the spot. The position a new link carries is
 * captured on this device and coarsened to the account's precision
 * preference before it is sent; the server only ever stores that snapshot.
 *
 * Voice reflects, never asserts: `create_public_link` and
 * `revoke_public_link` results refetch the list; the URL shown is the one the
 * server returned.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Link2, Loader2, Share2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { coarsenPoint } from "@/lib/location/coarsen";
import { useLocationSharingState } from "@/lib/location/sharing-state";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  CARD_SURFACE,
  MUTED_TEXT,
  SUBCARD_SURFACE,
} from "@/lib/morphy-ux/tokens/surfaces";
import {
  EmptyState,
  StatusPill,
  TaskFlowHeader,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import {
  describeShareRemaining,
  formatShareEndsAt,
  parseTimestamp,
} from "@/lib/one-location/share-countdown";
import type {
  OneLocationPublicInvite,
  OneLocationState,
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
import { isShareCancellationError, shareLink } from "@/lib/share/share-link";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/utils/clipboard";
import { useVault } from "@/lib/vault/vault-context";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const SCREEN_ID = "one_location_links";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);

/** Public links are capped at two hours; these are the only windows offered. */
export const PUBLIC_LINK_DURATIONS: ReadonlyArray<{
  hours: number;
  label: string;
}> = [
  { hours: 0.25, label: "15 min" },
  { hours: 1, label: "1 hour" },
  { hours: 2, label: "2 hours" },
];

const LINK_TOOLS = new Set([
  "list_links",
  "create_public_link",
  "revoke_public_link",
]);

export type PublicLinkStatus = "active" | "expired" | "revoked" | "unknown";

/**
 * The state a row shows. The server's status wins; a link it still calls
 * active whose window has already closed is shown as expired, because that is
 * what the server will say on the next read and what is true now.
 */
export function publicLinkStatus(
  invite: Pick<OneLocationPublicInvite, "status" | "expiresAt">,
  now: number = Date.now(),
): PublicLinkStatus {
  if (invite.status === "revoked") return "revoked";
  if (invite.status === "expired") return "expired";
  if (invite.status === "active") {
    const expires = parseTimestamp(invite.expiresAt ?? null);
    return expires !== null && expires <= now ? "expired" : "active";
  }
  return "unknown";
}

function statusLabel(status: PublicLinkStatus): string {
  switch (status) {
    case "active":
      return "Live";
    case "expired":
      return "Expired";
    case "revoked":
      return "Revoked";
    default:
      return "Unknown";
  }
}

function isOkResult(result: ToolResultPublic | null | undefined): boolean {
  if (!result || typeof result.status !== "string") return false;
  return !NOT_SUCCESS_STATUSES.has(result.status);
}

function touchesLinks(
  tool: string | null,
  result: ToolResultPublic | null,
): boolean {
  if (!isOkResult(result)) return false;
  if (
    Array.isArray(result?.ui_refresh) &&
    result.ui_refresh.includes("location_links")
  )
    return true;
  return tool !== null && LINK_TOOLS.has(tool);
}

function describeWindow(invite: OneLocationPublicInvite, now: number): string {
  const status = publicLinkStatus(invite, now);
  const expires = parseTimestamp(invite.expiresAt ?? null);
  if (status === "active" && expires !== null) {
    return `${describeShareRemaining(expires - now)} · ends ${formatShareEndsAt(expires)}`;
  }
  if (status === "revoked" && invite.revokedAt) {
    const revoked = parseTimestamp(invite.revokedAt);
    return revoked !== null
      ? `Revoked ${formatShareEndsAt(revoked)}`
      : "Revoked";
  }
  if (status === "expired" && expires !== null) {
    return `Ended ${formatShareEndsAt(expires)}`;
  }
  return "";
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

export function LocationLinks() {
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const sharing = useLocationSharingState();
  const [state, setState] = useState<OneLocationState | null>(() =>
    userId ? OneLocationStateResource.readPresentation(userId) : null,
  );
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [durationHours, setDurationHours] = useState<number>(1);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const pendingRevoke = useVoiceSessionSelector((session) =>
    session.pendingAction &&
    (session.pendingAction.tool === "revoke_public_link" ||
      session.pendingAction.tool === "create_public_link") &&
    session.pendingAction.resolvedStatus === null
      ? session.pendingAction
      : null,
  );

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "Links",
          purpose:
            "Temporary public links to your location, one hour at most, with revoke.",
          spokenSubject: "Location, Links",
          actions: VOICE_ACTIONS,
          availableActions: VOICE_ACTIONS.map((action) => action.label),
        }
      : null,
  );

  const load = useCallback(
    async (options?: { invalidate?: boolean }) => {
      if (!userId || !vaultOwnerToken) return;
      if (options?.invalidate) OneLocationStateResource.invalidate(userId);
      setStatus((current) => (current === "ready" ? "ready" : "loading"));
      try {
        const next = await OneLocationStateResource.load(userId, () =>
          OneLocationService.getState(vaultOwnerToken),
        );
        if (!mountedRef.current) return;
        setState(next);
        setError(null);
        setStatus("ready");
      } catch (caught) {
        if (!mountedRef.current) return;
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : "Couldn't load your links.",
        );
        setStatus("error");
      }
    },
    [userId, vaultOwnerToken],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<OneVoiceRefreshDetail>).detail;
      const keys = detail?.uiRefresh ?? [];
      if (!keys.length || keys.includes("location_links"))
        void load({ invalidate: true });
    };
    window.addEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
  }, [load]);

  useVoiceToolEffects({
    onToolResult: (tool, result) => {
      if (touchesLinks(tool, result)) void load({ invalidate: true });
    },
    onPendingResolved: (_id, resolved, result) => {
      if (resolved !== "executed") return;
      if (touchesLinks(null, result)) void load({ invalidate: true });
    },
  });

  const links = useMemo(() => {
    const rows = state?.publicInvites ?? [];
    return rows.slice().sort((a, b) => {
      const rank = (invite: OneLocationPublicInvite) =>
        publicLinkStatus(invite, now) === "active" ? 0 : 1;
      const byState = rank(a) - rank(b);
      if (byState !== 0) return byState;
      return (
        (parseTimestamp(b.createdAt ?? null) ?? 0) -
        (parseTimestamp(a.createdAt ?? null) ?? 0)
      );
    });
  }, [now, state?.publicInvites]);

  const liveLink = useMemo(
    () =>
      links.find((invite) => publicLinkStatus(invite, now) === "active") ??
      null,
    [links, now],
  );

  const createLink = useCallback(async () => {
    if (!vaultOwnerToken || !userId || creating) return;
    setCreating(true);
    try {
      const raw = await OneLocationService.captureCurrentPosition({
        fresh: true,
      });
      const snapshot = coarsenPoint(raw, sharing.precision);
      const created = await OneLocationService.createPublicInvite({
        vaultOwnerToken,
        durationHours,
        locationSnapshot: snapshot,
      });
      if (created.reused) {
        morphyToast.info(
          "Your existing link is still live. Its window restarted.",
        );
      } else {
        morphyToast.success("Link created.");
      }
      await load({ invalidate: true });
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't create a link.",
      );
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  }, [
    creating,
    durationHours,
    load,
    sharing.precision,
    userId,
    vaultOwnerToken,
  ]);

  const revoke = useCallback(
    async (invite: OneLocationPublicInvite) => {
      if (!vaultOwnerToken || revokingId) return;
      setRevokingId(invite.id);
      try {
        const revoked = await OneLocationService.revokePublicInvite({
          vaultOwnerToken,
          inviteId: invite.id,
        });
        if (mountedRef.current) {
          setState((current) =>
            current
              ? {
                  ...current,
                  publicInvites: current.publicInvites.map((row) =>
                    row.id === revoked.id ? { ...row, ...revoked } : row,
                  ),
                }
              : current,
          );
        }
        morphyToast.success("Link revoked. It no longer opens.");
        await load({ invalidate: true });
      } catch (caught) {
        morphyToast.error(
          caught instanceof Error && caught.message
            ? caught.message
            : "Couldn't revoke that link.",
        );
      } finally {
        if (mountedRef.current) setRevokingId(null);
      }
    },
    [load, revokingId, vaultOwnerToken],
  );

  const copy = useCallback(async (invite: OneLocationPublicInvite) => {
    const url = invite.publicUrl ? publicInviteUrlLabel(invite.publicUrl) : "";
    if (!url) {
      morphyToast.error("This link can't be copied. Create a new one.");
      return;
    }
    const copied = await copyToClipboard(url);
    if (copied) morphyToast.success("Link copied.");
    else morphyToast.error("Couldn't copy the link.");
  }, []);

  const share = useCallback(async (invite: OneLocationPublicInvite) => {
    const url = invite.publicUrl ? publicInviteUrlLabel(invite.publicUrl) : "";
    if (!url) {
      morphyToast.error("This link can't be shared. Create a new one.");
      return;
    }
    try {
      const delivery = await shareLink({
        title: "My live location",
        text: "Here's where I am right now.",
        dialogTitle: "Share your location link",
        url,
      });
      if (delivery === "copied") morphyToast.success("Link copied.");
    } catch (caught) {
      if (isShareCancellationError(caught)) return;
      morphyToast.error("Couldn't share the link.");
    }
  }, []);

  return (
    <section className="space-y-5" data-testid="one-location-links">
      <TaskFlowHeader
        eyebrow="Location"
        title="Links"
        description="A temporary link anyone can open. It stops working after at most two hours, or the moment you revoke it."
      />

      {pendingRevoke ? (
        <div
          className={cn(SUBCARD_SURFACE, "p-3.5")}
          role="status"
          data-testid="links-voice-pending"
        >
          <p className="ui-text-row-label-emphasized">
            Confirm on the card to continue
          </p>
          <p className={MUTED_TEXT}>{pendingRevoke.summary}</p>
        </div>
      ) : null}

      <div
        className={cn(CARD_SURFACE, "space-y-4 p-5")}
        data-testid="links-create"
      >
        <div>
          <h2 className="ui-text-section-title">New link</h2>
          <p className={MUTED_TEXT}>
            {sharing.precision === "approximate"
              ? "Shows your approximate area, matching your precision setting."
              : "Shows your position as captured on this device."}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="How long the link stays live"
          className="flex flex-wrap gap-2"
        >
          {PUBLIC_LINK_DURATIONS.map((option) => {
            const selected = option.hours === durationHours;
            return (
              <button
                key={option.hours}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDurationHours(option.hours)}
                className={cn(
                  "min-h-11 rounded-full border px-4 text-[15px] font-semibold leading-5 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]",
                  selected
                    ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]"
                    : "border-[color:var(--app-separator)] text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {sharing.sharingState === "off" ? (
          <p className={MUTED_TEXT}>
            Location sharing is off for your account. Turn it on in Settings
            before creating a link.
          </p>
        ) : null}
        <Button
          disabled={creating || !vaultOwnerToken}
          onClick={() => void createLink()}
          data-testid="links-create-button"
        >
          {creating ? (
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <Link2 className="h-4 w-4" aria-hidden />
          )}
          {liveLink ? "Restart my live link" : "Create link"}
        </Button>
      </div>

      {status === "loading" && !state ? (
        <div className="flex items-center gap-2 py-6" role="status">
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span className={MUTED_TEXT}>Loading your links…</span>
        </div>
      ) : null}

      {status === "error" && !state ? (
        <EmptyState
          title="Couldn't load your links"
          description={error ?? "Try again in a moment."}
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {state && !links.length ? (
        <EmptyState
          icon={<Link2 className="h-6 w-6" aria-hidden />}
          title="No links yet"
          description="Links you create show up here with their live, expired or revoked state."
        />
      ) : null}

      {links.length ? (
        <ul className="space-y-2" data-testid="links-list">
          {links.map((invite) => {
            const linkStatus = publicLinkStatus(invite, now);
            const live = linkStatus === "active";
            const url = invite.publicUrl
              ? publicInviteUrlLabel(invite.publicUrl)
              : null;
            return (
              <li
                key={invite.id}
                className={cn(SUBCARD_SURFACE, "space-y-3 p-4")}
                data-testid="link-row"
                data-link-status={linkStatus}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
                    <Link2 className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="ui-text-row-label-emphasized">
                        {invite.durationHours >= 1
                          ? `${invite.durationHours}-hour link`
                          : `${Math.round(invite.durationHours * 60)}-minute link`}
                      </p>
                      <StatusPill tone={live ? "live" : "neutral"}>
                        {statusLabel(linkStatus)}
                      </StatusPill>
                    </div>
                    <p className={MUTED_TEXT}>{describeWindow(invite, now)}</p>
                    {live && url ? (
                      <p className={cn(MUTED_TEXT, "break-all")}>{url}</p>
                    ) : null}
                  </div>
                </div>
                {live ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void share(invite)}>
                      <Share2 className="h-4 w-4" aria-hidden />
                      Share
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void copy(invite)}
                    >
                      <Copy className="h-4 w-4" aria-hidden />
                      Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[color:var(--app-destructive)]"
                      disabled={revokingId === invite.id}
                      onClick={() => void revoke(invite)}
                      data-testid="link-revoke"
                    >
                      {revokingId === invite.id ? "Revoking…" : "Revoke"}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
