"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Plus, ShieldCheck, UsersRound } from "@/components/icons";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SectionTitle, RowDescription } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import {
  CircleDetailFlow,
  CreateCircleFlow,
  JoinCircleFlow,
} from "@/components/one-location/redesign/circles/named-circle-flows";
import { SmsTextIcon } from "@/components/one-location/redesign/sms-text-icon";
import { createConnectCircleActions } from "@/components/connect/circles/connect-circle-actions";
import {
  CONNECT_CIRCLE_GRID_CLASSNAME,
  CONNECT_CIRCLE_TILE_CLASSNAME,
} from "@/components/connect/connect-living-layout";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { CIRCLE_JOIN_CODE_PARAM } from "@/lib/one-location/circle-join-url";
import {
  circleStateChangeClosesDetail,
  subscribeToOneLocationStateChanges,
} from "@/lib/one-location/one-location-state-events";
import { OneLocationService } from "@/lib/one-location/service";
import {
  CONNECT_CIRCLE_ACTION_PARAM,
  CONNECT_CIRCLE_ID_PARAM,
  CONNECT_SURFACE_PARAM,
  readConnectCircleAction,
  type ConnectCircleAction,
} from "@/lib/navigation/connect-routes";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";
import type { DirectoryPerson } from "@/lib/services/connections-service";
import { ROUTES } from "@/lib/navigation/routes";
import { VaultContext } from "@/lib/vault/vault-context";
import { trackEvent } from "@/lib/observability/client";
import {
  oneLocationCountBucket,
  trackOneLocationJourneyAction,
} from "@/lib/observability/location-events";

/**
 * Circles, on Connect.
 *
 * Issue #5458: a Circle is a grouping of people, and people are what Connect is
 * about. Living inside the Location Agent meant anything else that wanted a
 * group -- messaging, finance, a subagent -- had to reach into a Location
 * surface to get one.
 *
 * An earlier revision of this file moved only the LIST here and deep-linked
 * every control back into `/one/location`. That was wrong twice over.
 *
 * It did not satisfy the issue, whose first acceptance criterion is "migrate
 * Circles UI and ROUTE HIERARCHY under /one/connect" -- a link away is not a
 * migration. And it did not work: `/one/location` runs a first-run onboarding
 * takeover decided by `auth`, the vault, `mode`, `loadError` and one
 * localStorage key, with no query parameter anywhere in the decision. So
 * tapping "New circle" on Connect put a full-screen "Share your location
 * easily with anyone" screen in front of somebody who had asked to name a
 * group of friends -- and an account that skipped Location during setup never
 * gets that flag written, so it happened to them every time.
 *
 * The dependency that seemed to justify the deep link does not exist. Every
 * Circle call needs the vault owner token and nothing else -- no saved place,
 * no geolocation permission, no device record -- and Connect already holds
 * that token, because `/one/connect` sits behind the same app-wide vault gate
 * and is not in `AUTH_ONLY_ROUTE_PREFIXES`. The flows below are prop-driven
 * and import only presentational modules.
 *
 * So Connect hosts them. The component files stay where they are, because
 * `config/protected-behaviors.json` pins them by path; this imports them.
 *
 * WHAT STILL BELONGS TO LOCATION: what a Circle DOES, rather than what it IS.
 * Sending your live location to a member, and the SOS delivery that reads the
 * emergency roster. Those genuinely need Location set up, and asking for it
 * there is right -- it was only ever wrong in front of "name a group".
 */

/** How the two product-managed Circles explain themselves.
 *
 * A description, never a category. Each line answers the only question a
 * Circle the person did not create raises: why are these people in here, and
 * what does this one do.
 *
 * Typed as an exact record rather than `Record<string, …>` so a lookup is
 * total and the call sites need no fallback for a key that cannot exist.
 */
const SYSTEM_CIRCLE_COPY = {
  trusted: {
    title: "Trusted",
    description: "Everyone you're connected to",
  },
  sms: {
    title: "SMS Circle",
    description: "Gets your SMS",
  },
} as const satisfies Record<
  SystemCircleKind,
  { title: string; description: string }
>;

type SystemCircleKind = "trusted" | "sms";

