"use client";

/**
 * `/one/location?action=sos` — Save My Soul.
 *
 * The screen shows the real emergency contacts (from the server's
 * `smsContactUserIds` joined to `recipients`), with each one's phone
 * verification and location key stated separately, and an honest empty state
 * when there are none. Send runs the canonical `runSosPanic` flow: one 8-hour
 * SOS share per ready contact, an encrypted PRECISE position (SOS ignores the
 * approximate preference, and the screen says so), then the email fallback.
 * Every per-contact line afterwards comes from real delivery results.
 *
 * Voice: the `trigger_save_my_soul` card is confirmed by tap elsewhere; while
 * it is up this screen says "Confirm on the card to send". A resolved
 * `sos_grants_created` only ARMS the alert. "Sent" appears only from the
 * server's `report_save_my_soul_delivery` verification, never from speech.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  PhoneCall,
  ShieldAlert,
  ShieldCheck,
  UserRoundPlus,
} from "@/components/icons";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { publishPointToGrants } from "@/lib/location/publisher";
import { hrefForLocationAction } from "@/lib/location/screen-ids";
import { useLocationSharingState } from "@/lib/location/sharing-state";
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
import { stopSosShares } from "@/lib/one-location/command-sos";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";
import { isSmsTriggeredGrant } from "@/lib/one-location/notifications";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import {
  clearSosIncident,
  loadSosIncident,
  reconcileSosIncident,
  saveSosIncident,
  type SosIncident,
} from "@/lib/one-location/sos-incident";
import {
  SosPanicError,
  isSosShareReadyRecipient,
  runSosPanic,
  selectSmsRecipients,
  type SosDeliveryOutcome,
} from "@/lib/one-location/sos-trigger";
import type {
  OneLocationRecipient,
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
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const SCREEN_ID = "one_location_sos";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);

const SOS_TOOLS = new Set([
  "get_save_my_soul_status",
  "trigger_save_my_soul",
  "stop_save_my_soul",
  "add_emergency_contact",
  "remove_emergency_contact",
]);

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

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) =>
      row && typeof row === "object"
        ? (row as { display_name?: unknown }).display_name
        : null,
    )
    .filter(
      (name): name is string =>
        typeof name === "string" && name.trim().length > 0,
    );
}

function formatNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Whether a contact can receive an encrypted position right now. */
export function contactHasKey(recipient: OneLocationRecipient): boolean {
  return Boolean(
    recipient.canReceiveLocation && recipient.keyId && recipient.publicKeyJwk,
  );
}

export type VoiceSosPhase =
  /** `sos_grants_created`: shares exist, no position yet. */
  | "armed"
  /** `report_save_my_soul_delivery` came back. */
  | "reported";

export type VoiceSos = {
  phase: VoiceSosPhase;
  armedNames: string[];
  delivered: string[];
  notAlerted: string[];
  reportStatus: "sos_sent" | "sos_partial" | "sos_not_sent" | null;
};

type TapDelivery = {
  outcomes: SosDeliveryOutcome[];
  emailed: number;
  withoutEmail: string[];
  skippedNotReady: string[];
};

type LoadStatus = "idle" | "loading" | "ready" | "error";

