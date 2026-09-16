"use client";

/**
 * `/one/location?action=check-in&person=<user_id>` — a one-hour check-in with
 * your position and an optional note, to one connection.
 *
 * Two paths end on the same truth:
 *  - Tap: `runCheckIn` creates the grant and this screen publishes the
 *    encrypted position through `publishPointToGrants`, coarsened to the
 *    account's precision preference.
 *  - Voice: `create_check_in` answers `check_in_created` (NOT success — the
 *    server holds no position). The LocationPublisherBridge runs the
 *    `publish_location_envelopes` client step; this screen only reflects it,
 *    and says "Sent" only once the server's persisted grant carries an
 *    envelope. Nothing here is derived from transcript text.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, MapPinCheck, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { publishPointToGrants } from "@/lib/location/publisher";
import { coarsenPoint } from "@/lib/location/coarsen";
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
import { runCheckIn } from "@/lib/one-location/check-in-trigger";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import {
  isSosShareReadyRecipient,
  type SosShareReadyRecipient,
} from "@/lib/one-location/sos-trigger";
import type {
  OneLocationRecipient,
  OneLocationState,
} from "@/lib/one-location/types";
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

const SCREEN_ID = "one_location_check_in";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);
const CHECK_IN_HOURS = 1;

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

function stringField(
  result: ToolResultPublic | null,
  key: string,
): string | null {
  const value = result?.[key];
  return typeof value === "string" && value ? value : null;
}

export type VoiceCheckInPhase =
  /** The server created the grant; the device has not published yet. */
  | "armed"
  /** The publish client step is running on this device. */
  | "publishing"
  /** The server's persisted grant carries an envelope. */
  | "sent"
  /** The step finished but the server holds no envelope for the grant. */
  | "not_sent";

export type VoiceCheckIn = {
  grantId: string | null;
  displayName: string | null;
  note: string | null;
  phase: VoiceCheckInPhase;
  stepId: string | null;
};

export type CheckInFlowProps = {
  /** `?person=<user_id>`: the connection to check in with. */
  personId?: string | null;
  /** Alias of `personId` for callers that name it by the id type. */
  userId?: string | null;
};

type LoadStatus = "idle" | "loading" | "ready" | "error";

type TapOutcome = {
  displayName: string;
  grantId: string;
  published: boolean;
  reason: string | null;
};

