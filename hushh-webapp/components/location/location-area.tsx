"use client";

/**
 * Voice-first Location area: one route, one screen at a time.
 *
 * Reads `?view=now|people|circles|links`, `?action=<flow>`, `?circle=<id>`
 * and `?person=<user_id>` (see lib/location/screen-ids.ts) and mounts exactly
 * one screen inside the app shell. The top bar owns back and the breadcrumb;
 * flows draw their own `TaskFlowHeader` and nothing else above the content.
 *
 * An unknown `?action=` lands on Now with a toast, and the URL is corrected
 * so the breadcrumb and the screen agree again.
 */

import { MapPin } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { AgentHeaderIcon, PageHeader } from "@/components/app-ui/page-sections";

import { AskForLocationFlow } from "@/components/location/ask/ask-for-location-flow";
import { CheckInFlow } from "@/components/location/check-in/check-in-flow";
import { CircleDetail } from "@/components/location/circles/circle-detail";
import { CreateCircleFlow } from "@/components/location/circles/create-circle-flow";
import { InviteToCircleFlow } from "@/components/location/circles/invite-to-circle-flow";
import { LocationCircles } from "@/components/location/circles/location-circles";
import { LocationLinks } from "@/components/location/links/location-links";
import {
  LocationActiveSharesScreen,
  LocationHome,
  LocationNeedsReviewScreen,
  LocationSharedWithMeScreen,
  useLocationWorkspaceState,
} from "@/components/location/location-home";
import { LocationPeople } from "@/components/location/people/location-people";
import { PlaceRatings } from "@/components/location/ratings/place-ratings";
import { LocationSettings } from "@/components/location/settings/location-settings";
import { LocationSetupFlow } from "@/components/location/setup/location-setup-flow";
import { ShareLocationFlow } from "@/components/location/share/share-location-flow";
import { SaveMySoul } from "@/components/location/sos/save-my-soul";
import { JoinCircleFlow } from "@/components/one-location/redesign/circles/named-circle-flows";
import {
  DEFAULT_LOCATION_VIEW,
  LOCATION_VIEWS,
  hrefForLocationView,
  isLocationView,
  resolveLocationAction,
  type LocationAction,
  type LocationView,
} from "@/lib/location/screen-ids";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import {
  EmptyState,
  TaskFlowHeader,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { OneLocationService } from "@/lib/one-location/service";
import { useVault } from "@/lib/vault/vault-context";

export type LocationAreaProps = {
  mode?: "workspace" | "setup";
};

export const GONE_TOAST = "That's no longer there.";

const TAB_OPTIONS: Array<{ value: LocationView; label: string }> = [
  { value: "now", label: "Now" },
  { value: "people", label: "People" },
  { value: "circles", label: "Circles" },
  { value: "links", label: "Links" },
];

/** Resolve the URL to the one screen this area mounts. */
export type LocationAreaRoute =
  | {
      kind: "view";
      view: LocationView;
      personId: string | null;
      circleId: string | null;
    }
  | {
      kind: "action";
      action: LocationAction;
      personId: string | null;
      circleId: string | null;
    }
  | { kind: "gone"; raw: string };

export function resolveLocationAreaRoute(params: {
  view: string | null;
  action: string | null;
  person: string | null;
  circle: string | null;
}): LocationAreaRoute {
  const personId = params.person?.trim() || null;
  const circleId = params.circle?.trim() || null;
  if (params.action) {
    const action = resolveLocationAction(params.action);
    if (!action) return { kind: "gone", raw: params.action };
    if (
      (action === "circle-detail" || action === "invite-circle") &&
      !circleId
    ) {
      return { kind: "gone", raw: params.action };
    }
    return { kind: "action", action, personId, circleId };
  }
  const view = isLocationView(params.view)
    ? params.view
    : DEFAULT_LOCATION_VIEW;
  return { kind: "view", view, personId, circleId };
}

function JoinCircleScreen() {
  const router = useRouter();
  const { vaultOwnerToken } = useVault();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);
  const initialCode = searchParams?.get("code") ?? undefined;

  const resolve = useCallback(
    async (code: string) => {
      if (!vaultOwnerToken)
        throw new Error("Unlock your vault to join a circle.");
      return OneLocationService.resolveNamedCircleCode({
        vaultOwnerToken,
        code,
      });
    },
    [vaultOwnerToken],
  );

  const join = useCallback(
    async (code: string) => {
      if (!vaultOwnerToken)
        throw new Error("Unlock your vault to join a circle.");
      setBusy(true);
      try {
        const result = await OneLocationService.joinNamedCircle({
          vaultOwnerToken,
          code,
        });
        morphyToast.success(
          result.joined
            ? `You joined ${result.circle.name}.`
            : `You're already in ${result.circle.name}.`,
        );
        router.replace(hrefForLocationView("circles"), { scroll: false });
      } finally {
        setBusy(false);
      }
    },
    [router, vaultOwnerToken],
  );

  return (
    <section className="space-y-5" data-testid="location-join-circle">
      <TaskFlowHeader eyebrow="Location" title="Join circle" />
      <JoinCircleFlow
        busy={busy}
        onResolve={resolve}
        onJoin={join}
        initialCode={initialCode}
      />
    </section>
  );
}

