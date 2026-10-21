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
import { TaskDialogContent, taskSurfaceStyles } from "@/lib/morphy-ux/ui/task-surfaces";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KeyRound, Search, Trash2 } from "@/components/icons";
import { customCircleTypeGroups } from "@/lib/one-location/circle-types";
import { Input } from "@/components/ui/input";
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
import { ConnectCircleHeading, ConnectCircleRow } from "./connect-circle-row";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import styles from "../connect-workspace.module.css";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import {
  CircleDetailFlow,
  CreateCircleFlow,
  JoinCircleFlow,
} from "@/components/one-location/redesign/circles/named-circle-flows";
import { createConnectCircleActions } from "@/components/connect/circles/connect-circle-actions";
import { CircleChat } from "@/components/connect/circles/circle-chat";
import type { ConnectCirclesSnapshot } from "@/components/connect/circle-discovery";
import { CONNECT_CIRCLE_GRID_CLASSNAME } from "@/components/connect/connect-living-layout";
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
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";
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
    description: "People you add yourself",
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
 * A member count, and for the SMS Circle the delivery rule it carries.
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

  // Trusted is provisioned for its owner. Its members are manually curated,
  // so the description is no longer inferred from the connection graph.
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
  onSearchActiveChange,
  currentUserId = null,
  isActive = true,
  onRequestConnection,
  onCancelConnectionRequest,
  refreshToken = 0,
  createDialogOpen = false,
  onCreateDialogOpenChange,
}: {
  onSearchActiveChange?: (active: boolean) => void;
  /** Lets the page keep its native beacon and voice metadata truthful without
   *  hoisting circle state into a 2,400-line component. */
  onStateChange?: (state: ConnectCirclesSnapshot) => void;
  currentUserId?: string | null;
  /** The swipe pane stays mounted when Connections is selected. */
  isActive?: boolean;
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
  createDialogOpen?: boolean;
  onCreateDialogOpenChange?: (open: boolean) => void;
}) {
  // The context directly, not `useVault()`. That hook throws outside a
  // provider, and this tab must degrade to "circles are unavailable" rather
  // than taking the Connect page down with it -- Connect has never touched the
  // vault, and its tests do not mock one.
  const router = useRouter();
  const searchParams = useSearchParams();
  const vault = useContext(VaultContext);
  const vaultOwnerToken = vault?.vaultOwnerToken ?? null;

  const [loaded, setLoaded] = useState<{
    token: string | null;
    ownerId: string | null;
    circles: OneLocationCircleSummary[];
    customTypePolicy?: { version: number; maxTypes: number };
  }>({ token: null, ownerId: null, circles: [] });
  const loadedForSession =
    loaded.token === vaultOwnerToken && loaded.ownerId === currentUserId;
  // Relayed summaries must never cross an unlock/account change, even for one render.
  const circles = useMemo(
    () => (vaultOwnerToken && loadedForSession ? loaded.circles : []),
    [loaded.circles, loadedForSession, vaultOwnerToken],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [detailReloadToken, setDetailReloadToken] = useState(0);
  /** Which vault session has already provisioned its empty Trusted Circle. */
  const provisionedForTokenRef = useRef<string | null>(null);

  const action = readConnectCircleAction(
    searchParams.get(CONNECT_CIRCLE_ACTION_PARAM),
  );
  const circleIdParam = String(
    searchParams.get(CONNECT_CIRCLE_ID_PARAM) || "",
  ).trim();
  const chatSession = useMemo(
    () =>
      currentUserId && vaultOwnerToken && vault?.vaultKey && circleIdParam
        ? {
            userId: currentUserId,
            circleId: circleIdParam,
            vaultOwnerToken,
            vaultKey: vault.vaultKey,
          }
        : null,
    [currentUserId, vaultOwnerToken, vault?.vaultKey, circleIdParam],
  );
  const consumeChatIntent = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("circleChat");
    router.replace(`${ROUTES.CONNECT}?${next.toString()}`, { scroll: false });
  }, [router, searchParams]);
  const finishMemberSetup = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("circleSetup");
    router.replace(`${ROUTES.CONNECT}?${next.toString()}`, { scroll: false });
  }, [router, searchParams]);
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
      setLoaded({ token: null, ownerId: null, circles: [] });
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Only blank the list when there is nothing painted yet. A refresh of a
    // list already on screen is not a loading state, and reporting one made
    // the native beacon claim the surface was still fetching.
    if (circles.length === 0) setLoading(true);
    setError(null);
    // Provision the empty Trusted container once per unlocked session, then
    // read normally. This does not look at Connections or change membership;
    // the manual picker is the only way a person enters Trusted.
    const alreadyProvisioned =
      provisionedForTokenRef.current === vaultOwnerToken ||
      shouldSkipReviewerBackgroundWritesForAutomation();
    const provision = alreadyProvisioned
      ? Promise.resolve()
      : OneLocationService.ensureTrustedSystemCircle({
          vaultOwnerToken,
          summaryOnly: true,
        }).then(() => {
          provisionedForTokenRef.current = vaultOwnerToken;
        });
    void provision
      .catch(() => undefined)
      .then(() => OneLocationService.listCircleWorkspace(vaultOwnerToken))
      .then((workspace) => {
        if (cancelled) return;
        setLoaded({
          token: vaultOwnerToken,
          ownerId: currentUserId,
          circles: workspace.circles,
          customTypePolicy: workspace.customTypePolicy,
        });
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Never relabel a previous session's retained list as this session's data.
        setLoaded({
          token: vaultOwnerToken,
          ownerId: currentUserId,
          circles: [],
        });
        setError("Circles are unavailable right now.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultOwnerToken, currentUserId, reloadToken, refreshToken]);

  useEffect(() => {
    onStateChange?.({
      ownerId: currentUserId,
      loading: loading || Boolean(vaultOwnerToken && !loadedForSession),
      error,
      count: circles.length,
      circles,
      available: Boolean(vaultOwnerToken),
    });
  }, [
    circles,
    currentUserId,
    error,
    loadedForSession,
    loading,
    onStateChange,
    vaultOwnerToken,
  ]);

  const listSessionRef = useRef({ currentUserId, vaultOwnerToken });
  if (
    listSessionRef.current.currentUserId !== currentUserId ||
    listSessionRef.current.vaultOwnerToken !== vaultOwnerToken
  ) {
    listSessionRef.current = { currentUserId, vaultOwnerToken };
  }
  const listSession = listSessionRef.current;
  const customTypesSupported = loadedForSession && loaded.customTypePolicy?.version === 1 && loaded.customTypePolicy.maxTypes === 3;
  const allCustomGroups = useMemo(() => customCircleTypeGroups(circles), [circles]);
  const [pendingTypeDraft, setPendingTypeDraft] = useState<{ session: typeof listSession; label: string } | null>(null);
  const pendingType = pendingTypeDraft?.session === listSession ? pendingTypeDraft.label : null;
  type PendingCircle = {
    circle: OneLocationCircleSummary;
    action: "delete" | "leave";
  };
  const [circleQueryDraft, setCircleQueryDraft] = useState({
    session: listSession,
    value: "",
  });
  const circleQuery =
    circleQueryDraft.session === listSession ? circleQueryDraft.value : "";
  const setCircleQuery = useCallback(
    (value: string) => setCircleQueryDraft({ session: listSession, value }),
    [listSession],
  );
  const [pendingCircleDraft, setPendingCircleDraft] = useState<{
    session: typeof listSession;
    value: PendingCircle | null;
  } | null>(null);
  const pendingCircle =
    pendingCircleDraft?.session === listSession
      ? pendingCircleDraft.value
      : null;
  const setPendingCircle = useCallback(
    (value: PendingCircle | null) =>
      setPendingCircleDraft({ session: listSession, value }),
    [listSession],
  );
  const listMutationRef = useRef(false);
  useEffect(() => {
    listMutationRef.current = false;
    setBusy(false);
  }, [listSession]);
  useEffect(() => {
    onSearchActiveChange?.(Boolean(circleQuery.trim()));
  }, [circleQuery, onSearchActiveChange]);
  const { owned, joined } = useMemo(
    () =>
      orderCircles(
        circles.filter((circle) =>
          `${circle.name} ${circle.customTypeLabel ?? ""}`
            .toLocaleLowerCase()
            .includes(circleQuery.trim().toLocaleLowerCase()),
        ),
      ),
    [circles, circleQuery],
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
        memberSetup?: boolean;
      },
      mode: "push" | "replace" = "push",
    ) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(CONNECT_SURFACE_PARAM, "circles");
      params.delete("circleChat");
      params.delete("circleSetup");
      if (next.memberSetup) params.set("circleSetup", "1");
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
  const goRef = useRef(go);
  goRef.current = go;

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

  useEffect(() => {
    if (!currentUserId || !vaultOwnerToken || !isActive) return;
    // Push/SSE is the fast path. A visible-only read repairs a dropped push
    // without requiring a user to blur the app or manually refresh the tab.
    let cancelled = false;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      void OneLocationService.listCircleWorkspace(vaultOwnerToken)
        .then((workspace) => {
          if (cancelled) return;
          const next = workspace.circles;
          setLoaded({
            token: vaultOwnerToken,
            ownerId: currentUserId,
            circles: next,
            customTypePolicy: workspace.customTypePolicy,
          });
          setError(null);
          setLoading(false);
          if (
            circleIdParam &&
            !next.some((circle) => circle.id === circleIdParam)
          ) {
            goRef.current(
              { action: null, circleId: null, code: null },
              "replace",
            );
            return;
          }
          if (circleIdParam) setDetailReloadToken((token) => token + 1);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [circleIdParam, currentUserId, isActive, vaultOwnerToken, reloadToken, refreshToken]);

  const closeFlow = useCallback(
    (refreshList = true) => {
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
    },
    [go],
  );

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

  if (
    createDialogOpen ||
    (vaultOwnerToken && actions && action === "create-circle")
  ) {
    const form = actions ? (
      <CreateCircleFlow
        key={`${currentUserId}:${vaultOwnerToken}`}
        busy={busy}
        customTypes={allCustomGroups.map(group => group.label)}
        customTypesSupported={customTypesSupported}
        pathname={ROUTES.CONNECT}
        backLayerQuery={createDialogOpen ? {} : { action: "create-circle" }}
        onLoadPeople={actions.loadEligibleConnectionsPage}
        onAddPeople={async (circleId, userIds) => {
          await withBusy(() => actions.inviteConnections(circleId, userIds));
          announceCircleMutation("location_circle_member_added", circleId);
        }}
        onSubmit={async (name, kind, existingCircleId, customTypeLabel) => {
          const circle = await withBusy(() =>
            actions.createCircle(name, kind, existingCircleId, customTypeLabel),
          );
          if (!existingCircleId)
            trackEvent("one_location_circle_created", {
              route_id: "connect",
              result: "success",
              circle_kind: kind,
            });
          announceCircleMutation(
            existingCircleId
              ? "location_circle_renamed"
              : "location_circle_created",
            circle.id,
          );
          return circle;
        }}
        onComplete={(circleId) => {
          // Modal creation pushes details so Back returns to its launch page.
          // The full-page flow replaces the form that just succeeded.
          go(
            { action: "circle-detail", circleId },
            createDialogOpen ? "push" : "replace",
          );
          onCreateDialogOpenChange?.(false);
        }}
      />
    ) : (
      <p className="text-sm text-[color:var(--app-secondary-label)]">
        Unlock One to create a Circle.
      </p>
    );
    return createDialogOpen ? (
      <Dialog
        modal
        open
        onOpenChange={(open) => {
          if (!busy) onCreateDialogOpenChange?.(open);
        }}
      >
        <TaskDialogContent
          className={taskSurfaceStyles.createDialog}
          showCloseButton={!busy}
          srDescription="Name your Circle and choose its type. Next, add people now or later."
          onEscapeKeyDown={(event) => {
            if (busy || unwindBackLayer(ROUTES.CONNECT, searchParams))
              event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create a Circle</DialogTitle>
          </DialogHeader>
          {form}
        </TaskDialogContent>
      </Dialog>
    ) : (
      form
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
        livingCircleExperience
        memberSetup={searchParams.get("circleSetup") === "1"}
        onMemberSetupComplete={finishMemberSetup}
        chatIntent={searchParams.get("circleChat") === "1"}
        renderChat={
          chatSession
            ? (circle, { active, readingBlocked }) => (
                <CircleChat
                  key={`${chatSession.userId}:${chatSession.circleId}:${chatSession.vaultOwnerToken}`}
                  session={chatSession}
                  circleName={circle.name}
                  initialOpen
                  active={active}
                  readingBlocked={readingBlocked}
                  collapsible={false}
                  onOpenIntentConsumed={
                    searchParams.get("circleChat") === "1"
                      ? consumeChatIntent
                      : undefined
                  }
                />
              )
            : undefined
        }
        // A signal, not a `key`. Remounting would re-read the roster but also
        // close an open add-people sheet, clear a half-typed search and drop
        // the selection -- and a notification can arrive at any moment.
        reloadSignal={detailReloadToken + refreshToken}
        circleId={circleIdParam}
        currentUserId={currentUserId}
        sessionScope={vaultOwnerToken}
        initialCircleSummary={circles.find(
          (circle) => circle.id === circleIdParam,
        )}
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
        onPhotoUpdate={async (circleId, photoUrl) => {
          const updated = await withBusy(() =>
            actions.updatePhoto(circleId, photoUrl),
          );
          announceCircleMutation("location_circle_photo_updated", circleId);
          toast.success(
            photoUrl ? "Circle photo updated." : "Circle photo removed.",
          );
          return updated;
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
          // The detail flow owns scoped success feedback for its batch.
          await withBusy(() =>
            actions.inviteConnections(circleId, userIds, false),
          );
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
    const title =
      isSystemCircleKind(kind) &&
      circle.role === "owner" &&
      circle.name === SYSTEM_CIRCLE_COPY[kind].title
        ? SYSTEM_CIRCLE_COPY[kind].title
        : circle.name;
    const testId = kind
      ? `connect-circle-${kind}`
      : circle.role === "owner"
        ? "connect-circle-owned"
        : "connect-circle-joined";
    const action =
      circle.viewerCapabilities?.canDeleteCircle === true &&
      !kind &&
      !circle.isSystem
        ? "delete"
        : circle.viewerCapabilities?.canLeaveCircle === true
          ? "leave"
          : null;
    return (
      <ConnectCircleRow
        key={`${currentUserId}:${circle.id}`}
        title={title}
        description={circleRowDescription(circle)}
        testId={testId}
        action={action}
        onOpen={() => openCircle(circle.id)}
        onDestructive={() => {
          if (action) setPendingCircle({ circle, action });
        }}
      />
    );
  };

  const customGroups = customCircleTypeGroups(owned);
  const customIds = new Set(customGroups.flatMap(group => group.circles.map(circle => circle.id)));
  const ordinaryOwned = owned.filter(circle => !customIds.has(circle.id));

  return (
    <div className="space-y-4" data-profile-type-scale="circles" data-testid="connect-circles-tab">
      {vaultOwnerToken ? (
        <>
          <label className={styles.circleSearch}>
            <span className="sr-only">Search your and joined circles</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              placeholder="Circle name"
              value={circleQuery}
              onChange={(event) => setCircleQuery(event.target.value)}
            />
          </label>
          <ConnectCircleHeading
            title="Your circles"
            count={!loading && !error ? owned.length : undefined}
            action="create"
            onAction={() => go({ action: "create-circle" })}
          />
        </>
      ) : null}
      {vaultOwnerToken === null ? (
        <SettingsGroup title="Your circles">
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
        <SettingsGroup>
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
        <SettingsGroup>
          <SettingsRow title="Loading circles…" density="compact" disabled />
        </SettingsGroup>
      ) : (
        <>
          {ordinaryOwned.length ? (
            <section data-testid="connect-circle-group-owned">
              <div
                className={`${CONNECT_CIRCLE_GRID_CLASSNAME} ${styles.circleGroup}`}
              >
                {ordinaryOwned.map(renderCircleRow)}
              </div>
            </section>
          ) : owned.length ? null : (
            <div className="py-5 text-center">
              <h3 className="text-sm font-semibold">
                {circleQuery
                  ? "No circles found"
                  : joined.length
                    ? "No circles created yet."
                    : "Make a circle"}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {circleQuery
                  ? "Try a different name."
                  : "Bring together people you choose."}
              </p>
            </div>
          )}
          {joined.length ? (
            <section data-testid="connect-circle-group-joined">
              <ConnectCircleHeading
                title="Joined circles"
                count={joined.length}
                action="join"
                onAction={() => go({ action: "join-circle" })}
              />
              <div
                className={`${CONNECT_CIRCLE_GRID_CLASSNAME} ${styles.circleGroup}`}
              >
                {joined.map(renderCircleRow)}
              </div>
            </section>
          ) : null}
          {customGroups.map(group => (
            <section key={group.label.toLocaleLowerCase()} aria-label={`${group.label} circles`}>
              <div className={styles.circleHeading}>
                <h2>{group.label} <span className={styles.count}>{group.circles.length}</span></h2>
                {customTypesSupported ? <Button type="button" variant="none" effect="fade" size="icon-touch"
                  aria-label={`Delete ${group.label} type`} disabled={busy}
                  onClick={() => setPendingTypeDraft({ session: listSession, label: group.label })}>
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button> : null}
              </div>
              <div className={`${CONNECT_CIRCLE_GRID_CLASSNAME} ${styles.circleGroup}`}>
                {group.circles.map(renderCircleRow)}
              </div>
            </section>
          ))}
        </>
      )}
      <AlertDialog open={pendingType !== null} onOpenChange={open => { if (!open && !listMutationRef.current) setPendingTypeDraft(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingType} type?</AlertDialogTitle>
            <AlertDialogDescription>Your circles and their members will stay. These circles will use Other, and you can create a new type.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={event => {
              event.preventDefault();
              if (!pendingType || !vaultOwnerToken || !customTypesSupported || listMutationRef.current) return;
              listMutationRef.current = true;
              const session = listSession;
              setBusy(true);
              const operation = OneLocationService.deleteCircleType({ vaultOwnerToken, customTypeLabel: pendingType }).then(() => {
                if (listSessionRef.current !== session) return;
                setPendingTypeDraft(null);
                setReloadToken(value => value + 1);
                announceCircleMutation("location_circle_type_deleted");
              });
              morphyToast.promise(operation, { loading: "Deleting type…", success: "Type deleted. Your circles are kept.", error: "Could not delete this type. Try again." });
              void operation.catch(() => undefined).finally(() => {
                if (listSessionRef.current === session) { listMutationRef.current = false; setBusy(false); }
              });
            }}>Delete type</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={pendingCircle !== null}
        onOpenChange={(open) => {
          if (!open && !listMutationRef.current) setPendingCircle(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingCircle?.action === "delete" ? "Delete" : "Leave"}{" "}
              {pendingCircle?.circle.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCircle?.action === "delete"
                ? "This removes the circle for everyone. This cannot be undone."
                : "You will no longer be a member of this circle."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (
                  !pendingCircle ||
                  !actions ||
                  !currentUserId ||
                  listMutationRef.current
                )
                  return;
                listMutationRef.current = true;
                const selected = pendingCircle;
                const session = listSessionRef.current;
                const isCurrent = () => listSessionRef.current === session;
                setBusy(true);
                const operation = (async () => {
                  const latest = await actions.loadCircleOverview(
                    selected.circle.id,
                  );
                  if (!isCurrent())
                    throw new Error(
                      "Circle action cancelled. Return to your current account to try again.",
                    );
                  const allowed =
                    selected.action === "delete"
                      ? latest.viewerCapabilities?.canDeleteCircle === true &&
                        !latest.isSystem &&
                        !latest.systemKind
                      : latest.viewerCapabilities?.canLeaveCircle === true;
                  if (!allowed)
                    throw new Error(
                      "Your permission to change this circle has changed.",
                    );
                  await (selected.action === "delete"
                    ? actions.deleteCircle(latest.id, false)
                    : actions.leaveCircle(latest.id, false));
                  if (!isCurrent()) return;
                  trackOneLocationJourneyAction({
                    action:
                      selected.action === "delete"
                        ? "circle_deleted"
                        : "circle_left",
                    routeId: "connect",
                    entrySurface: "connect_circles",
                    targetType: "circle",
                  });
                  announceCircleMutation(
                    selected.action === "delete"
                      ? "location_circle_deleted"
                      : "location_circle_member_left",
                    latest.id,
                    selected.action === "leave" ? currentUserId : undefined,
                  );
                  setPendingCircle(null);
                })();
                void morphyToast.promise(operation, {
                  loading:
                    selected.action === "delete"
                      ? "Deleting circle…"
                      : "Leaving circle…",
                  success: "Circle updated.",
                  error: (error) =>
                    error instanceof Error
                      ? error.message
                      : "Could not update this circle.",
                });
                void operation
                  .catch(() => undefined)
                  .finally(() => {
                    if (isCurrent()) {
                      listMutationRef.current = false;
                      setBusy(false);
                    }
                  });
              }}
            >
              {busy
                ? "Updating…"
                : pendingCircle?.action === "delete"
                  ? "Delete circle"
                  : "Leave circle"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {vaultOwnerToken && !joined.length ? (
        <div className="flex justify-center py-2">
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="compact"
            onClick={() => go({ action: "join-circle" })}
            data-testid="connect-circle-join"
          >
            <KeyRound aria-hidden="true" className="mr-2 size-4" />
            Join with code
          </Button>
        </div>
      ) : null}
    </div>
  );
}
