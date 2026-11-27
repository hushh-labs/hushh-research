"use client";

import { useCallback, useEffect, useState } from "react";

import { LocationChatActionCard } from "@/components/agent/location-chat-action/location-chat-action-card";
import { captureChatLocation } from "@/components/agent/location-chat-action/location-chat-permission";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import {
  LocationAccountSettingsResource,
  pauseLocationUpdates,
  resumeLocationUpdates,
} from "@/lib/location/account-settings";
import { coarsenPoint } from "@/lib/location/coarsen";
import { checkGeofenceArrivalNow } from "@/lib/location/geofence-monitor";
import { indexRecipientsByUserId } from "@/lib/location/publisher";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationActivityEvent,
  OneLocationEncryptedEnvelope,
  OneLocationGeofenceRule,
  OneLocationRecipient,
} from "@/lib/one-location/types";
import type { MainLocationProposal } from "@/lib/agent/main-chat-location-contract";

export function isE2eLocationAction(proposal: MainLocationProposal): boolean {
  if (proposal.action === "stop" && proposal.stopAll === true) return true;
  return (
    proposal.action === "pause_updates" ||
    proposal.action === "emergency_share" ||
    proposal.action === "sharing_history" ||
    proposal.action === "set_geofence" ||
    proposal.action === "manage_geofences" ||
    proposal.action === "block_location_peer"
  );
}

type Props = {
  proposal: MainLocationProposal;
  ownerId: string;
  token: string;
  vaultKey?: string | null;
  allowReview: boolean;
  onConversationText?: (text: string) => void;
};

function normalizeLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function formatDurationMinutes(hours: number): string {
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins} minutes`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${h}h ${rem}m` : h === 1 ? "1 hour" : `${h} hours`;
}

