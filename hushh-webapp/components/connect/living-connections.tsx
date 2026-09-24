"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleDiscoveryCard } from "./circle-discovery-card";
import {
  EMPTY_CIRCLES_SNAPSHOT,
  findStarterCircle,
  type CircleStarter,
  type CircleStarterId,
  type ConnectCirclesSnapshot,
} from "./circle-discovery";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
import { OneLocationService } from "@/lib/one-location/service";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  CONNECT_CIRCLES_LIST_HREF,
  CONNECT_CIRCLE_ACTION_PARAM,
  CONNECT_CIRCLE_ID_PARAM,
} from "@/lib/navigation/connect-routes";
import { VaultContext } from "@/lib/vault/vault-context";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { trackEvent } from "@/lib/observability/client";
import { ROUTES } from "@/lib/navigation/routes";

type LivingConnectionsProps = {
  currentUserId: string | null;
  ownerName: string;
  ownerPhotoUrl?: string | null;
  connections: readonly ConnectionSummaryEntry[];
  totalCount: number;
  loading: boolean;
  error: boolean;
  circlesState: ConnectCirclesSnapshot;
  onFindPeople: () => void;
  onCreateCircle: () => void;
  onRetry: () => void;
  onRetryCircles: () => void;
};

/** The existing Circles tab owns the list and realtime subscription. This leaf
 * adds an explicit starter action through the same service and detail route. */
export function LivingConnections({
  currentUserId,
  circlesState,
  ...props
}: LivingConnectionsProps) {
  const router = useRouter();
  const vault = useContext(VaultContext);
  const token = vault?.vaultOwnerToken ?? null;
  const [creating, setCreating] = useState<CircleStarterId | null>(null);
  const inFlight = useRef(false);
  const session = useRef({ token, currentUserId });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    session.current = { token, currentUserId };
    inFlight.current = false;
    setCreating(null);
  }, [token, currentUserId]);

  const snapshot =
    token && currentUserId && circlesState.ownerId === currentUserId
      ? circlesState
      : { ...EMPTY_CIRCLES_SNAPSHOT, loading: Boolean(token) };
  const openCircle = (id: string) =>
    router.push(
      `${CONNECT_CIRCLES_LIST_HREF}&${CONNECT_CIRCLE_ACTION_PARAM}=circle-detail&${CONNECT_CIRCLE_ID_PARAM}=${encodeURIComponent(id)}`,
      { scroll: false },
    );

  const handleStarter = async (starter: CircleStarter) => {
    if (
      inFlight.current ||
      !token ||
      !currentUserId ||
      snapshot.loading ||
      snapshot.error ||
      !snapshot.available
    )
      return;
    const existing = findStarterCircle(snapshot.circles, starter);
    if (existing) {
      openCircle(existing.id);
      return;
    }
    // Held across navigation: fast taps cannot create a second named circle.
    inFlight.current = true;
    setCreating(starter.id);
    const isCurrent = () =>
      mounted.current &&
      session.current.token === token &&
      session.current.currentUserId === currentUserId;
    const operation =
      starter.id === "sms"
        ? OneLocationService.ensureSmsSystemCircle({ vaultOwnerToken: token })
        : OneLocationService.createNamedCircle({
            vaultOwnerToken: token,
            name: starter.name,
            kind: starter.kind,
          });
    void morphyToast.promise(operation, {
      loading: `Preparing ${starter.name}…`,
      success: () =>
        isCurrent()
          ? `${starter.name} is ready. Add your people next.`
          : "Circle saved.",
      error: (error) =>
        oneLocationErrorMessage(
          error,
          "Couldn't create your circle. Try again.",
        ),
    });
    let circle;
    try {
      circle = await operation;
    } catch {
      if (isCurrent()) {
        inFlight.current = false;
        setCreating(null);
      }
      // Only a failed mutation permits retry; a saved circle must not be duplicated.
      return;
    }
    if (!isCurrent()) return;
    try {
      CacheSyncService.onOneLocationStateMutated(
        currentUserId,
        ["workspace", "circles", "sms_roster"],
        { notificationType: "location_circle_created", circleId: circle.id },
      );
    } catch {
      // Cross-tab notification is best effort; detail still reads the saved circle.
    }
    try {
      trackEvent("one_location_circle_created", {
        route_id: "connect",
        result: "success",
        circle_kind: starter.kind,
      });
    } catch {
      /* Telemetry cannot undo a saved circle. */
    }
    openCircle(circle.id);
  };

  return (
    <CircleDiscoveryCard
      {...props}
      snapshot={snapshot}
      creating={creating}
      onUseStarter={(starter) => {
        void handleStarter(starter);
      }}
      onOpenCircle={openCircle}
      onSetupCircles={() => router.push(ROUTES.ONE_SETUP)}
    />
  );
}
