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
import { KeyRound, Plus, ShieldCheck, UsersRound } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  CircleDetailFlow,
  CreateCircleFlow,
  JoinCircleFlow,
} from "@/components/one-location/redesign/circles/named-circle-flows";
import { SmsTextIcon } from "@/components/one-location/redesign/sms-text-icon";
import { createConnectCircleActions } from "@/components/connect/circles/connect-circle-actions";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { CIRCLE_JOIN_CODE_PARAM } from "@/lib/one-location/circle-join-url";
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

  /**
   * Somebody else acting on your Circle.
   *
   * A person joining with a code, accepting an invitation, or being added by
   * another owner changes this list without you touching anything -- and until
   * this listener, the only way to see it was to reload the page. The Location
   * agent has always refreshed on the same event
   * (`app/one/location/page.tsx`, the `handleLocationNotification` effect), so
   * the two surfaces disagreed about how current they were.
   *
   * The same notification the push already delivers. This is not polling and
   * opens no socket: it listens to the event the notification layer dispatches
   * when something lands.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onConsentStateChanged = (event: Event) => {
      const detail =
        (event as CustomEvent<Record<string, unknown>>).detail || {};
      const source = String(detail.source || "").trim();
      const notificationType = String(detail.notificationType || "").trim();
      // Circle news arrives on the Location channel, because that is where the
      // backend still sends it from.
      if (
        source !== "one_location_notification" &&
        !notificationType.startsWith("location_") &&
        !notificationType.startsWith("circle")
      ) {
        return;
      }
      setReloadToken((token) => token + 1);
    };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentStateChanged);
    return () =>
      window.removeEventListener(
        CONSENT_STATE_CHANGED_EVENT,
        onConsentStateChanged,
      );
  }, []);

  const { owned, joined } = useMemo(() => orderCircles(circles), [circles]);

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

  const closeFlow = useCallback(() => {
    // `replace`, not push. This runs after leaving and after deleting, so the
    // entry it closes may name a Circle that no longer exists -- and pushing
    // left it a back destination that re-mounted into "Could not open this
    // Circle" with a Retry that can never succeed. The Location hub replaces
    // for exactly this reason.
    go({ action: null, circleId: null, code: null }, "replace");
    // The list behind the flow is stale the moment anything was created,
    // renamed, joined or left. Re-read rather than patch: a roster kept in two
    // places is the thing this move exists to end.
    setReloadToken((token) => token + 1);
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
          // `replace`, so back from the new Circle returns to the list rather
          // than to the form that just succeeded.
          go({ action: "circle-detail", circleId: circle.id }, "replace");
          setReloadToken((token) => token + 1);
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
          go({ action: "circle-detail", circleId: circle.id }, "replace");
          setReloadToken((token) => token + 1);
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
        reloadSignal={reloadToken + refreshToken}
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
          setReloadToken((token) => token + 1);
          return renamed;
        }}
        onGenerateCode={(circleId, rotate) =>
          withBusy(() => actions.generateCode(circleId, rotate))
        }
        onCopyCode={actions.copyCode}
        onShareCode={actions.shareCode}
        onShareWithMember={(circleId) => shareWithMember(circleId)}
        onRemoveMember={async (circleId, userId) => {
          await withBusy(() => actions.removeMember(circleId, userId));
          setReloadToken((token) => token + 1);
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
          // The roster on screen is stale the moment somebody is added. It
          // used to stay stale until the person navigated away and back.
          setReloadToken((token) => token + 1);
        }}
        onCancelMemberInvite={actions.cancelMemberInvite}
        onLeave={async (circleId) => {
          await withBusy(() => actions.leaveCircle(circleId));
          closeFlow();
        }}
        onDelete={async (circleId) => {
          await withBusy(() => actions.deleteCircle(circleId));
          closeFlow();
        }}
      />
    );
  }

  const renderCircleRow = (circle: OneLocationCircleSummary) => {
    const kind = systemKindOf(circle);
    const isSmsCircle = kind === "sms";
    const testId = kind
      ? `connect-circle-${kind}`
      : circle.role === "owner"
        ? "connect-circle-owned"
        : "connect-circle-joined";

    return (
      <SettingsRow
        key={circle.id}
        icon={
          kind === "trusted"
            ? ShieldCheck
            : isSmsCircle
              ? undefined
              : UsersRound
        }
        leading={
          isSmsCircle ? (
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-destructive)] text-[color:var(--app-destructive-fg)]"
            >
              <SmsTextIcon className="text-[8px]" />
            </span>
          ) : undefined
        }
        iconTone="indigo"
        // The product name only for the Circle that is yours. An SMS Circle
        // shows up in the list of everyone on it, and the server deliberately
        // renames the ones you do not own -- "Alice's SMS Circle" -- because
        // three friends' rosters would otherwise be three identical rows
        // reading "SMS Circle". Overwriting that name here threw the
        // disambiguation away.
        // The product's name only while it is still the product's.
        //
        // An owner may rename their SMS Circle -- the server treats that as
        // their decision and heals only the default -- so overriding the title
        // here unconditionally meant the rename succeeded, persisted, showed
        // on Location, and was silently discarded on this list. Once the stored
        // name differs from the default it is theirs, and it wins.
        title={
          isSystemCircleKind(kind) &&
          circle.role === "owner" &&
          circle.name === SYSTEM_CIRCLE_COPY[kind].title
            ? SYSTEM_CIRCLE_COPY[kind].title
            : circle.name
        }
        description={circleRowDescription(circle)}
        density="compact"
        chevron
        onClick={() => openCircle(circle.id)}
        testId={testId}
      />
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
          <SettingsGroup
            title="Your circles"
            separatorInset
            testId="connect-circle-group-owned"
          >
            {owned.map(renderCircleRow)}
          </SettingsGroup>
          {joined.length ? (
            <SettingsGroup
              title="Joined circles"
              separatorInset
              testId="connect-circle-group-joined"
            >
              {joined.map(renderCircleRow)}
            </SettingsGroup>
          ) : null}
        </>
      )}

      {/* Its own group, below the list, so it does not move as the list grows
          -- and 56px rows rather than the 16px header links Location uses,
          which shift with the heading when it wraps. */}
      {vaultOwnerToken ? (
        <SettingsGroup separatorInset>
          <SettingsRow
            icon={Plus}
            iconTone="indigo"
            title="New circle"
            description="Name a group and invite people you're connected to."
            density="compact"
            chevron
            onClick={() => go({ action: "create-circle" })}
            testId="connect-circle-create"
          />
          <SettingsRow
            icon={KeyRound}
            iconTone="gray"
            title="Join with code"
            description="Enter the 12-character code someone shared with you."
            density="compact"
            chevron
            onClick={() => go({ action: "join-circle" })}
            testId="connect-circle-join"
          />
        </SettingsGroup>
      ) : null}
    </div>
  );
}