/** The summary contains counts, not member identities; these dots represent seats. */
function CircleCluster({
  circle,
}: {
  circle: OneLocationCircleSummary;
}) {
  const kind = systemKindOf(circle);
  const visibleSeats = Math.min(Math.max(circle.memberCount, 0), 4);
  return (
    <span
      aria-hidden="true"
      data-testid="connect-circle-cluster"
      className="relative flex size-24 items-center justify-center rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-secondary-fill)] sm:size-28"
    >
      <span className="flex size-12 items-center justify-center rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] text-[color:var(--app-primary-label)]">
        {kind === "sms" ? (
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--app-destructive)] text-[color:var(--app-destructive-fg)]">
            <SmsTextIcon className="text-[8px]" />
          </span>
        ) : kind === "trusted" ? (
          <ShieldCheck className="size-5" />
        ) : (
          <UsersRound className="size-5" />
        )}
      </span>
      {Array.from({ length: visibleSeats }, (_, index) => (
        <span
          key={index}
          className="absolute size-3 rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-accent)]"
          style={{
            left: ["45%", "80%", "45%", "10%"][index],
            top: ["4%", "45%", "82%", "45%"][index],
          }}
        />
      ))}
    </span>
  );
}

function isSystemCircleKind(value: string | null): value is SystemCircleKind {
  return value === "trusted" || value === "sms";
}

function systemKindOf(circle: OneLocationCircleSummary): string | null {
  const kind = String(circle.systemKind || "").trim();
  if (kind) return kind;
  // A build talking to a server that predates `systemKind` still knows the SMS
  // Circle by its flag. Trusted has no fallback because it cannot exist there.
  return circle.isSystem ? "sms" : null;
}

/**
 * The second line.
 *
 * A member count, and for a product-managed Circle the rule that fills it.
 * Never the `kind` -- "Family" was removed from this row once already, because
 * the Circle onboarding creates is filed under Family by default and the
 * person was never asked, so the row opened by naming a category they had not
 * picked ahead of the only number on the line that was true.
 *
 * The count includes the owner, matching Circle Detail -- excluding them made
 * this row disagree with the screen one tap away over the same Circle.
 */
export function circleRowDescription(circle: OneLocationCircleSummary): string {
  const count = Math.max(0, Number(circle.memberCount || 0));
  const kind = systemKindOf(circle);
  const owns = circle.role === "owner";
  const people = count === 1 ? "1 person" : `${count} people`;

  // Trusted is owner-scoped by the server, so the only viewer who can reach
  // this line is its owner. Guarded anyway: "Everyone you're connected to" on
  // somebody else's roster would be a false statement about the reader.
  if (kind === "trusted" && owns) {
    return count <= 1
      ? SYSTEM_CIRCLE_COPY.trusted.description
      : `${SYSTEM_CIRCLE_COPY.trusted.description} · ${people}`;
  }
  if (kind === "sms") {
    // An SMS Circle appears in the list of everyone ON it, not only its
    // owner's. "Gets your SMS" is true for exactly one of those readers;
    // for the rest the line has to say what it means for THEM.
    const lead = owns
      ? SYSTEM_CIRCLE_COPY.sms.description
      : "You'll get their SMS";
    if (!owns) return lead;
    return count <= 1 ? `${lead} · no one yet` : `${lead} · ${people}`;
  }
  return count <= 1 ? "No members yet" : people;
}

/** Circles you own first, with product-managed circles pinned above named ones. */
export function orderCircles(circles: readonly OneLocationCircleSummary[]): {
  owned: OneLocationCircleSummary[];
  joined: OneLocationCircleSummary[];
} {
  const ownedSystem: OneLocationCircleSummary[] = [];
  const ownedNamed: OneLocationCircleSummary[] = [];
  const joined: OneLocationCircleSummary[] = [];
  for (const circle of circles) {
    if (circle.role !== "owner") {
      joined.push(circle);
      continue;
    }
    const kind = systemKindOf(circle);
    if (kind === "trusted" || kind === "sms") ownedSystem.push(circle);
    else ownedNamed.push(circle);
  }
  // Trusted above SMS: one describes who you know, the other what happens in an
  // emergency, and the first is the one a person opens this tab to see.
  ownedSystem.sort((left, right) => {
    const rank = (c: OneLocationCircleSummary) =>
      systemKindOf(c) === "trusted" ? 0 : 1;
    return rank(left) - rank(right);
  });
  return { owned: [...ownedSystem, ...ownedNamed], joined };
}

