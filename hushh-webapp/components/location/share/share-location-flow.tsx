"use client";

/**
 * `/one/location?action=share[&person=<user_id>]` for the voice-first Location area.
 *
 * Pick connected people (server names only), pick a duration, share. The
 * first point is captured on this device, coarsened to the persisted
 * precision preference, encrypted for each recipient's key, and sent with
 * the grant (`createGrantWithEnvelope`); the same ciphertext is then stored
 * as the share's current envelope. A server refusal with
 * `LOCATION_SHARING_OFF` is explained with a Turn on control that uses the
 * same account-settings endpoint as the voice tools.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, UserPlus } from "@/components/icons";

import { useLocationWorkspaceState } from "@/components/location/location-home";
import {
  ConsentRequiredNotice,
  useSharingPostureControls,
  type LocationPrecisionFact,
} from "@/components/location/location-status-card";
import { useConnectedPeople } from "@/components/location/people/location-people";
import {
  ContactGroup,
  ContactRow,
} from "@/components/one-location/redesign/contact-picker/atoms";
import {
  DurationPresetPicker,
  SHARE_DURATION_LADDER,
  SHARE_DURATION_UNTIL_STOP_VALUE,
  compactDurationLabel,
} from "@/components/one-location/redesign/duration-presets";
import { Button } from "@/components/ui/button";
import { useLocationAccountSettings } from "@/lib/location/account-settings";
import { coarsenPoint } from "@/lib/location/coarsen";
import {
  LOCATION_VOICE_SCREEN_IDS,
  hrefForLocationAction,
} from "@/lib/location/screen-ids";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { CARD_SURFACE, MUTED_TEXT } from "@/lib/morphy-ux/tokens/surfaces";
import {
  EmptyState,
  StatusPill,
  TaskFlowHeader,
  WarningCard,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { ROUTES } from "@/lib/navigation/routes";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationEncryptedEnvelope,
  OneLocationGrant,
  OneLocationRecipient,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { apiErrorCode } from "@/lib/services/api-client";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { cn } from "@/lib/utils";

export const SHARING_OFF_CODE = "LOCATION_SHARING_OFF";

type ShareOutcome = {
  shared: OneLocationGrant[];
  failed: Array<{ recipient: OneLocationRecipient; error: unknown }>;
  sharingOff: boolean;
};

function newOperationId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `loc_share_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `loc_share_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Tag the ciphertext with the precision it was coarsened to; the server checks the tag. */
export function tagEnvelopePrecision(
  envelope: OneLocationEncryptedEnvelope,
  precision: LocationPrecisionFact,
): OneLocationEncryptedEnvelope {
  return {
    ...envelope,
    publicationContext: "private_foreground",
    metadata: { ...(envelope.metadata ?? {}), precision },
  };
}

function durationPayload(value: string): {
  durationHours?: number;
  durationMode: "timed" | "until_stopped";
} {
  if (value === SHARE_DURATION_UNTIL_STOP_VALUE)
    return { durationMode: "until_stopped" };
  const hours = Number(value);
  return {
    durationHours: Number.isFinite(hours) && hours > 0 ? hours : 1,
    durationMode: "timed",
  };
}