export function CheckInFlow({
  personId = null,
  userId: personUserIdAlias = null,
}: CheckInFlowProps) {
  const personUserId = personId ?? personUserIdAlias;
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const sharing = useLocationSharingState();
  const [state, setState] = useState<OneLocationState | null>(() =>
    userId ? OneLocationStateResource.readPresentation(userId) : null,
  );
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(
    personUserId,
  );
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [tapOutcome, setTapOutcome] = useState<TapOutcome | null>(null);
  const [voiceCheckIn, setVoiceCheckIn] = useState<VoiceCheckIn | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (personUserId) setSelectedUserId(personUserId);
  }, [personUserId]);

  const pendingCheckIn = useVoiceSessionSelector((session) =>
    session.pendingAction &&
    session.pendingAction.tool === "create_check_in" &&
    session.pendingAction.resolvedStatus === null
      ? session.pendingAction
      : null,
  );
  const clientStep = useVoiceSessionSelector((session) => session.clientStep);

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "Check-In",
          purpose:
            "Send one person your position for an hour, with an optional note.",
          spokenSubject: "Location, Check-In",
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
            : "Couldn't load your people.",
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

  /** A `create_check_in` outcome from either frame kind. */
  const reflectCreated = useCallback((result: ToolResultPublic | null) => {
    if (!result || result.status !== "check_in_created") return;
    const grantId = stringField(result, "grant_id");
    setVoiceCheckIn((current) =>
      // The relay mirrors a confirmed action as both `pending_action.resolved`
      // and `tool.result`; the second frame must not rewind a grant already
      // past "armed".
      current && grantId !== null && current.grantId === grantId
        ? current
        : {
            grantId,
            displayName: stringField(result, "display_name"),
            note: stringField(result, "note"),
            phase: "armed",
            stepId: null,
          },
    );
  }, []);

  useVoiceToolEffects({
    onToolResult: (tool, result) => {
      if (tool === "create_check_in") reflectCreated(result);
      else if (
        !NOT_SUCCESS_STATUSES.has(result.status) &&
        Array.isArray(result.ui_refresh) &&
        result.ui_refresh.includes("location_active_shares")
      ) {
        void load({ invalidate: true });
      }
    },
    onPendingResolved: (_id, resolved, result) => {
      if (resolved !== "executed") return;
      reflectCreated(result);
    },
  });

  // The bridge owns the publish; this screen watches the step come and go.
  useEffect(() => {
    if (!voiceCheckIn) return;
    if (
      voiceCheckIn.phase === "armed" &&
      clientStep?.kind === "publish_location_envelopes"
    ) {
      const payload = clientStep.payload;
      const ids = Array.isArray(payload.grant_ids) ? payload.grant_ids : [];
      const matches =
        payload.purpose === "check_in" &&
        (voiceCheckIn.grantId === null || ids.includes(voiceCheckIn.grantId));
      if (matches) {
        setVoiceCheckIn({
          ...voiceCheckIn,
          phase: "publishing",
          stepId: clientStep.stepId,
        });
      }
      return;
    }
    if (
      voiceCheckIn.phase === "publishing" &&
      (clientStep === null || clientStep.stepId !== voiceCheckIn.stepId)
    ) {
      // The step was reported. "Sent" comes from the server's persisted grant.
      let cancelled = false;
      void load({ invalidate: true }).then((next) => {
        if (cancelled || !mountedRef.current) return;
        const grant = voiceCheckIn.grantId
          ? (next?.ownerGrants.find((row) => row.id === voiceCheckIn.grantId) ??
            null)
          : null;
        const published = Boolean(grant?.latestEnvelopeId);
        setVoiceCheckIn((current) =>
          current && current.stepId === voiceCheckIn.stepId
            ? {
                ...current,
                phase: published ? "sent" : "not_sent",
                stepId: null,
              }
            : current,
        );
      });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [clientStep, load, voiceCheckIn]);

  const readyRecipients = useMemo<SosShareReadyRecipient[]>(
    () => (state?.recipients ?? []).filter(isSosShareReadyRecipient),
    [state?.recipients],
  );
  const allRecipients = useMemo<OneLocationRecipient[]>(
    () =>
      (state?.recipients ?? []).slice().sort((a, b) => {
        const aReady = isSosShareReadyRecipient(a) ? 0 : 1;
        const bReady = isSosShareReadyRecipient(b) ? 0 : 1;
        if (aReady !== bReady) return aReady - bReady;
        return a.displayName.localeCompare(b.displayName);
      }),
    [state?.recipients],
  );
  const selected = useMemo(
    () =>
      readyRecipients.find(
        (recipient) => recipient.userId === selectedUserId,
      ) ?? null,
    [readyRecipients, selectedUserId],
  );
  const selectedNotReady = useMemo(
    () =>
      selectedUserId && !selected
        ? ((state?.recipients ?? []).find(
            (recipient) => recipient.userId === selectedUserId,
          ) ?? null)
        : null,
    [selected, selectedUserId, state?.recipients],
  );

  const send = useCallback(async () => {
    if (!vaultOwnerToken || !userId || !selected || sending) return;
    const message = note.trim().slice(0, ONE_LOCATION_SHARE_NOTE_MAX_LENGTH);
    setSending(true);
    setTapOutcome(null);
    try {
      const raw = await OneLocationService.captureCurrentPosition({
        fresh: true,
      });
      const point = {
        ...coarsenPoint(raw, sharing.precision),
        checkIn: message ? { message } : null,
      };
      const outcome: {
        publishedGrantId: string | null;
        failure: string | null;
      } = {
        publishedGrantId: null,
        failure: null,
      };
      const grantIds = await runCheckIn({
        vaultOwnerToken,
        recipients: [selected],
        point,
        durationHours: CHECK_IN_HOURS,
        note: message || null,
        publish: async (grant, recipient, pt) => {
          const result = await publishPointToGrants({
            point: pt,
            grants: [grant],
            recipientsByUserId: new Map([[recipient.userId, recipient]]),
            precision: sharing.precision,
            vaultOwnerToken,
            encrypt: encryptLocationForRecipient,
            store: (params) => OneLocationService.storeEnvelope(params),
          });
          if (result.published.length) outcome.publishedGrantId = grant.id;
          else {
            outcome.failure =
              result.failures[0]?.reason ??
              result.failures[0]?.code ??
              "not_published";
          }
        },
      });
      const grantId = grantIds[0] ?? outcome.publishedGrantId ?? "";
      const published = outcome.publishedGrantId !== null;
      if (mountedRef.current) {
        setTapOutcome({
          displayName: selected.displayName,
          grantId,
          published,
          reason: published ? null : outcome.failure,
        });
        setNote("");
      }
      if (published)
        morphyToast.success(`Checked in with ${selected.displayName}.`);
      else
        morphyToast.warning(
          `The check-in was created but your position didn't publish.`,
        );
      await load({ invalidate: true });
    } catch (caught) {
      morphyToast.error(
        caught instanceof Error && caught.message
          ? caught.message
          : "The check-in didn't go through.",
      );
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }, [
    load,
    note,
    selected,
    sending,
    sharing.precision,
    userId,
    vaultOwnerToken,
  ]);

  const pendingPersonName =
    pendingCheckIn?.entities.find((entity) => entity.kind === "person")
      ?.display_name ??
    pendingCheckIn?.entities.find((entity) => entity.kind === "person")?.name ??
    null;

  return (
    <section className="space-y-5" data-testid="one-location-check-in">
      <TaskFlowHeader
        eyebrow="Location"
        title="Check-In"
        description="One person sees where you are for an hour, with a note if you like."
      />

      {pendingCheckIn ? (
        <div
          className={cn(SUBCARD_SURFACE, "p-3.5")}
          role="status"
          data-testid="check-in-voice-pending"
        >
          <p className="ui-text-row-label-emphasized">
            Confirm on the card to send
          </p>
          <p className={MUTED_TEXT}>
            {pendingPersonName
              ? `Check-in with ${pendingPersonName}.`
              : pendingCheckIn.summary}
          </p>
        </div>
      ) : null}

      {voiceCheckIn ? (
        <div
          className={cn(SUBCARD_SURFACE, "flex items-start gap-3 p-3.5")}
          role="status"
          data-testid="check-in-voice-state"
          data-phase={voiceCheckIn.phase}
        >
          {voiceCheckIn.phase === "sent" ? (
            <CheckCircle2
              className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--app-success)]"
              aria-hidden
            />
          ) : voiceCheckIn.phase === "not_sent" ? (
            <MapPinCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <Loader2
              className="mt-0.5 h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="ui-text-row-label-emphasized">
              {voiceCheckIn.phase === "sent"
                ? `Sent to ${voiceCheckIn.displayName ?? "them"}`
                : voiceCheckIn.phase === "not_sent"
                  ? `Not sent yet to ${voiceCheckIn.displayName ?? "them"}`
                  : `Sending your position to ${voiceCheckIn.displayName ?? "them"}…`}
            </p>
            <p className={MUTED_TEXT}>
              {voiceCheckIn.phase === "sent"
                ? "They can see where you are for the next hour."
                : voiceCheckIn.phase === "not_sent"
                  ? "The check-in exists, but your position hasn't reached them. Check location permission and try again."
                  : voiceCheckIn.phase === "publishing"
                    ? "Encrypting your position on this device."
                    : "Waiting for this device to publish your position."}
            </p>
            {voiceCheckIn.note ? (
              <p className={MUTED_TEXT}>“{voiceCheckIn.note}”</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {status === "loading" && !state ? (
        <div className="flex items-center gap-2 py-6" role="status">
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span className={MUTED_TEXT}>Loading your people…</span>
        </div>
      ) : null}

      {status === "error" && !state ? (
        <EmptyState
          title="Couldn't load your people"
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
            <h2 className="ui-text-section-title">Who</h2>
            {allRecipients.length === 0 ? (
              <EmptyState
                icon={<UserRound className="h-6 w-6" aria-hidden />}
                title="No one to check in with"
                description="Connect with someone first. Check-ins go only to people you're connected with."
              />
            ) : (
              <ul
                className="space-y-1"
                role="radiogroup"
                aria-label="Check in with"
                data-testid="check-in-people"
              >
                {allRecipients.map((recipient) => {
                  const ready = isSosShareReadyRecipient(recipient);
                  const checked = recipient.userId === selectedUserId;
                  return (
                    <li key={recipient.userId}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        disabled={!ready}
                        onClick={() => setSelectedUserId(recipient.userId)}
                        className={cn(
                          "flex min-h-11 w-full items-center gap-3 rounded-[var(--app-card-radius-compact,16px)] px-2 py-2 text-left transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]",
                          checked && "bg-[color:var(--app-accent-tint)]",
                          !ready && "opacity-60",
                        )}
                      >
                        <AvatarBubble
                          initials={initialsFor(recipient.displayName)}
                          imageUrl={recipient.photoUrl}
                          size={32}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="ui-text-row-label-emphasized block truncate">
                            {recipient.displayName}
                          </span>
                          {!ready ? (
                            <span className={cn(MUTED_TEXT, "block")}>
                              {!recipient.phoneVerified
                                ? "Needs a verified phone"
                                : "Needs to open Location once"}
                            </span>
                          ) : null}
                        </span>
                        {ready ? (
                          <StatusPill tone="ready">Ready</StatusPill>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {selectedNotReady ? (
              <p className={MUTED_TEXT}>
                {selectedNotReady.displayName} can&apos;t receive a check-in
                yet.
              </p>
            ) : null}
          </div>

          <div className={cn(CARD_SURFACE, "space-y-3 p-4")}>
            <label
              className="ui-text-section-title block"
              htmlFor="check-in-note"
            >
              Note (optional)
            </label>
            <Textarea
              id="check-in-note"
              value={note}
              maxLength={ONE_LOCATION_SHARE_NOTE_MAX_LENGTH}
              placeholder="Home safe"
              rows={2}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className={MUTED_TEXT}>
              {note.trim().length}/{ONE_LOCATION_SHARE_NOTE_MAX_LENGTH} · The
              note travels encrypted with your position.
            </p>
          </div>

          <div
            className={cn(SUBCARD_SURFACE, "space-y-3 p-4")}
            data-testid="check-in-review"
          >
            <p className={MUTED_TEXT}>
              {selected
                ? `${selected.displayName} sees your ${sharing.precision === "approximate" ? "approximate area" : "position"} for ${CHECK_IN_HOURS} hour.`
                : "Pick someone above."}
            </p>
            <Button
              disabled={!selected || sending || !vaultOwnerToken}
              onClick={() => void send()}
              data-testid="check-in-send"
            >
              {sending ? (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <MapPinCheck className="h-4 w-4" aria-hidden />
              )}
              {sending ? "Sending…" : "Send check-in"}
            </Button>
          </div>

          {tapOutcome ? (
            <div
              className={cn(SUBCARD_SURFACE, "flex items-start gap-3 p-3.5")}
              role="status"
              data-testid="check-in-outcome"
              data-published={tapOutcome.published ? "true" : "false"}
            >
              {tapOutcome.published ? (
                <CheckCircle2
                  className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--app-success)]"
                  aria-hidden
                />
              ) : (
                <MapPinCheck
                  className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              )}
              <div>
                <p className="ui-text-row-label-emphasized">
                  {tapOutcome.published
                    ? `Sent to ${tapOutcome.displayName}`
                    : `Not sent to ${tapOutcome.displayName}`}
                </p>
                <p className={MUTED_TEXT}>
                  {tapOutcome.published
                    ? "They can see where you are for the next hour."
                    : tapOutcome.reason
                      ? `Your position didn't publish (${tapOutcome.reason}).`
                      : "Your position didn't publish."}
                </p>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
