"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, Plus, ShieldCheck, Siren, UsersRound } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  CircleDetailFlow,
  CreateCircleFlow,
  JoinCircleFlow,
} from "@/components/one-location/redesign/circles/named-circle-flows";
import { createConnectCircleActions } from "@/components/connect/circles/connect-circle-actions";
import { CIRCLE_JOIN_CODE_PARAM } from "@/lib/one-location/circle-join-url";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";
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

/** The sub-view, carried in the URL beside `?tab=circles`.
 *
 *  Named to match the Location agent's own parameters, so an already-shared
 *  link keeps its shape when it is repointed here. */
export const CONNECT_CIRCLE_ACTION_PARAM = "action";
export const CONNECT_CIRCLE_ID_PARAM = "circleId";

export type ConnectCircleAction =
  | "create-circle"
  | "join-circle"
  | "circle-detail";

function readAction(value: string | null): ConnectCircleAction | null {
  return value === "create-circle" ||
    value === "join-circle" ||
    value === "circle-detail"
    ? value
    : null;
}

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
    description: "Gets your SOS text",
  },
} as const satisfies Record<SystemCircleKind, { title: string; description: string }>;

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
 * The viewer is excluded from the count for the same reason the Location list
 * excludes them: "3 people" reading as two others and yourself is the answer
 * to a question nobody asked.
 */
export function circleRowDescription(circle: OneLocationCircleSummary): string {
  const others = Math.max(0, Number(circle.memberCount || 0) - 1);
  const kind = systemKindOf(circle);
  const owns = circle.role === "owner";
  const people = others === 1 ? "1 person" : `${others} people`;

  // Trusted is owner-scoped by the server, so the only viewer who can reach
  // this line is its owner. Guarded anyway: "Everyone you're connected to" on
  // somebody else's roster would be a false statement about the reader.
  if (kind === "trusted" && owns) {
    return others === 0
      ? SYSTEM_CIRCLE_COPY.trusted.description
      : `${SYSTEM_CIRCLE_COPY.trusted.description} · ${people}`;
  }
  if (kind === "sms") {
    // An SMS Circle appears in the list of everyone ON it, not only its
    // owner's. "Gets your SOS text" is true for exactly one of those readers;
    // for the rest the line has to say what it means for THEM.
    const lead = owns
      ? SYSTEM_CIRCLE_COPY.sms.description
      : "You'll get their SOS text";
    if (!owns) return lead;
    return others === 0 ? `${lead} · no one yet` : `${lead} · ${people}`;
  }
  return others === 0 ? "No members yet" : people;
}

/** System Circles first, then the ones the person made, newest first. */
export function orderCircles(
  circles: readonly OneLocationCircleSummary[],
): { system: OneLocationCircleSummary[]; owned: OneLocationCircleSummary[] } {
  const system: OneLocationCircleSummary[] = [];
  const owned: OneLocationCircleSummary[] = [];
  for (const circle of circles) {
    const kind = systemKindOf(circle);
    if (kind === "trusted" || kind === "sms") system.push(circle);
    else owned.push(circle);
  }
  // Trusted above SMS: one describes who you know, the other what happens in an
  // emergency, and the first is the one a person opens this tab to see.
  system.sort((left, right) => {
    const rank = (c: OneLocationCircleSummary) =>
      systemKindOf(c) === "trusted" ? 0 : 1;
    return rank(left) - rank(right);
  });
  return { system, owned };
}