export function ShareLocationFlow({
  personId = null,
}: {
  personId?: string | null;
}) {
  const router = useRouter();
  const workspace = useLocationWorkspaceState();
  const account = useLocationAccountSettings();
  const people = useConnectedPeople({
    vaultOwnerToken: workspace.vaultOwnerToken,
  });

  const sharingState = account.settings?.sharing_state ?? "unset";
  const precision: LocationPrecisionFact =
    account.settings?.precision === "approximate" ? "approximate" : "precise";
  const sharingOff = sharingState === "off";
  const setupRequired = account.status === "ready" && sharingState === "unset";

  const controls = useSharingPostureControls();

  const [selected, setSelected] = useState<string[]>(() =>
    personId ? [personId] : [],
  );
  const [duration, setDuration] = useState<string>("1");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const preselectedRef = useRef(personId);

  useEffect(() => {
    if (personId && preselectedRef.current !== personId) {
      preselectedRef.current = personId;
      setSelected((current) =>
        current.includes(personId) ? current : [...current, personId],
      );
    }
  }, [personId]);

  const recipientsById = useMemo(() => {
    const map = new Map<string, OneLocationRecipient>();
    for (const row of people.items) map.set(row.userId, row);
    for (const row of workspace.state?.recipients ?? []) {
      if (!map.has(row.userId)) map.set(row.userId, row);
    }
    return map;
  }, [people.items, workspace.state?.recipients]);

  const selectedRecipients = useMemo(
    () =>
      selected
        .map((id) => recipientsById.get(id))
        .filter((row): row is OneLocationRecipient => Boolean(row)),
    [recipientsById, selected],
  );

  const readyRecipients = useMemo(
    () =>
      selectedRecipients.filter(
        (row) => row.canReceiveLocation && row.keyId && row.publicKeyJwk,
      ),
    [selectedRecipients],
  );

  usePublishVoiceSurfaceMetadata(
    useMemo(
      () => ({
        screenId: LOCATION_VOICE_SCREEN_IDS.share,
        title: "Share location",
        purpose:
          "Share your live location with connected people for a while or until you stop.",
        spokenSubject: "Location, Share location",
        screenState: {
          selected_count: selected.length,
          duration:
            duration === SHARE_DURATION_UNTIL_STOP_VALUE
              ? "until_stopped"
              : compactDurationLabel(duration),
          sharing_state: sharingState,
          precision,
        },
      }),
      [duration, precision, selected.length, sharingState],
    ),
  );

  const toggle = useCallback((userId: string, on: boolean) => {
    setOutcome(null);
    setSelected((current) =>
      on
        ? current.includes(userId)
          ? current
          : [...current, userId]
        : current.filter((id) => id !== userId),
    );
  }, []);

  const share = useCallback(async () => {
    const token = workspace.vaultOwnerToken;
    const userId = workspace.userId;
    if (!token || !userId || !readyRecipients.length) return;
    setBusy(true);
    setOutcome(null);
    try {
      let point: PlainLocationPoint;
      try {
        point = await OneLocationService.captureCurrentPosition({
          fresh: true,
        });
      } catch (error) {
        morphyToast.error(
          error instanceof Error && error.message
            ? error.message
            : "Your location couldn't be read. Check the device permission and try again.",
        );
        return;
      }
      const shared: OneLocationGrant[] = [];
      const failed: ShareOutcome["failed"] = [];
      let refusedOff = false;
      const sharePoint = coarsenPoint(point, precision);
      const confirmedAt = new Date().toISOString();
      const payload = durationPayload(duration);

      for (const recipient of readyRecipients) {
        if (refusedOff) break;
        try {
          const envelope = tagEnvelopePrecision(
            await encryptLocationForRecipient({
              point: sharePoint,
              recipientPublicKeyJwk: recipient.publicKeyJwk!,
              recipientKeyId: recipient.keyId!,
            }),
            precision,
          );
          const created = await OneLocationService.createGrantWithEnvelope({
            vaultOwnerToken: token,
            recipientUserId: recipient.userId,
            recipientKeyId: recipient.keyId!,
            ...payload,
            clientOperationId: newOperationId(),
            confirmedAt,
            envelope,
            shareKind: "share",
          });
          await OneLocationService.storeEnvelope({
            vaultOwnerToken: token,
            grantId: created.grant.id,
            envelope,
          });
          shared.push(created.grant);
        } catch (error) {
          if (apiErrorCode(error) === SHARING_OFF_CODE) {
            refusedOff = true;
            break;
          }
          failed.push({ recipient, error });
        }
      }

      OneLocationStateResource.invalidate(userId);
      await workspace.refresh({ invalidate: true });
      setOutcome({ shared, failed, sharingOff: refusedOff });

      if (refusedOff) {
        void account.refresh();
      } else if (shared.length && !failed.length) {
        morphyToast.success(
          shared.length === 1
            ? `Sharing with ${shared[0]?.recipientDisplayName || readyRecipients[0]?.displayName || "them"}.`
            : `Sharing with ${shared.length} people.`,
        );
      } else if (failed.length) {
        morphyToast.error(
          shared.length
            ? `Shared with ${shared.length}, but ${failed.length} didn't go through.`
            : "The share didn't go through.",
        );
      }
    } finally {
      setBusy(false);
    }
  }, [account, duration, precision, readyRecipients, workspace]);

  const notReady = selectedRecipients.length - readyRecipients.length;
  const showSharingOff = sharingOff || outcome?.sharingOff === true;

  return (
    <section className="space-y-5" data-testid="share-location-flow">
      <TaskFlowHeader
        eyebrow="Location"
        title="Share location"
        description="Choose who can see you and for how long. Your position is encrypted for them on this device."
      />

      {setupRequired ? (
        <EmptyState
          title="Set up Location first"
          description="Sharing needs your consent, device permission and a precision choice."
          action={
            <Button asChild className="min-h-11">
              <Link href={ROUTES.ONE_SETUP_LOCATION}>Set up Location</Link>
            </Button>
          }
        />
      ) : null}

      {showSharingOff ? (
        <section
          className={cn(CARD_SURFACE, "space-y-3 p-5")}
          data-testid="share-sharing-off"
        >
          <p className="ui-text-headline">Sharing with people is off</p>
          <p className={MUTED_TEXT}>
            Nothing can be shared while it's off. Turning it on allows shares
            again; it doesn't start one by itself.
          </p>
          <Button
            type="button"
            className="min-h-11"
            disabled={controls.disabled}
            onClick={() => void controls.turnOn()}
            data-testid="share-turn-on"
          >
            {controls.busy === "on" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Turn on"
            )}
          </Button>
          {controls.consentRequired ? (
            <ConsentRequiredNotice setupHref={ROUTES.ONE_SETUP_LOCATION} />
          ) : null}
        </section>
      ) : null}

      {outcome && !outcome.sharingOff && outcome.shared.length ? (
        <section
          className={cn(CARD_SURFACE, "space-y-3 p-5")}
          data-testid="share-outcome"
        >
          <div className="flex items-center gap-3">
            <p className="ui-text-headline flex-1">
              {outcome.shared.length === 1
                ? "Sharing now"
                : `Sharing with ${outcome.shared.length} people`}
            </p>
            <StatusPill tone="live">Live</StatusPill>
          </div>
          <ul className="space-y-1">
            {outcome.shared.map((grant) => (
              <li key={grant.id} className={MUTED_TEXT}>
                {grant.recipientDisplayName || "Someone"} ·{" "}
                {grant.durationMode === "until_stopped"
                  ? "until you stop"
                  : grant.durationHours
                    ? `for ${compactDurationLabel(String(grant.durationHours))}`
                    : "for a while"}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button asChild className="min-h-11">
              <Link href={hrefForLocationAction("active-shares")}>
                See active shares
              </Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11">
              <Link href={ROUTES.ONE_LOCATION_MAP}>Open the map</Link>
            </Button>
          </div>
        </section>
      ) : null}

      {outcome?.failed.length ? (
        <WarningCard
          title={`${outcome.failed.length} ${outcome.failed.length === 1 ? "share" : "shares"} didn't go through`}
          description={outcome.failed
            .map(
              (row) =>
                `${row.recipient.displayName}: ${
                  row.error instanceof Error && row.error.message
                    ? row.error.message
                    : "try again"
                }`,
            )
            .join(" · ")}
        />
      ) : null}

      <section className="space-y-3">
        <p id="share-people-label" className="ui-text-section-label px-1">
          Who can see you
        </p>
        {people.status === "loading" && !people.items.length ? (
          <div className="flex items-center gap-2 px-1 py-4 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span className={MUTED_TEXT}>Loading your people</span>
          </div>
        ) : people.status === "ready" && !people.items.length ? (
          <EmptyState
            icon={<UserPlus className="h-6 w-6" aria-hidden="true" />}
            title="No one to share with yet"
            description="Location sharing works between people who are connected on One."
            action={
              <Button asChild className="min-h-11">
                <Link href={ROUTES.CONNECT}>Invite someone</Link>
              </Button>
            }
          />
        ) : (
          <ContactGroup>
            {people.items.map((recipient) => (
              <ContactRow
                key={recipient.userId}
                label={recipient.displayName}
                photoUrl={recipient.photoUrl}
                verified={recipient.phoneVerified}
                subtitle={
                  recipient.canReceiveLocation
                    ? null
                    : "Hasn't finished Location setup"
                }
                fromContacts={recipient.connectedFromContacts}
                selected={selected.includes(recipient.userId)}
                busy={busy}
                ready={Boolean(
                  recipient.canReceiveLocation &&
                  recipient.keyId &&
                  recipient.publicKeyJwk,
                )}
                onAdd={() => toggle(recipient.userId, true)}
                onRemove={() => toggle(recipient.userId, false)}
              />
            ))}
          </ContactGroup>
        )}
        {people.hasMore ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full"
            disabled={people.status === "loading"}
            onClick={() => void people.loadMore()}
          >
            Show more
          </Button>
        ) : null}
      </section>

      <section className="space-y-2">
        <p id="share-duration-label" className="ui-text-section-label px-1">
          For how long
        </p>
        <DurationPresetPicker
          value={duration}
          onChange={setDuration}
          rungs={SHARE_DURATION_LADDER}
          allowUntilStop
          labelledBy="share-duration-label"
        />
        <p className={MUTED_TEXT}>
          {precision === "approximate"
            ? "They'll see an approximate area (~1 km). Change this in Settings."
            : "They'll see your precise position. Change this in Settings."}
        </p>
      </section>

      {notReady > 0 ? (
        <p className={MUTED_TEXT} data-testid="share-not-ready-note">
          {notReady === 1
            ? "One selected person hasn't finished Location setup and will be skipped."
            : `${notReady} selected people haven't finished Location setup and will be skipped.`}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() =>
            router.push(`${ROUTES.ONE_LOCATION}?view=now`, { scroll: false })
          }
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="min-h-11"
          disabled={
            busy ||
            setupRequired ||
            showSharingOff ||
            !readyRecipients.length ||
            !workspace.vaultOwnerToken
          }
          onClick={() => void share()}
          data-testid="share-submit"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : readyRecipients.length > 1 ? (
            `Share with ${readyRecipients.length} people`
          ) : readyRecipients.length === 1 ? (
            `Share with ${readyRecipients[0]?.displayName}`
          ) : (
            "Share"
          )}
        </Button>
      </div>
    </section>
  );
}