export function ConnectCirclesTab({
  onStateChange,
  currentUserId = null,
  onRequestConnection,
  onCancelConnectionRequest,
  refreshToken = 0,
}: {
  /** Lets the page keep its native beacon and voice metadata truthful without
   *  hoisting circle state into a 2,400-line component. */
  onStateChange?: (state: {
    loading: boolean;
    error: string | null;
    count: number;
  }) => void;
  currentUserId?: string | null;
  /**
   * Opens the SAME capability review the Connect directory opens.
   *
   * A roster row used to call `ConnectionsService.sendRequest` outright, so
   * the one place in the app where a connection request is sent without the
   * person seeing what it grants was a Circle member list.
   * `config/protected-behaviors.json` names that review
   * (`connect-request-asks-before-it-shares`), and the directory shows it even
   * when the catalog is empty because "a request that grants nothing is worth
   * saying out loud". The roster now goes through the same door.
   */
  onRequestConnection?: (person: DirectoryPerson) => void | Promise<void>;
  /** Takes back a request that has not been answered. The directory offers
   *  this on exactly the same row state; the roster used to show the fact and
   *  no way to act on it. */
  onCancelConnectionRequest?: (person: DirectoryPerson) => Promise<void>;
  /** Bumped by the page when something outside this tab changed a Circle or a
   *  relationship -- a sent request, an accepted invite -- so the list and the
   *  open roster re-read instead of waiting for a manual refresh. */
  refreshToken?: number;
}) {
  // The context directly, not `useVault()`. That hook throws outside a
  // provider, and this tab must degrade to "circles are unavailable" rather
  // than taking the Connect page down with it -- Connect has never touched the
  // vault, and its tests do not mock one.
  const router = useRouter();
  const searchParams = useSearchParams();
  const vault = useContext(VaultContext);
  const vaultOwnerToken = vault?.vaultOwnerToken ?? null;

  const [circles, setCircles] = useState<OneLocationCircleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [detailReloadToken, setDetailReloadToken] = useState(0);
  /** Which vault session has already had its Trusted Circle reconciled. */
  const reconciledForTokenRef = useRef<string | null>(null);

  const action = readConnectCircleAction(
    searchParams.get(CONNECT_CIRCLE_ACTION_PARAM),
  );
  const circleIdParam = String(
    searchParams.get(CONNECT_CIRCLE_ID_PARAM) || "",
  ).trim();
  const joinCode =
    String(searchParams.get(CIRCLE_JOIN_CODE_PARAM) || "").trim() || undefined;
  const trackedSurfaceRef = useRef<string | null>(null);

  useEffect(() => {
    const signature = `${action ?? "list"}:${circleIdParam ? "detail" : "none"}:${joinCode ? "code" : "none"}`;
    if (trackedSurfaceRef.current === signature) return;
    trackedSurfaceRef.current = signature;
    const analyticsAction =
      action === "create-circle"
        ? "circle_create_started"
        : action === "join-circle"
          ? "circle_join_started"
          : action === "circle-detail"
            ? "circle_opened"
            : "circle_tab_opened";
    trackOneLocationJourneyAction({
      action: analyticsAction,
      routeId: "connect",
      entrySurface: "connect_circles",
      targetType: "circle",
    });
  }, [action, circleIdParam, joinCode]);

  useEffect(() => {
    if (!vaultOwnerToken) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Only blank the list when there is nothing painted yet. A refresh of a
    // list already on screen is not a loading state, and reporting one made
    // the native beacon claim the surface was still fetching.
    if (circles.length === 0) setLoading(true);
    setError(null);
    // Reconcile, then read.
    //
    // The accept hook writes both sides of a NEW connection, so a pair that
    // connects from here on needs nothing else. It cannot account for the
    // connections a person already had -- without this, somebody with forty of
    // them opens this tab to no Trusted Circle at all, and after their next
    // accept to one holding a single name under the words "Everyone you're
    // connected to", which is worse than not showing it.
    //
    // A reconcile that fails must not cost the list: the Circles they already
    // have are still worth showing, and the next open tries again.
    // Reconciled once per unlocked session, not once per bump.
    //
    // This is a write that opens a transaction over the caller's whole
    // accepted-connection graph, and it sits on a 6-per-minute limiter. Ten
    // things bump the token -- a create, a join, a rename, an add, a remove, a
    // sent request, a cancel, an inbound notification -- so a busy minute
    // spent the budget on re-deriving a roster that had not changed. The list
    // still re-reads every time; only the reconcile is held.
    const alreadyReconciled = reconciledForTokenRef.current === vaultOwnerToken;
    const reconcile = alreadyReconciled
      ? Promise.resolve()
      : OneLocationService.ensureTrustedSystemCircle({
          vaultOwnerToken,
          summaryOnly: true,
        }).then(() => {
          reconciledForTokenRef.current = vaultOwnerToken;
        });
    void reconcile
      .catch(() => undefined)
      .then(() => OneLocationService.listCircles(vaultOwnerToken))
      .then((next) => {
        if (cancelled) return;
        setCircles(next);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Circles are unavailable right now.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultOwnerToken, reloadToken, refreshToken]);

  useEffect(() => {
    onStateChange?.({ loading, error, count: circles.length });
  }, [circles.length, error, loading, onStateChange]);

  const { owned, joined } = useMemo(() => orderCircles(circles), [circles]);
  const showingStarter =
    vaultOwnerToken !== null &&
    !loading &&
    !error &&
    joined.length === 0 &&
    owned.every(
      (circle) => systemKindOf(circle) !== null && circle.memberCount <= 1,
    );

  const actions = useMemo(
    () =>
      vaultOwnerToken ? createConnectCircleActions({ vaultOwnerToken }) : null,
    [vaultOwnerToken],
  );

  /**
   * Every navigation on this tab stays on Connect.
   *
   * `?tab=circles` is written out even when it is already there, because the
   * App Router refuses a navigation whose only change is that the whole query
   * string disappears -- measured on UAT and recorded in
   * `lib/navigation/top-shell-breadcrumbs.ts`. Without it, closing a Circle
   * would be a dead press.
   */
  const go = useCallback(
    (
      next: {
        action?: ConnectCircleAction | null;
        circleId?: string | null;
        code?: string | null;
      },
      mode: "push" | "replace" = "push",
    ) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(CONNECT_SURFACE_PARAM, "circles");
      for (const [key, value] of [
        [CONNECT_CIRCLE_ACTION_PARAM, next.action],
        [CONNECT_CIRCLE_ID_PARAM, next.circleId],
        [CIRCLE_JOIN_CODE_PARAM, next.code],
      ] as const) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const href = `${ROUTES.CONNECT}?${params.toString()}`;
      if (mode === "replace") router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [router, searchParams],
  );

  /** Publish a successful local mutation through the same account-scoped
   *  channel remote notifications use. That updates this tab and every other
   *  Connect/Location tab without persisting roster data in browser storage. */
  const announceCircleMutation = useCallback(
    (notificationType: string, circleId?: string, memberUserId?: string) => {
      if (!currentUserId) {
        // Story/tests may render this leaf without an authenticated host. Keep
        // its local behavior useful without broadcasting an unscoped event.
        setReloadToken((token) => token + 1);
        setDetailReloadToken((token) => token + 1);
        return;
      }
      CacheSyncService.onOneLocationStateMutated(
        currentUserId,
        ["workspace", "circles", "sms_roster"],
        { notificationType, circleId, memberUserId },
      );
    },
    [currentUserId],
  );

  /**
   * Circle news from this tab, another tab, or the notification provider.
   *
   * `CircleDetailFlow` consumes the same token and re-reads its roster and an
   * open Add people sheet in place. A remote deletion is terminal, so leave
   * the now-invalid detail route instead of turning a valid server outcome
   * into a permanent-looking load error.
   */
  useEffect(() => {
    if (!currentUserId) return;
    return subscribeToOneLocationStateChanges((detail) => {
      if (
        detail.userId !== currentUserId ||
        !detail.domains.includes("circles")
      ) {
        return;
      }
      if (circleStateChangeClosesDetail(detail, currentUserId, circleIdParam)) {
        go({ action: null, circleId: null, code: null }, "replace");
      } else {
        setDetailReloadToken((token) => token + 1);
      }
      setReloadToken((token) => token + 1);
    });
  }, [circleIdParam, currentUserId, go]);

  const closeFlow = useCallback((refreshList = true) => {
    // `replace`, not push. This runs after leaving and after deleting, so the
    // entry it closes may name a Circle that no longer exists -- and pushing
    // left it a back destination that re-mounted into "Could not open this
    // Circle" with a Retry that can never succeed. The Location hub replaces
    // for exactly this reason.
    go({ action: null, circleId: null, code: null }, "replace");
    // The list behind the flow is stale the moment anything was created,
    // renamed, joined or left. Re-read rather than patch: a roster kept in two
    // places is the thing this move exists to end.
    if (refreshList) setReloadToken((token) => token + 1);
  }, [go]);

  const openCircle = useCallback(
    (circleId: string) => go({ action: "circle-detail", circleId }),
    [go],
  );

  /**
   * The one handoff to Location that is still correct.
   *
   * Sending your live location is a Location capability and genuinely needs
   * Location set up. Asking for it here is right; asking for it in front of
   * "name a group of friends" was not. The member row already hides this
   * unless that person is location-ready, so it is never offered into a dead
   * end.
   */
  const shareWithMember = useCallback(
    (circleId: string) => {
      router.push(
        `${ROUTES.ONE_LOCATION}?action=circle-detail&circleId=${encodeURIComponent(circleId)}&view=people`,
      );
    },
    [router],
  );

  const withBusy = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      setBusy(true);
      try {
        return await run();
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (vaultOwnerToken && actions && action === "create-circle") {
    return (
      <CreateCircleFlow
        busy={busy}
        onSubmit={async (name, kind) => {
          const circle = await withBusy(() => actions.createCircle(name, kind));
          trackEvent("one_location_circle_created", {
            route_id: "connect",
            result: "success",
            circle_kind: kind,
          });
          // `replace`, so back from the new Circle returns to the list rather
          // than to the form that just succeeded.
          go({ action: "circle-detail", circleId: circle.id }, "replace");
          announceCircleMutation("location_circle_created", circle.id);
        }}
      />
    );
  }

  if (vaultOwnerToken && actions && action === "join-circle") {
    return (
      <JoinCircleFlow
        busy={busy}
        initialCode={joinCode}
        // Wrapped, like `onJoin` on the next line. Handed raw, the Preview
        // button never disabled or spun for the whole round trip, so a person
        // tapped it again -- and resolve shares the 10-per-minute bucket with
        // joining, so enough taps locked them out of the thing they came for.
        onResolve={(code) => withBusy(() => actions.resolveCode(code))}
        onJoin={async (code) => {
          const circle = await withBusy(() => actions.joinCircle(code));
          trackOneLocationJourneyAction({
            action: "circle_joined",
            routeId: "connect",
            entrySurface: "connect_circles",
            targetType: "circle",
          });
          go({ action: "circle-detail", circleId: circle.id }, "replace");
          announceCircleMutation("location_circle_code_joined", circle.id);
        }}
      />
    );
  }

  if (
    vaultOwnerToken &&
    actions &&
    action === "circle-detail" &&
    circleIdParam
  ) {
    return (
      <CircleDetailFlow
        // A signal, not a `key`. Remounting would re-read the roster but also
        // close an open add-people sheet, clear a half-typed search and drop
        // the selection -- and a notification can arrive at any moment.
        reloadSignal={detailReloadToken + refreshToken}
        circleId={circleIdParam}
        currentUserId={currentUserId}
        busy={busy}
        onBack={closeFlow}
        onLoad={actions.loadCircle}
        onLoadOverview={actions.loadCircleOverview}
        onLoadMembersPage={actions.loadCircleMembersPage}
        onRename={async (circleId, name) => {
          const renamed = await withBusy(() =>
            actions.renameCircle(circleId, name),
          );
          announceCircleMutation("location_circle_renamed", circleId);
          return renamed;
        }}
        onGenerateCode={(circleId, rotate) =>
          withBusy(() => actions.generateCode(circleId, rotate))
        }
        onCopyCode={actions.copyCode}
        onShareCode={async (circle, code) => {
          await actions.shareCode(circle, code);
          trackOneLocationJourneyAction({
            action: "circle_code_shared",
            routeId: "connect",
            entrySurface: "connect_circles",
            targetType: "circle",
          });
        }}
        onShareWithMember={(circleId) => shareWithMember(circleId)}
        onRemoveMember={async (circleId, userId) => {
          await withBusy(() => actions.removeMember(circleId, userId));
          trackOneLocationJourneyAction({
            action: "circle_member_removed",
            routeId: "connect",
            entrySurface: "connect_circles",
            targetType: "circle",
            countBucket: "1",
          });
          announceCircleMutation(
            "location_circle_member_removed",
            circleId,
            userId,
          );
        }}
        onConnectMember={async (_circleId, userId, person) => {
          if (!onRequestConnection) {
            // Never fall back to sending outright. A request that skips the
            // review is the one thing this row must not do.
            toast.error("Open Connections to send a connection request.");
            return;
          }
          await onRequestConnection({
            userId,
            displayName: person?.displayName ?? null,
            photoUrl: person?.photoUrl ?? null,
            email: null,
            relationship: "none",
          });
        }}
        onCancelMemberRequest={
          onCancelConnectionRequest
            ? async (_circleId, userId) => {
                await onCancelConnectionRequest({
                  userId,
                  displayName: null,
                  photoUrl: null,
                  email: null,
                  relationship: "pending_outgoing",
                });
              }
            : undefined
        }
        onLoadEligibleConnections={actions.loadEligibleConnections}
        onLoadEligibleConnectionsPage={actions.loadEligibleConnectionsPage}
        onInviteConnections={async (circleId, userIds) => {
          await withBusy(() => actions.inviteConnections(circleId, userIds));
          trackOneLocationJourneyAction({
            action: "circle_member_invited",
            routeId: "connect",
            entrySurface: "connect_circles",
            targetType: "circle",
            countBucket: oneLocationCountBucket(userIds.length),
          });
          // The roster on screen is stale the moment somebody is added. It
          // used to stay stale until the person navigated away and back.
          announceCircleMutation("location_circle_member_added", circleId);
        }}
        onCancelMemberInvite={async (inviteId) => {
          await actions.cancelMemberInvite(inviteId);
          trackOneLocationJourneyAction({
            action: "circle_invite_cancelled",
            routeId: "connect",
            entrySurface: "connect_circles",
            targetType: "circle",
          });
          announceCircleMutation(
            "location_circle_member_invite_cancelled",
            circleIdParam,
          );
        }}
        onLeave={async (circleId) => {
          await withBusy(() => actions.leaveCircle(circleId));
          trackOneLocationJourneyAction({
            action: "circle_left",
            routeId: "connect",
            entrySurface: "connect_circles",
            targetType: "circle",
          });
          announceCircleMutation(
            "location_circle_member_left",
            circleId,
            currentUserId || undefined,
          );
          closeFlow(false);
        }}
        onDelete={async (circleId) => {
          await withBusy(() => actions.deleteCircle(circleId));
          trackOneLocationJourneyAction({
            action: "circle_deleted",
            routeId: "connect",
            entrySurface: "connect_circles",
            targetType: "circle",
          });
          announceCircleMutation("location_circle_deleted", circleId);
          closeFlow(false);
        }}
      />
    );
  }

  const renderCircleRow = (circle: OneLocationCircleSummary) => {
    const kind = systemKindOf(circle);
    const testId = kind
      ? `connect-circle-${kind}`
      : circle.role === "owner"
        ? "connect-circle-owned"
        : "connect-circle-joined";
    const title =
      isSystemCircleKind(kind) &&
      circle.role === "owner" &&
      circle.name === SYSTEM_CIRCLE_COPY[kind].title
        ? SYSTEM_CIRCLE_COPY[kind].title
        : circle.name;

    return (
      <button
        key={circle.id}
        type="button"
        className={CONNECT_CIRCLE_TILE_CLASSNAME}
        onClick={() => openCircle(circle.id)}
        data-testid={testId}
        aria-label={`Open ${title} circle, ${circleRowDescription(circle)}`}
      >
        <CircleCluster circle={circle} />
        <span className="ui-text-card-title max-w-full [overflow-wrap:anywhere] text-[color:var(--app-primary-label)]">
          {title}
        </span>
        <span className="ui-text-row-description max-w-full text-[color:var(--app-secondary-label)]">
          {circleRowDescription(circle)}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-4 sm:space-y-5" data-testid="connect-circles-tab">
      {vaultOwnerToken === null ? (
        <SettingsGroup title="Your circles">
          {/* Whose screen this actually is.
           *
           * A LOCKED vault never reaches here -- the guard shows its unlock
           * dialog first. The one audience for a null token is somebody who
           * has no vault yet, i.e. somebody still in setup, and telling them
           * to unlock something they do not have was both false and a dead
           * end: the row was disabled and the create/join group was withheld
           * on the same condition. So it names the real next step and goes
           * there. */}
          <SettingsRow
            title="Finish setting up One"
            description="Circles need your vault, which is created during setup."
            density="compact"
            chevron
            onClick={() => router.push(ROUTES.ONE_SETUP)}
            testId="connect-circle-setup"
          />
        </SettingsGroup>
      ) : error ? (
        <SettingsGroup title="Your circles">
          {/* Retryable. Nothing else on this branch can bump the token: the
           * flows that do are unreachable from an error state, and an inbound
           * notification is not something the reader can trigger. */}
          <SettingsRow
            title="Circles are unavailable"
            description={`${error} Tap to try again.`}
            density="compact"
            tone="destructive"
            onClick={() => setReloadToken((token) => token + 1)}
            testId="connect-circle-retry"
          />
        </SettingsGroup>
      ) : loading ? (
        <SettingsGroup title="Your circles">
          <SettingsRow title="Loading circles…" density="compact" disabled />
        </SettingsGroup>
      ) : (
        <>
          {showingStarter ? (
            <section
              data-testid="connect-circle-starter"
              className="rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-5 py-7 text-center sm:px-8"
            >
              <span aria-hidden="true" className="relative mx-auto flex size-28 items-center justify-center rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-secondary-fill)]">
                <span className="flex size-14 items-center justify-center rounded-full bg-[color:var(--app-card-surface-default-solid)] text-[color:var(--app-accent)]">
                  <UsersRound className="size-7" />
                </span>
                <span className="absolute -left-1 top-5 size-5 rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-accent)]" />
                <span className="absolute -right-1 top-5 size-5 rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-accent)]" />
                <span className="absolute bottom-0 left-1/2 size-5 -translate-x-1/2 rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-accent)]" />
              </span>
              <h2 className="ui-text-major-section-title mt-5 text-[color:var(--app-primary-label)]">
                A circle starts with your people
              </h2>
              <p className="ui-text-page-subtitle mx-auto mt-1 max-w-md text-[color:var(--app-secondary-label)]">
                Make a space for family, friends, or any group you choose. Invite people when you're ready.
              </p>
              <div className="mt-5 flex flex-col justify-center gap-2.5 min-[440px]:flex-row">
                <Button type="button" variant="blue" effect="fill" size="standard" showRipple={false} onClick={() => go({ action: "create-circle" })} data-testid="connect-circle-create">
                  <Plus aria-hidden="true" className="mr-1.5 size-4" />
                  New circle
                </Button>
                <Button type="button" variant="none" effect="fade" size="standard" showRipple={false} onClick={() => router.push(`${ROUTES.CONNECT}?tab=all`, { scroll: false })}>
                  Find people
                </Button>
              </div>
              <Button type="button" variant="none" effect="fade" size="compact" showRipple={false} className="mt-2" onClick={() => go({ action: "join-circle" })} data-testid="connect-circle-join">
                Have a code? Join a circle
              </Button>
            </section>
          ) : null}
          {owned.length ? (
            <section data-testid="connect-circle-group-owned" className="space-y-3">
              <div className="space-y-1">
                <SectionTitle as="h2">Your circles</SectionTitle>
                <RowDescription>
                  Bring people together for the things you share.
                </RowDescription>
              </div>
              <div className={CONNECT_CIRCLE_GRID_CLASSNAME}>
                {owned.map(renderCircleRow)}
              </div>
            </section>
          ) : null}
          {joined.length ? (
            <section data-testid="connect-circle-group-joined" className="space-y-3">
              <SectionTitle as="h2">Joined circles</SectionTitle>
              <div className={CONNECT_CIRCLE_GRID_CLASSNAME}>
                {joined.map(renderCircleRow)}
              </div>
            </section>
          ) : null}
        </>
      )}

      {/* Its own group, below the list, so it does not move as the list grows
          -- and 56px rows rather than the 16px header links Location uses,
          which shift with the heading when it wraps. */}
      {vaultOwnerToken && !loading && !showingStarter ? (
        <SettingsGroup separatorInset>
          <SettingsRow
            icon={Plus}
            iconTone="indigo"
            title="New circle"
            description="Create a group for your connections."
            density="compact"
            textOverflow="truncate"
            chevron
            onClick={() => go({ action: "create-circle" })}
            testId="connect-circle-create"
          />
          <SettingsRow
            icon={KeyRound}
            iconTone="gray"
            title="Join with code"
            description="Enter a shared 12-character code."
            density="compact"
            textOverflow="truncate"
            chevron
            onClick={() => go({ action: "join-circle" })}
            testId="connect-circle-join"
          />
        </SettingsGroup>
      ) : null}
    </div>
  );
}