export function ConnectCirclesTab({
  onStateChange,
  currentUserId = null,
  getIdToken,
}: {
  /** Lets the page keep its native beacon and voice metadata truthful without
   *  hoisting circle state into a 2,400-line component. */
  onStateChange?: (state: {
    loading: boolean;
    error: string | null;
    count: number;
  }) => void;
  currentUserId?: string | null;
  /** Only the connect-a-co-member action needs Firebase identity. Optional so
   *  the tab still renders in a test that mocks no auth. */
  getIdToken?: () => Promise<string | null>;
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

  const action = readAction(searchParams.get(CONNECT_CIRCLE_ACTION_PARAM));
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
    setLoading(true);
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
    void OneLocationService.ensureTrustedSystemCircle({ vaultOwnerToken })
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
  }, [vaultOwnerToken, reloadToken]);

  useEffect(() => {
    onStateChange?.({ loading, error, count: circles.length });
  }, [circles.length, error, loading, onStateChange]);

  const { system, owned } = useMemo(() => orderCircles(circles), [circles]);

  const actions = useMemo(
    () =>
      vaultOwnerToken
        ? createConnectCircleActions({
            vaultOwnerToken,
            getIdToken: getIdToken ?? (async () => null),
          })
        : null,
    [getIdToken, vaultOwnerToken],
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
      params.set("tab", "circles");
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
    go({ action: null, circleId: null, code: null });
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

  const withBusy = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await run();
    } finally {
      setBusy(false);
    }
  }, []);

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
        onResolve={actions.resolveCode}
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
        circleId={circleIdParam}
        currentUserId={currentUserId}
        busy={busy}
        onBack={closeFlow}
        onLoad={actions.loadCircle}
        onRename={(circleId, name) =>
          withBusy(() => actions.renameCircle(circleId, name))
        }
        onGenerateCode={(circleId, rotate) =>
          withBusy(() => actions.generateCode(circleId, rotate))
        }
        onCopyCode={actions.copyCode}
        onShareCode={actions.shareCode}
        onShareWithMember={(circleId) => shareWithMember(circleId)}
        onRemoveMember={(circleId, userId) =>
          withBusy(() => actions.removeMember(circleId, userId))
        }
        onConnectMember={actions.connectMember}
        onLoadEligibleConnections={actions.loadEligibleConnections}
        onInviteConnections={async (circleId, userIds) => {
          await withBusy(() => actions.inviteConnections(circleId, userIds));
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

  return (
    <div className="space-y-4 sm:space-y-5" data-testid="connect-circles-tab">
      {vaultOwnerToken === null ? (
        <SettingsGroup title="Your circles">
          <SettingsRow
            title="Unlock One to see your circles"
            description="Circles hold the people you share with, so they stay behind the vault."
            density="compact"
            disabled
          />
        </SettingsGroup>
      ) : error ? (
        <SettingsGroup title="Your circles">
          <SettingsRow
            title="Circles are unavailable"
            description={error}
            density="compact"
            tone="destructive"
          />
        </SettingsGroup>
      ) : loading ? (
        <SettingsGroup title="Your circles">
          <SettingsRow title="Loading circles…" density="compact" disabled />
        </SettingsGroup>
      ) : (
        <SettingsGroup title="Your circles" separatorInset>
          {system.map((circle) => {
            const kind = systemKindOf(circle);
            return (
              <SettingsRow
                key={circle.id}
                icon={kind === "trusted" ? ShieldCheck : Siren}
                iconTone="indigo"
                // The product name only for the Circle that is yours. An SMS
                // Circle shows up in the list of everyone on it, and the server
                // deliberately renames the ones you do not own -- "Alice's SMS
                // Circle" -- because three friends' rosters would otherwise be
                // three identical rows reading "SMS Circle". Overwriting that
                // name here threw the disambiguation away.
                title={
                  isSystemCircleKind(kind) && circle.role === "owner"
                    ? SYSTEM_CIRCLE_COPY[kind].title
                    : circle.name
                }
                description={circleRowDescription(circle)}
                density="compact"
                chevron
                onClick={() => openCircle(circle.id)}
                testId={`connect-circle-${kind}`}
              />
            );
          })}
          {owned.map((circle) => (
            <SettingsRow
              key={circle.id}
              icon={UsersRound}
              iconTone="indigo"
              title={circle.name}
              description={circleRowDescription(circle)}
              density="compact"
              chevron
              onClick={() => openCircle(circle.id)}
              testId="connect-circle-owned"
            />
          ))}
        </SettingsGroup>
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