export function LocationChatE2eActions({
  proposal,
  ownerId,
  token,
  vaultKey,
  allowReview,
  onConversationText,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [pausedUntil, setPausedUntil] = useState<string | null>(null);
  const [historyEvents, setHistoryEvents] = useState<OneLocationActivityEvent[]>([]);
  const [rules, setRules] = useState<OneLocationGeofenceRule[]>([]);
  const [matchedPeers, setMatchedPeers] = useState<OneLocationRecipient[]>([]);
  const [resolvedPlace, setResolvedPlace] = useState<{
    placeLabel: string;
    placeKind: "public_place" | "saved_home";
    publicPlaceId?: string | null;
    publicLat?: number | null;
    publicLng?: number | null;
  } | null>(null);
  const [settled, setSettled] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const announce = useCallback(() => {
    OneLocationStateResource.invalidate(ownerId);
    CacheSyncService.onOneLocationStateMutated(ownerId, ["workspace"]);
    dispatchFeedStateChanged("arrived");
  }, [ownerId]);

  // 1. Instant actions: stopAll (US-022), pause_updates (US-030), emergency_share (US-031),
  //    sharing_history (US-033), manage_geofences (US-027/034).
  useEffect(() => {
    let active = true;
    async function runInitial() {
      setError(undefined);
      if (proposal.action === "stop" && proposal.stopAll) {
        if (!allowReview) return;
        setBusy(true);
        try {
          const result = await OneLocationService.revokeAllOwnerGrants({
            vaultOwnerToken: token,
            includeSos: false,
            includePublicLinks: true,
          });
          if (!active) return;
          announce();
          const total = result.revokedCount + result.revokedLinkIds.length;
          const msg =
            total === 0
              ? "No active location shares or public links were running."
              : `Stopped ${result.revokedCount} live ${result.revokedCount === 1 ? "share" : "shares"}${result.revokedLinkIds.length ? ` and ${result.revokedLinkIds.length} public ${result.revokedLinkIds.length === 1 ? "link" : "links"}` : ""}.`;
          setStatus(msg);
          setSettled(true);
          onConversationText?.(msg);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : "Could not stop location shares.");
        } finally {
          if (active) setBusy(false);
        }
        return;
      }

      if (proposal.action === "pause_updates") {
        if (!allowReview) return;
        setBusy(true);
        try {
          const hours = proposal.durationHours ?? 1;
          const updated = await pauseLocationUpdates(token, hours);
          if (!active) return;
          LocationAccountSettingsResource.write(ownerId, updated);
          setPausedUntil(updated.paused_until ?? null);
          const msg = updated.paused_until
            ? `Location updates paused for ${formatDurationMinutes(hours)} (auto-resumes at ${new Date(updated.paused_until).toLocaleTimeString()}). Active shares remain intact.`
            : `Location updates paused for ${formatDurationMinutes(hours)}.`;
          setStatus(msg);
          setSettled(true);
          onConversationText?.(msg);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : "Could not pause location updates.");
        } finally {
          if (active) setBusy(false);
        }
        return;
      }

      if (proposal.action === "emergency_share") {
        if (!allowReview) return;
        setBusy(true);
        try {
          let initialEnvelopes: Record<string, OneLocationEncryptedEnvelope> | undefined;
          try {
            const [{ point }, state] = await Promise.all([
              captureChatLocation(),
              OneLocationService.getState(token),
            ]);
            const precise = coarsenPoint(point, "precise", { sos: true });
            const byId = indexRecipientsByUserId(state.recipients);
            const built: Record<string, OneLocationEncryptedEnvelope> = {};
            const targetIds = [
              ...(state.smsContactUserIds ?? []),
              ...state.recipients.filter((r) => r.canReceiveLocation).map((r) => r.userId),
            ].slice(0, 25);
            await Promise.all(
              Array.from(new Set(targetIds)).map(async (uid) => {
                const rec = byId.get(uid);
                if (!rec?.keyId || !rec.publicKeyJwk) return;
                const enc = await encryptLocationForRecipient({
                  point: precise,
                  recipientKeyId: rec.keyId,
                  recipientPublicKeyJwk: rec.publicKeyJwk,
                });
                built[uid] = {
                  ...enc,
                  publicationContext: "foreground_map_visible",
                  metadata: { precision: "precise" },
                };
              }),
            );
            initialEnvelopes = built;
          } catch {
            // Still establish emergency grants even if initial GPS capture is delayed.
          }
          const result = await OneLocationService.startEmergencyOverride({
            vaultOwnerToken: token,
            initialEnvelopes,
            durationHours: 2.0,
          });
          if (!active) return;
          announce();
          const msg = `Emergency location sharing started with ${result.recipientCount} trusted ${result.recipientCount === 1 ? "contact" : "contacts"} for 2 hours.`;
          setStatus(msg);
          setSettled(true);
          onConversationText?.(msg);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : "Could not start emergency share.");
        } finally {
          if (active) setBusy(false);
        }
        return;
      }

      if (proposal.action === "sharing_history") {
        setBusy(true);
        try {
          const days = proposal.historyDays ?? 7;
          const range = days <= 7 ? "7d" : "30d";
          const activity = await OneLocationService.getActivity({
            vaultOwnerToken: token,
            range,
          });
          if (!active) return;
          setHistoryEvents((activity.events ?? []).slice(0, 12));
          setSettled(true);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : "Could not load location sharing history.");
        } finally {
          if (active) setBusy(false);
        }
        return;
      }

      if (proposal.action === "manage_geofences") {
        setBusy(true);
        try {
          const res = await OneLocationService.listGeofences({
            vaultOwnerToken: token,
            status: "armed",
          });
          if (!active) return;
          setRules(res.rules ?? []);
          setSettled(true);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : "Could not load arrival rules.");
        } finally {
          if (active) setBusy(false);
        }
        return;
      }

      if (proposal.action === "set_geofence" || proposal.action === "block_location_peer") {
        setBusy(true);
        try {
          const state = await OneLocationService.getState(token);
          if (!active) return;
          const wanted = (proposal.people ?? []).map(normalizeLabel);
          const peers = state.recipients.filter((rec) => {
            if (!wanted.length) return false;
            const norm = normalizeLabel(rec.displayName);
            return wanted.some((q) => norm === q || norm.startsWith(`${q} `) || norm.split(" ").includes(q));
          });
          setMatchedPeers(peers);

          if (proposal.action === "set_geofence") {
            const label = proposal.geofencePlace?.trim() || (proposal.geofencePlaceKind === "saved_home" ? "Home" : "");
            const isHome =
              proposal.geofencePlaceKind === "saved_home" ||
              normalizeLabel(label) === "home" ||
              normalizeLabel(label) === "my home";
            if (isHome) {
              setResolvedPlace({
                placeLabel: "Home",
                placeKind: "saved_home",
                publicPlaceId: null,
                publicLat: null,
                publicLng: null,
              });
            } else {
              let publicLat: number | null = null;
              let publicLng: number | null = null;
              let publicPlaceId: string | null = null;
              let displayLabel = label || "Destination";
              try {
                const { point } = await captureChatLocation();
                const nearby = await OneLocationService.nearbyPlaces({
                  vaultOwnerToken: token,
                  lat: point.latitude,
                  lng: point.longitude,
                  category: "all",
                });
                const needle = normalizeLabel(label);
                const first =
                  nearby.find(
                    (place) =>
                      normalizeLabel(place.name ?? place.text ?? "").includes(needle) &&
                      typeof place.latitude === "number" &&
                      typeof place.longitude === "number",
                  ) ??
                  nearby.find(
                    (place) =>
                      typeof place.latitude === "number" &&
                      typeof place.longitude === "number",
                  );
                if (first && typeof first.latitude === "number" && typeof first.longitude === "number") {
                  publicLat = first.latitude;
                  publicLng = first.longitude;
                  publicPlaceId = first.placeId ?? null;
                  displayLabel = first.name || first.text || displayLabel;
                }
              } catch {
                // Allow arming with label; user can trigger manually or on next fix.
              }
              if (!active) return;
              setResolvedPlace({
                placeLabel: displayLabel,
                placeKind: "public_place",
                publicPlaceId,
                publicLat,
                publicLng,
              });
            }
          }
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : "Could not prepare Location review.");
        } finally {
          if (active) setBusy(false);
        }
      }
    }
    void runInitial();
    return () => {
      active = false;
    };
  }, [allowReview, announce, onConversationText, ownerId, proposal, token]);

  if (dismissed) {
    return (
      <LocationChatActionCard
        model={{ phase: "result", title: "Location", status: "Cancelled" }}
      />
    );
  }

  // US-022: Stop all shares receipt
  if (proposal.action === "stop" && proposal.stopAll) {
    return (
      <LocationChatActionCard
        model={{
          phase: "result",
          title: "Stop all location sharing",
          status: status ?? (busy ? "Stopping all active shares…" : undefined),
          error,
        }}
        busy={busy}
      />
    );
  }

  // US-030: Timed pause receipt + Resume now button
  if (proposal.action === "pause_updates") {
    return (
      <LocationChatActionCard
        model={{
          phase: "result",
          title: "Location updates paused",
          status: status ?? (busy ? "Pausing location updates…" : undefined),
          endAt: pausedUntil ?? undefined,
          error,
          actions:
            settled && pausedUntil
              ? [{ id: "resume", label: "Resume now", variant: "primary" }]
              : undefined,
        }}
        busy={busy}
        onRecover={async (actionId, event) => {
          if (actionId !== "resume" || !event.nativeEvent.isTrusted) return;
          setBusy(true);
          setError(undefined);
          try {
            const next = await resumeLocationUpdates(token);
            LocationAccountSettingsResource.write(ownerId, next);
            setPausedUntil(null);
            setStatus("Location updates resumed.");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not resume location updates.");
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  // US-031: Emergency override active card + immediate Stop all
  if (proposal.action === "emergency_share") {
    return (
      <LocationChatActionCard
        model={{
          phase: settled ? "active" : "result",
          mode: "live",
          title: "Emergency location sharing",
          status: status ?? (busy ? "Starting emergency share…" : undefined),
          error,
          canStop: settled,
        }}
        busy={busy}
        onStop={async (event) => {
          if (!event.nativeEvent.isTrusted) return;
          setBusy(true);
          try {
            await OneLocationService.revokeAllOwnerGrants({
              vaultOwnerToken: token,
              includeSos: false,
              includePublicLinks: false,
            });
            announce();
            setSettled(false);
            setStatus("Emergency location sharing stopped.");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not stop emergency share.");
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  // US-033: Sharing history audit card
  if (proposal.action === "sharing_history") {
    const days = proposal.historyDays ?? 7;
    return (
      <LocationChatActionCard
        model={{
          phase: "result",
          title: `Location sharing history (last ${days} days)`,
          status: busy
            ? "Loading sharing history…"
            : historyEvents.length
              ? `${historyEvents.length} recent ${historyEvents.length === 1 ? "event" : "events"}`
              : "No location sharing activity in this period.",
          facts: historyEvents.slice(0, 6).map((evt) => ({
            label: new Date(evt.occurredAt).toLocaleDateString(),
            value: `${evt.title}${evt.detail ? ` — ${evt.detail}` : ""}`,
          })),
          error,
        }}
        busy={busy}
      />
    );
  }

  // US-027 / US-034: Manage armed arrival rules
  if (proposal.action === "manage_geofences") {
    if (!rules.length) {
      return (
        <LocationChatActionCard
          model={{
            phase: "result",
            title: "Arrival rules",
            status: busy ? "Loading arrival rules…" : "No armed arrival rules right now.",
            error,
          }}
          busy={busy}
        />
      );
    }
    return (
      <div className="space-y-2">
        {rules.map((rule) => (
          <LocationChatActionCard
            key={rule.id}
            model={{
              phase: "result",
              title:
                rule.triggerType === "stop_on_arrival"
                  ? `Stop sharing at ${rule.placeLabel}`
                  : `Share at ${rule.placeLabel}`,
              status:
                rule.triggerType === "stop_on_arrival"
                  ? "Armed · stops all active shares on arrival"
                  : `Armed · shares with ${rule.recipientNames.join(", ") || "selected contacts"}`,
              description:
                rule.placeKind === "saved_home"
                  ? "Home coordinates stay encrypted in your vault on this device."
                  : undefined,
              actions: [
                { id: "check_now", label: "Check arrival now", variant: "primary" },
                { id: "cancel_rule", label: "Cancel rule" },
              ],
              error,
            }}
            busy={busy}
            onRecover={async (actionId, event) => {
              if (!event.nativeEvent.isTrusted) return;
              setBusy(true);
              setError(undefined);
              try {
                if (actionId === "cancel_rule") {
                  await OneLocationService.cancelGeofence({
                    vaultOwnerToken: token,
                    ruleId: rule.id,
                  });
                  setRules((prev) => prev.filter((item) => item.id !== rule.id));
                } else if (actionId === "check_now") {
                  const res = await checkGeofenceArrivalNow({
                    rule,
                    userId: ownerId,
                    vaultKey: vaultKey ?? null,
                    vaultOwnerToken: token,
                  });
                  if (res.triggered) {
                    setRules((prev) => prev.filter((item) => item.id !== rule.id));
                    setStatus(`Triggered arrival rule for ${rule.placeLabel}.`);
                  } else {
                    setError(
                      res.distanceMeters != null
                        ? `You are about ${res.distanceMeters}m from ${rule.placeLabel} (triggers within ${rule.radiusMeters}m).`
                        : "Could not verify arrival coordinates yet.",
                    );
                  }
                }
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not update arrival rule.");
              } finally {
                setBusy(false);
              }
            }}
          />
        ))}
      </div>
    );
  }

  // US-027 / US-034: Arm a new arrival rule
  if (proposal.action === "set_geofence") {
    const triggerType = proposal.geofenceTrigger ?? "share_on_arrival";
    const placeLabel = resolvedPlace?.placeLabel || proposal.geofencePlace || "Destination";
    if (settled) {
      const armedRule = rules[0];
      return (
        <LocationChatActionCard
          model={{
            phase: "result",
            title:
              triggerType === "stop_on_arrival"
                ? `Auto-stop armed for ${placeLabel}`
                : `Arrival share armed for ${placeLabel}`,
            status: status ?? "Arrival rule armed.",
            description:
              resolvedPlace?.placeKind === "saved_home"
                ? "Home coordinates stay encrypted on your device and are never stored on our servers."
                : "Checks automatically when you return to the app or move nearby.",
            actions: armedRule
              ? [
                  { id: "check_now", label: "Check arrival now", variant: "primary" },
                  { id: "cancel_rule", label: "Cancel rule" },
                ]
              : undefined,
            error,
          }}
          busy={busy}
          onRecover={async (actionId, event) => {
            if (!event.nativeEvent.isTrusted || !armedRule) return;
            setBusy(true);
            setError(undefined);
            try {
              if (actionId === "cancel_rule") {
                await OneLocationService.cancelGeofence({
                  vaultOwnerToken: token,
                  ruleId: armedRule.id,
                });
                setRules([]);
                setStatus("Arrival rule cancelled.");
              } else if (actionId === "check_now") {
                const res = await checkGeofenceArrivalNow({
                  rule: armedRule,
                  userId: ownerId,
                  vaultKey: vaultKey ?? null,
                  vaultOwnerToken: token,
                });
                if (res.triggered) {
                  setRules([]);
                  setStatus(`Arrived at ${armedRule.placeLabel} — rule executed.`);
                } else {
                  setError(
                    res.distanceMeters != null
                      ? `About ${res.distanceMeters}m from ${armedRule.placeLabel} right now.`
                      : "Arrival not yet detected.",
                  );
                }
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not check arrival.");
            } finally {
              setBusy(false);
            }
          }}
        />
      );
    }

    const facts = [
      { label: "Destination", value: placeLabel },
      ...(triggerType === "share_on_arrival"
        ? [
            {
              label: "Share with",
              value:
                matchedPeers.map((p) => p.displayName).join(", ") ||
                (proposal.people ?? []).join(", ") ||
                "Select a connected contact",
            },
            {
              label: "Duration",
              value: formatDurationMinutes(proposal.durationHours ?? 1),
            },
          ]
        : [{ label: "Action", value: "Stop all active shares on arrival" }]),
    ];

    return (
      <LocationChatActionCard
        model={{
          phase: "review",
          title:
            triggerType === "stop_on_arrival"
              ? `Auto-stop sharing at ${placeLabel}`
              : `Share location on arrival at ${placeLabel}`,
          facts,
          description:
            resolvedPlace?.placeKind === "saved_home"
              ? "Your saved Home coordinates stay encrypted in your vault and are never sent to the server."
              : "Triggers automatically when you arrive while this app is active or reopened.",
          confirmLabel: "Arm arrival rule",
          error,
        }}
        busy={busy}
        onDismiss={() => setDismissed(true)}
        onConfirm={async (_, event) => {
          if (!event.nativeEvent.isTrusted) return;
          if (triggerType === "share_on_arrival" && matchedPeers.length === 0) {
            setError("No connected contact matched. Ask with the person’s exact connection name.");
            return;
          }
          setBusy(true);
          setError(undefined);
          try {
            const { rule } = await OneLocationService.createGeofence({
              vaultOwnerToken: token,
              triggerType,
              placeKind: resolvedPlace?.placeKind ?? "public_place",
              placeLabel,
              publicPlaceId: resolvedPlace?.publicPlaceId,
              publicLat: resolvedPlace?.publicLat,
              publicLng: resolvedPlace?.publicLng,
              recipientUserIds: matchedPeers.map((p) => p.userId),
              recipientNames: matchedPeers.map((p) => p.displayName),
              shareDurationHours: triggerType === "share_on_arrival" ? (proposal.durationHours ?? 1) : null,
              precision: proposal.precision ?? null,
            });
            setRules([rule]);
            setStatus(`Arrival rule armed for ${rule.placeLabel}.`);
            setSettled(true);
            announce();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not arm arrival rule.");
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  // US-037: Remove from trusted location sharing & block future location requests
  const targetPeer = matchedPeers[0];
  if (settled) {
    return (
      <LocationChatActionCard
        model={{
          phase: "result",
          title: "Location access blocked",
          status: status ?? "Removed from trusted location sharing.",
        }}
      />
    );
  }
  return (
    <LocationChatActionCard
      model={{
        phase: "review",
        title: "Remove from Location sharing",
        subject: { label: targetPeer?.displayName || proposal.people?.[0] || "Contact" },
        description:
          "Stops any active location shares, declines pending requests, and blocks future location requests from this person. Your other Hussh connections remain untouched.",
        confirmLabel: "Block location requests",
        confirmTone: "destructive",
        error,
      }}
      busy={busy}
      onDismiss={() => setDismissed(true)}
      onConfirm={async (_, event) => {
        if (!event.nativeEvent.isTrusted) return;
        if (!targetPeer) {
          setError("Could not find that contact in your Location connections.");
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const res = await OneLocationService.blockLocationPeer({
            vaultOwnerToken: token,
            blockedUserId: targetPeer.userId,
            reason: "removed_from_trusted_location_circle",
          });
          announce();
          setStatus(
            `${targetPeer.displayName} can no longer request your location (${res.revokedGrantIds.length} active ${res.revokedGrantIds.length === 1 ? "share" : "shares"} stopped).`,
          );
          setSettled(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not block location requests.");
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