export function SaveMySoul() {
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const sharing = useLocationSharingState();
  const [state, setState] = useState<OneLocationState | null>(() =>
    userId ? OneLocationStateResource.readPresentation(userId) : null,
  );
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"send" | "stop" | null>(null);
  const [incident, setIncident] = useState<SosIncident | null>(() =>
    loadSosIncident(),
  );
  const [tapDelivery, setTapDelivery] = useState<TapDelivery | null>(null);
  const [voiceSos, setVoiceSos] = useState<VoiceSos | null>(null);
  const mountedRef = useRef(true);
  const armedGrantIdsRef = useRef<string[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pendingTrigger = useVoiceSessionSelector((session) =>
    session.pendingAction &&
    session.pendingAction.resolvedStatus === null &&
    (session.pendingAction.tool === "trigger_save_my_soul" ||
      session.pendingAction.tool === "stop_save_my_soul")
      ? session.pendingAction
      : null,
  );

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "Save My Soul",
          purpose:
            "Alert your emergency contacts with your precise live location for eight hours.",
          spokenSubject: "Location, Save My Soul",
          actions: VOICE_ACTIONS,
          availableActions: VOICE_ACTIONS.map((action) => action.label),
        }
      : null,
  );

  const load = useCallback(
    async (options?: { invalidate?: boolean }) => {
      if (!userId || !vaultOwnerToken) return null;
      if (options?.invalidate) OneLocationStateResource.invalidate(userId);
      setStatus((current) => (current === "ready" ? "ready" : "loading"));
      try {
        const next = await OneLocationStateResource.load(userId, () =>
          OneLocationService.getState(vaultOwnerToken),
        );
        if (!mountedRef.current) return next;
        setState(next);
        setError(null);
        setStatus("ready");
        return next;
      } catch (caught) {
        if (!mountedRef.current) return null;
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : "Couldn't load your emergency contacts.",
        );
        setStatus("error");
        return null;
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
      if (
        !keys.length ||
        keys.includes("location_sos") ||
        keys.includes("location_emergency_contacts")
      ) {
        void load({ invalidate: true });
      }
    };
    window.addEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
  }, [load]);

  /** Active SOS grants the server holds, whichever device created them. */
  const activeSosGrants = useMemo(() => {
    const now = Date.now();
    return (state?.ownerGrants ?? []).filter((grant) => {
      if (grant.status !== "active" || !isSmsTriggeredGrant(grant))
        return false;
      const expires = grant.expiresAt ? Date.parse(grant.expiresAt) : NaN;
      return !Number.isFinite(expires) || expires > now;
    });
  }, [state?.ownerGrants]);

  // Reconcile the device's incident record with what the server still holds.
  useEffect(() => {
    if (!state) return;
    const activeIds = activeSosGrants.map((grant) => grant.id);
    setIncident((current) => {
      const reconciled = reconcileSosIncident(current, activeIds);
      if (reconciled === null && current !== null) clearSosIncident();
      return reconciled;
    });
  }, [activeSosGrants, state]);

  const reflect = useCallback(
    (tool: string | null, result: ToolResultPublic | null) => {
      if (!result || typeof result.status !== "string") return;
      if (result.status === "sos_grants_created") {
        const grantIds = stringList(result.grant_ids);
        // The relay mirrors a confirmed action as both `pending_action.resolved`
        // and `tool.result`; the second frame is the same arming, not a new one.
        const sameArming =
          grantIds.length > 0 &&
          armedGrantIdsRef.current.length === grantIds.length &&
          armedGrantIdsRef.current.every((id, index) => id === grantIds[index]);
        if (sameArming) return;
        armedGrantIdsRef.current = grantIds;
        if (grantIds.length) {
          const next: SosIncident = {
            grantIds,
            startedAt: new Date().toISOString(),
          };
          saveSosIncident(next);
          setIncident(next);
        }
        setVoiceSos({
          phase: "armed",
          armedNames: namesOf(result.armed),
          delivered: [],
          notAlerted: [],
          reportStatus: null,
        });
        void load({ invalidate: true });
        return;
      }
      if (
        tool === "report_save_my_soul_delivery" ||
        result.status === "sos_sent" ||
        result.status === "sos_partial" ||
        result.status === "sos_not_sent"
      ) {
        const reportStatus =
          result.status === "sos_sent" ||
          result.status === "sos_partial" ||
          result.status === "sos_not_sent"
            ? result.status
            : null;
        setVoiceSos((current) => ({
          phase: "reported",
          armedNames: current?.armedNames ?? [],
          delivered: stringList(result.delivered),
          notAlerted: stringList(result.not_alerted),
          reportStatus,
        }));
        void load({ invalidate: true });
        return;
      }
      if (result.status === "sos_stopped") {
        armedGrantIdsRef.current = [];
        clearSosIncident();
        setIncident(null);
        setVoiceSos(null);
        void load({ invalidate: true });
        return;
      }
      if (NOT_SUCCESS_STATUSES.has(result.status)) return;
      const keys = Array.isArray(result.ui_refresh) ? result.ui_refresh : [];
      if (
        (tool !== null && SOS_TOOLS.has(tool)) ||
        keys.includes("location_sos") ||
        keys.includes("location_emergency_contacts")
      ) {
        void load({ invalidate: true });
      }
    },
    [load],
  );

  useVoiceToolEffects({
    onToolResult: (tool, result) => reflect(tool, result),
    onPendingResolved: (_id, resolved, result) => {
      if (resolved !== "executed") return;
      reflect(null, result);
    },
  });

  const contacts = useMemo(
    () =>
      selectSmsRecipients(state?.recipients ?? [], state?.smsContactUserIds),
    [state?.recipients, state?.smsContactUserIds],
  );
  const readyContacts = useMemo(
    () => contacts.filter(isSosShareReadyRecipient),
    [contacts],
  );
  const sosActive = incident !== null || activeSosGrants.length > 0;
  const osBlocked =
    sharing.os === "denied" ||
    sharing.os === "restricted" ||
    sharing.os === "unavailable";

  const send = useCallback(async () => {
    if (!vaultOwnerToken || !userId || busy || sosActive) return;
    if (!readyContacts.length) {
      morphyToast.error(
        contacts.length
          ? "None of your emergency contacts can receive an alert yet."
          : "Add an emergency contact before sending an alert.",
      );
      return;
    }
    const message =
      note.trim().slice(0, ONE_LOCATION_SHARE_NOTE_MAX_LENGTH) || null;
    setBusy("send");
    setTapDelivery(null);
    try {
      const point = await OneLocationService.captureCurrentPosition({
        fresh: true,
      }).catch(() => null);
      if (!point) {
        morphyToast.error(
          "Couldn't get your location — alert not sent. Check location permission.",
        );
        return;
      }
      const result = await runSosPanic({
        vaultOwnerToken,
        recipients: readyContacts,
        point,
        note: message,
        publish: async (grant, recipient, pt) => {
          // SOS always publishes the precise fix; the preference is ignored here.
          const published = await publishPointToGrants({
            point: pt,
            grants: [grant],
            recipientsByUserId: new Map([[recipient.userId, recipient]]),
            precision: "precise",
            sos: true,
            vaultOwnerToken,
            encrypt: encryptLocationForRecipient,
            store: (params) => OneLocationService.storeEnvelope(params),
          });
          const row = published.published[0];
          if (!row) {
            const failure = published.failures[0];
            throw new Error(
              failure?.reason
                ? `Couldn't reach ${recipient.displayName} (${failure.reason}).`
                : `Couldn't reach ${recipient.displayName}.`,
            );
          }
          return row.recipientAlerted;
        },
      });
      setIncident({ grantIds: result.grantIds, startedAt: result.startedAt });
      const mail = await OneLocationService.sendSosEmails({
        vaultOwnerToken,
        grantIds: result.grantIds,
        latitude: point.latitude,
        longitude: point.longitude,
        accuracyM: point.accuracyM ?? null,
        capturedAt: point.capturedAt,
        note: message,
      });
      if (!mountedRef.current) return;
      setTapDelivery({
        outcomes: result.delivery,
        emailed: mail.emailed,
        withoutEmail: mail.withoutEmail,
        skippedNotReady: contacts
          .filter(
            (contact) =>
              !readyContacts.some((ready) => ready.userId === contact.userId),
          )
          .map((contact) => contact.displayName),
      });
      const reached = result.delivery.filter(
        (outcome) => outcome.alerted !== false,
      ).length;
      if (reached === 0 && mail.emailed === 0) {
        morphyToast.error("Call emergency services now — nobody was alerted.");
      } else {
        morphyToast.success(
          `Alert sent to ${reached} of ${readyContacts.length} ${readyContacts.length === 1 ? "contact" : "contacts"}.`,
        );
      }
      setNote("");
      await load({ invalidate: true });
    } catch (caught) {
      if (caught instanceof SosPanicError && caught.partialIncident) {
        setIncident(caught.partialIncident);
      }
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Could not send the alert.",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [
    busy,
    contacts,
    load,
    note,
    readyContacts,
    sosActive,
    userId,
    vaultOwnerToken,
  ]);

  const stop = useCallback(async () => {
    if (!vaultOwnerToken || busy) return;
    const grantIds = Array.from(
      new Set([
        ...(incident?.grantIds ?? []),
        ...activeSosGrants.map((grant) => grant.id),
      ]),
    );
    if (!grantIds.length) {
      clearSosIncident();
      setIncident(null);
      return;
    }
    setBusy("stop");
    try {
      const outcome = await stopSosShares({
        grantIds,
        revoke: (grantId) =>
          OneLocationService.revokeGrant({ vaultOwnerToken, grantId }),
      });
      if (outcome.unresolved.length === 0) {
        clearSosIncident();
        setIncident(null);
        setVoiceSos(null);
        setTapDelivery(null);
        morphyToast.success(
          "Save My Soul stopped. Your live location is no longer shared.",
        );
      } else {
        const remaining: SosIncident = {
          grantIds: outcome.unresolved,
          startedAt: incident?.startedAt ?? new Date().toISOString(),
        };
        saveSosIncident(remaining);
        setIncident(remaining);
        morphyToast.warning(
          `${outcome.unresolved.length} ${outcome.unresolved.length === 1 ? "share is" : "shares are"} still live. Try again.`,
        );
      }
      await load({ invalidate: true });
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't stop the alert.",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [activeSosGrants, busy, incident, load, vaultOwnerToken]);

  return (
    <section className="space-y-5" data-testid="one-location-sos">
      <TaskFlowHeader
        eyebrow="Location"
        title="Save My Soul"
        description="Sends your precise live location to your emergency contacts for eight hours. It does not call emergency services."
      />

      {pendingTrigger ? (
        <div
          className={cn(SUBCARD_SURFACE, "p-3.5")}
          role="status"
          data-testid="sos-voice-pending"
        >
          <p className="ui-text-row-label-emphasized">
            Confirm on the card to send
          </p>
          <p className={MUTED_TEXT}>{pendingTrigger.summary}</p>
        </div>
      ) : null}

      {voiceSos ? (
        <div
          className={cn(SUBCARD_SURFACE, "space-y-1 p-3.5")}
          role="status"
          data-testid="sos-voice-state"
          data-phase={voiceSos.phase}
        >
          {voiceSos.phase === "armed" ? (
            <>
              <p className="ui-text-row-label-emphasized">
                Armed for{" "}
                {voiceSos.armedNames.length
                  ? formatNames(voiceSos.armedNames)
                  : "your contacts"}{" "}
                — sending your position…
              </p>
              <p className={MUTED_TEXT}>
                Not sent yet. This device is publishing your precise position
                now.
              </p>
            </>
          ) : (
            <>
              <p className="ui-text-row-label-emphasized">
                {voiceSos.reportStatus === "sos_sent"
                  ? `Sent to ${formatNames(voiceSos.delivered)}`
                  : voiceSos.reportStatus === "sos_partial"
                    ? `Sent to ${formatNames(voiceSos.delivered)}`
                    : "Not sent"}
              </p>
              {voiceSos.notAlerted.length ? (
                <p className={MUTED_TEXT}>
                  Not alerted: {formatNames(voiceSos.notAlerted)}.
                </p>
              ) : null}
              {voiceSos.reportStatus === "sos_not_sent" ? (
                <p className={MUTED_TEXT}>
                  Nobody received your position. Call emergency services now.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {sosActive ? (
        <div
          className={cn(CARD_SURFACE, "space-y-3 p-5")}
          data-testid="sos-active"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert
              className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--app-destructive)]"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="ui-text-row-label-emphasized">
                Save My Soul is active
              </p>
              <p className={MUTED_TEXT}>
                {activeSosGrants.length
                  ? `${activeSosGrants.length} live ${activeSosGrants.length === 1 ? "share" : "shares"} with your emergency contacts.`
                  : "Your emergency shares are being confirmed."}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => void stop()}
            data-testid="sos-stop"
          >
            {busy === "stop" ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <ShieldCheck className="h-4 w-4" aria-hidden />
            )}
            I&apos;m safe — stop sharing
          </Button>
        </div>
      ) : null}

      {tapDelivery ? (
        <div
          className={cn(SUBCARD_SURFACE, "space-y-2 p-3.5")}
          role="status"
          data-testid="sos-delivery"
        >
          <p className="ui-text-row-label-emphasized">What happened</p>
          <ul className="space-y-1">
            {tapDelivery.outcomes.map((outcome) => (
              <li
                key={outcome.userId}
                className="flex items-center gap-2"
                data-alerted={String(outcome.alerted)}
              >
                {outcome.alerted === false ? (
                  <AlertTriangle
                    className="h-4 w-4 shrink-0 text-[color:var(--app-warning)]"
                    aria-hidden
                  />
                ) : (
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-[color:var(--app-success)]"
                    aria-hidden
                  />
                )}
                <span className="ui-text-row-description">
                  {outcome.displayName}:{" "}
                  {outcome.alerted === true
                    ? "alerted"
                    : outcome.alerted === false
                      ? "not alerted (notifications off)"
                      : "position delivered"}
                </span>
              </li>
            ))}
          </ul>
          <p className={MUTED_TEXT}>
            {tapDelivery.emailed > 0
              ? `Emailed ${tapDelivery.emailed}.`
              : "No email went out."}
            {tapDelivery.withoutEmail.length
              ? ` No email on file for ${formatNames(tapDelivery.withoutEmail)}.`
              : ""}
            {tapDelivery.skippedNotReady.length
              ? ` Skipped ${formatNames(tapDelivery.skippedNotReady)} — not ready.`
              : ""}
          </p>
        </div>
      ) : null}

      {status === "loading" && !state ? (
        <div className="flex items-center gap-2 py-6" role="status">
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span className={MUTED_TEXT}>Loading your emergency contacts…</span>
        </div>
      ) : null}

      {status === "error" && !state ? (
        <EmptyState
          title="Couldn't load your emergency contacts"
          description={error ?? "Try again in a moment."}
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {state ? (
        <>
          <div className={cn(CARD_SURFACE, "space-y-3 p-4")}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="ui-text-section-title">Emergency contacts</h2>
              <Button asChild size="sm" variant="ghost">
                <Link href={hrefForLocationAction("sms-contacts")}>
                  <UserRoundPlus className="h-4 w-4" aria-hidden />
                  Manage
                </Link>
              </Button>
            </div>
            {contacts.length === 0 ? (
              <EmptyState
                icon={<PhoneCall className="h-6 w-6" aria-hidden />}
                title="No emergency contacts yet"
                description="Nobody would be alerted. Add at least one connected person with a verified phone."
                action={
                  <Button asChild size="sm">
                    <Link href={hrefForLocationAction("sms-contacts")}>
                      Add a contact
                    </Link>
                  </Button>
                }
              />
            ) : (
              <ul className="space-y-2" data-testid="sos-contacts">
                {contacts.map((contact) => {
                  const hasKey = contactHasKey(contact);
                  return (
                    <li
                      key={contact.userId}
                      className={cn(
                        SUBCARD_SURFACE,
                        "flex flex-wrap items-center gap-3 p-3",
                      )}
                      data-testid="sos-contact"
                    >
                      <AvatarBubble
                        initials={initialsFor(contact.displayName)}
                        imageUrl={contact.photoUrl}
                        size={36}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="ui-text-row-label-emphasized truncate">
                          {contact.displayName}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <StatusPill
                            tone={contact.phoneVerified ? "ready" : "pending"}
                          >
                            <PhoneCall className="h-3 w-3" aria-hidden />
                            {contact.phoneVerified
                              ? "Phone verified"
                              : "Phone not verified"}
                          </StatusPill>
                          <StatusPill tone={hasKey ? "ready" : "pending"}>
                            <KeyRound className="h-3 w-3" aria-hidden />
                            {hasKey ? "Has key" : "No key yet"}
                          </StatusPill>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className={cn(CARD_SURFACE, "space-y-3 p-4")}>
            <label className="ui-text-section-title block" htmlFor="sos-note">
              Message (optional)
            </label>
            <Textarea
              id="sos-note"
              value={note}
              maxLength={ONE_LOCATION_SHARE_NOTE_MAX_LENGTH}
              placeholder="Need help — come find me"
              rows={2}
              disabled={sosActive}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className={MUTED_TEXT}>
              {note.trim().length}/{ONE_LOCATION_SHARE_NOTE_MAX_LENGTH}
            </p>
          </div>

          <div className={cn(SUBCARD_SURFACE, "space-y-3 p-4")}>
            <p className={MUTED_TEXT}>
              {sharing.precision === "approximate"
                ? "Your precision setting is approximate, but Save My Soul always sends your precise position."
                : "Save My Soul always sends your precise position, whatever your precision setting."}
            </p>
            {osBlocked ? (
              <p className="ui-text-row-description text-[color:var(--app-destructive)]">
                Location permission is off on this device, so no position can be
                sent.
              </p>
            ) : null}
            <Button
              variant="destructive"
              className="w-full"
              disabled={
                busy !== null ||
                sosActive ||
                !vaultOwnerToken ||
                !readyContacts.length ||
                osBlocked ||
                pendingTrigger !== null
              }
              onClick={() => void send()}
              data-testid="sos-send"
            >
              {busy === "send" ? (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <ShieldAlert className="h-4 w-4" aria-hidden />
              )}
              {busy === "send"
                ? "Sending…"
                : readyContacts.length
                  ? `Send alert to ${readyContacts.length} ${readyContacts.length === 1 ? "contact" : "contacts"}`
                  : "Send alert"}
            </Button>
            {contacts.length > 0 && readyContacts.length < contacts.length ? (
              <p className={MUTED_TEXT}>
                {contacts.length - readyContacts.length} of your contacts
                can&apos;t receive an alert yet (phone not verified or no
                location key).
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