/** `?action=sms-contacts`: the emergency circle, once the state names it. */
function EmergencyContactsScreen() {
  const workspace = useLocationWorkspaceState();
  const smsCircle = useMemo(
    () =>
      (workspace.state?.circles ?? []).find(
        (circle) => circle.systemKind === "sms",
      ) ?? null,
    [workspace.state?.circles],
  );
  if (smsCircle) return <CircleDetail circleId={smsCircle.id} />;
  return (
    <section className="space-y-5" data-testid="location-emergency-contacts">
      <TaskFlowHeader
        eyebrow="Location"
        title="Emergency contacts"
        description="The people Save My Soul alerts."
      />
      {workspace.state || workspace.status === "error" ? (
        <EmptyState
          title="No emergency circle yet"
          description="Open Save My Soul to choose who gets alerted; the circle is created for you."
        />
      ) : (
        <p className="ui-text-row-description">Loading</p>
      )}
    </section>
  );
}

function ScreenFor({
  route,
}: {
  route: Exclude<LocationAreaRoute, { kind: "gone" }>;
}) {
  if (route.kind === "view") {
    switch (route.view) {
      case "people":
        return <LocationPeople focusedUserId={route.personId} />;
      case "circles":
        return <LocationCircles circleId={route.circleId} />;
      case "links":
        return <LocationLinks />;
      default:
        return <LocationHome />;
    }
  }
  switch (route.action) {
    case "share":
      return <ShareLocationFlow personId={route.personId} />;
    case "ask":
      return <AskForLocationFlow personId={route.personId} />;
    case "invite-circle":
      return (
        <InviteToCircleFlow
          circleId={route.circleId ?? ""}
          userId={route.personId}
        />
      );
    case "create-circle":
      return <CreateCircleFlow />;
    case "join-circle":
      return <JoinCircleScreen />;
    case "circle-detail":
      return <CircleDetail circleId={route.circleId ?? ""} />;
    case "check-in":
      return <CheckInFlow personId={route.personId} />;
    case "sos":
      return <SaveMySoul />;
    case "sms-contacts":
      return <EmergencyContactsScreen />;
    case "settings":
      return <LocationSettings />;
    case "active-shares":
      return <LocationActiveSharesScreen />;
    case "shared-with-me":
      return <LocationSharedWithMeScreen />;
    case "needs-review":
      return <LocationNeedsReviewScreen />;
    case "ratings":
      return <PlaceRatings />;
    default:
      return <LocationHome />;
  }
}

function WorkspaceArea() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const route = useMemo(
    () =>
      resolveLocationAreaRoute({
        view: searchParams?.get("view") ?? null,
        action: searchParams?.get("action") ?? null,
        person: searchParams?.get("person") ?? null,
        circle: searchParams?.get("circle") ?? null,
      }),
    [searchParams],
  );

  // An unknown flow: say so once, then correct the URL so the breadcrumb and
  // the screen agree. The toast is keyed on the raw value so a re-render
  // during the replace does not repeat it.
  const goneRef = useRef<string | null>(null);
  useEffect(() => {
    if (route.kind !== "gone") return;
    if (goneRef.current !== route.raw) {
      goneRef.current = route.raw;
      morphyToast.info(GONE_TOAST);
    }
    router.replace(hrefForLocationView(DEFAULT_LOCATION_VIEW), {
      scroll: false,
    });
  }, [route, router]);

  const activeView: LocationView =
    route.kind === "view" ? route.view : DEFAULT_LOCATION_VIEW;
  const showTabs = route.kind !== "action";

  const onTab = useCallback(
    (value: string) => {
      if (!isLocationView(value)) return;
      router.replace(hrefForLocationView(value), { scroll: false });
    },
    [router],
  );

  let body: ReactNode;
  if (route.kind === "gone") {
    body = <LocationHome />;
  } else {
    body = <ScreenFor route={route} />;
  }

  return (
    <AppPageShell
      width="agent"
      data-testid="location-area"
      data-location-route={route.kind}
    >
      <AppPageHeaderRegion className="space-y-4">
        <PageHeader
          title="Location"
          leading={<AgentHeaderIcon icon={MapPin} />}
          accent="location"
          titleRole="agent"
          testId="location-area-header"
        />
        {showTabs ? (
          <SegmentedTabs
            ariaLabel="Location sections"
            variant="agent-top"
            value={activeView}
            options={TAB_OPTIONS}
            onValueChange={onTab}
            mobileColumns={LOCATION_VIEWS.length}
          />
        ) : null}
      </AppPageHeaderRegion>
      <AppPageContentRegion>{body}</AppPageContentRegion>
    </AppPageShell>
  );
}

export function LocationArea({ mode = "workspace" }: LocationAreaProps = {}) {
  if (mode === "setup") {
    return (
      <AppPageShell
        width="agent"
        data-testid="location-area"
        data-location-route="setup"
      >
        <AppPageContentRegion>
          <LocationSetupFlow mode="setup" />
        </AppPageContentRegion>
      </AppPageShell>
    );
  }
  return <WorkspaceArea />;
}
