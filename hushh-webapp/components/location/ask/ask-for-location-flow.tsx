"use client";

/**
 * `/one/location?action=ask&person=<user_id>` for the voice-first Location area.
 *
 * The person is resolved from server state -- a `?person=` id that is not a
 * connection is looked up through Connect and shown with the server's name,
 * never a spoken one. Not connected means an Invite CTA and no request; a
 * connected person gets a duration ladder and `requestAccess`. The status
 * shown afterwards is the request the server returned, not an assumption.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";

import {
  selectPendingOutgoingRequests,
  useLocationWorkspaceState,
} from "@/components/location/location-home";
import { useConnectedPeople } from "@/components/location/people/location-people";
import {
  DurationPresetPicker,
  REQUEST_DURATION_LADDER,
} from "@/components/one-location/redesign/duration-presets";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  LOCATION_VOICE_SCREEN_IDS,
  hrefForLocationAction,
} from "@/lib/location/screen-ids";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  CARD_SURFACE,
  MUTED_TEXT,
  SUBCARD_SURFACE,
} from "@/lib/morphy-ux/tokens/surfaces";
import {
  EmptyState,
  StatusPill,
  TaskFlowHeader,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { connectPersonReviewHref } from "@/lib/navigation/connect-routes";
import { ROUTES } from "@/lib/navigation/routes";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationAccessRequest,
  OneLocationRecipient,
} from "@/lib/one-location/types";
import {
  ConnectionsService,
  type ConnectionRelationship,
} from "@/lib/services/connections-service";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { cn } from "@/lib/utils";

export type AskPerson = {
  userId: string;
  /** Server-sent display name. */
  name: string;
  photoUrl: string | null;
  relationship: ConnectionRelationship;
  verified: boolean;
};

type ResolveStatus = "idle" | "loading" | "ready" | "not_found" | "error";

/** Stable empty list so an errored state does not re-run the lookup every render. */
const NO_RECIPIENTS: OneLocationRecipient[] = [];

function fromRecipient(recipient: OneLocationRecipient): AskPerson {
  return {
    userId: recipient.userId,
    name: recipient.displayName,
    photoUrl: recipient.photoUrl ?? null,
    relationship: "connected",
    verified: recipient.phoneVerified,
  };
}

/**
 * Resolve `?person=` to a person the server knows. Connections come from the
 * Location state; anyone else is asked of Connect, whose answer carries the
 * relationship that decides whether asking is even possible.
 */
export function useAskPerson(
  userId: string | null,
  recipients: OneLocationRecipient[] | null,
) {
  const { user } = useAuth();
  const [person, setPerson] = useState<AskPerson | null>(null);
  const [status, setStatus] = useState<ResolveStatus>(
    userId ? "loading" : "idle",
  );
  const ticketRef = useRef(0);
  // The Firebase user is only needed for the id token at lookup time; its
  // identity must not re-run the lookup.
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const connected = useMemo(
    () =>
      userId
        ? (recipients?.find((row) => row.userId === userId) ?? null)
        : null,
    [recipients, userId],
  );

  useEffect(() => {
    const ticket = ++ticketRef.current;
    if (!userId) {
      setPerson(null);
      setStatus("idle");
      return;
    }
    if (connected) {
      setPerson(fromRecipient(connected));
      setStatus("ready");
      return;
    }
    // Wait for the state before asking Connect, so a connected person is not
    // briefly shown as a stranger while the first load is in flight.
    if (recipients === null) {
      setStatus("loading");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const current = userRef.current;
        const idToken = current ? await current.getIdToken() : null;
        if (!idToken) throw new Error("Sign in again to look this person up.");
        const context = await ConnectionsService.getPersonContext({
          idToken,
          counterpartUserId: userId,
        });
        if (cancelled || ticket !== ticketRef.current) return;
        setPerson({
          userId: context.person.userId,
          name: context.person.displayName || "This person",
          photoUrl: context.person.photoUrl,
          relationship: context.person.relationship,
          verified: false,
        });
        setStatus("ready");
      } catch {
        if (cancelled || ticket !== ticketRef.current) return;
        setPerson(null);
        setStatus("not_found");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, recipients, userId]);

  return { person, status };
}

function requestStatusPill(request: OneLocationAccessRequest | null) {
  if (!request) return null;
  switch (request.status) {
    case "pending":
      return <StatusPill tone="pending">Waiting for their answer</StatusPill>;
    case "approved":
      return <StatusPill tone="live">Approved</StatusPill>;
    case "denied":
      return <StatusPill tone="neutral">Declined</StatusPill>;
    case "cancelled":
      return <StatusPill tone="neutral">Withdrawn</StatusPill>;
    case "expired":
      return <StatusPill tone="neutral">Expired</StatusPill>;
    default:
      return <StatusPill tone="neutral">{request.status}</StatusPill>;
  }
}

function PersonPicker({
  vaultOwnerToken,
  onPick,
}: {
  vaultOwnerToken: string | null;
  onPick: (userId: string) => void;
}) {
  const people = useConnectedPeople({ vaultOwnerToken });
  if (people.status === "loading" && !people.items.length) {
    return (
      <div className="flex items-center gap-2 px-1 py-4 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span className={MUTED_TEXT}>Loading your people</span>
      </div>
    );
  }
  if (people.status === "ready" && !people.items.length) {
    return (
      <EmptyState
        icon={<UserPlus className="h-6 w-6" aria-hidden="true" />}
        title="No one to ask yet"
        description="Location requests go to people you're connected with on One."
        action={
          <Button asChild className="min-h-11">
            <Link href={ROUTES.CONNECT}>Invite someone</Link>
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-2" role="list" aria-label="Choose who to ask">
      {people.items.map((recipient) => (
        <button
          key={recipient.userId}
          type="button"
          role="listitem"
          onClick={() => onPick(recipient.userId)}
          className={cn(
            SUBCARD_SURFACE,
            "flex min-h-[58px] w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[color:var(--app-card-surface-compact)]",
          )}
          data-testid="ask-person-option"
        >
          <ConnectionPersonAvatar
            label={recipient.displayName}
            photoUrl={recipient.photoUrl}
            verified={recipient.phoneVerified}
          />
          <span className="min-w-0 flex-1">
            <span className="ui-text-row-label block truncate">
              {recipient.displayName}
            </span>
          </span>
        </button>
      ))}
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
    </div>
  );
}

export function AskForLocationFlow({
  personId = null,
}: {
  personId?: string | null;
}) {
  const router = useRouter();
  const workspace = useLocationWorkspaceState();
  // Null until the state has settled, so a connected person is never shown
  // as a stranger during the first load; an error settles to "no one".
  const recipients =
    workspace.state?.recipients ??
    (workspace.status === "error" ? NO_RECIPIENTS : null);
  const { person, status } = useAskPerson(personId, recipients);

  const [duration, setDuration] = useState<string>("1");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sentRequest, setSentRequest] =
    useState<OneLocationAccessRequest | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const existing = useMemo(() => {
    if (!person) return null;
    return (
      selectPendingOutgoingRequests(workspace.state, workspace.userId).find(
        (request) => request.ownerUserId === person.userId,
      ) ?? null
    );
  }, [person, workspace.state, workspace.userId]);

  const currentRequest = existing ?? sentRequest;
  const connected = person?.relationship === "connected";
  const canRequest =
    workspace.state?.viewerCapabilities?.canRequestLocation !== false;

  usePublishVoiceSurfaceMetadata(
    useMemo(
      () => ({
        screenId: LOCATION_VOICE_SCREEN_IDS.ask,
        title: "Ask for location",
        purpose:
          "Ask a connected person to share their location with you for a while.",
        spokenSubject: "Location, Ask for location",
        screenState: {
          person_selected: Boolean(person),
          person_connected: person ? connected : null,
          request_status: currentRequest?.status ?? null,
          duration_hours: Number(duration) || null,
        },
      }),
      [connected, currentRequest?.status, duration, person],
    ),
  );

  const pickPerson = useCallback(
    (userId: string) => {
      router.replace(hrefForLocationAction("ask", { userId }), {
        scroll: false,
      });
    },
    [router],
  );

  const send = useCallback(async () => {
    if (
      !person ||
      !connected ||
      !workspace.vaultOwnerToken ||
      !workspace.userId
    )
      return;
    const hours = Number(duration);
    setSending(true);
    try {
      const request = await OneLocationService.requestAccess({
        vaultOwnerToken: workspace.vaultOwnerToken,
        ownerUserId: person.userId,
        message: message.trim() || undefined,
        requestedDurationHours: Number.isFinite(hours) && hours > 0 ? hours : 1,
        requestedDurationMode: "timed",
      });
      setSentRequest(request);
      OneLocationStateResource.invalidate(workspace.userId);
      await workspace.refresh({ invalidate: true });
      morphyToast.success(
        request.status === "approved"
          ? `${person.name} approved automatically.`
          : `Asked ${person.name}. You'll be told when they answer.`,
      );
    } catch (error) {
      morphyToast.error(
        error instanceof Error && error.message
          ? error.message
          : "The request could not be sent.",
      );
    } finally {
      setSending(false);
    }
  }, [connected, duration, message, person, workspace]);

  const withdraw = useCallback(async () => {
    if (!currentRequest || !workspace.vaultOwnerToken || !workspace.userId)
      return;
    setWithdrawing(true);
    try {
      const withdrawn = await OneLocationService.withdrawRequest({
        vaultOwnerToken: workspace.vaultOwnerToken,
        requestId: currentRequest.id,
      });
      OneLocationStateResource.mergeRequestStatus(workspace.userId, withdrawn);
      setSentRequest(withdrawn);
      await workspace.refresh({ invalidate: true });
      morphyToast.success("Request withdrawn.");
    } catch (error) {
      morphyToast.error(
        error instanceof Error && error.message
          ? error.message
          : "The request could not be withdrawn.",
      );
    } finally {
      setWithdrawing(false);
    }
  }, [currentRequest, workspace]);

  return (
    <section className="space-y-5" data-testid="ask-for-location-flow">
      <TaskFlowHeader
        eyebrow="Location"
        title="Ask for location"
        description={
          person
            ? `Ask ${person.name} to share where they are for a while.`
            : "Choose someone you're connected with."
        }
      />

      {!personId ? (
        <PersonPicker
          vaultOwnerToken={workspace.vaultOwnerToken}
          onPick={pickPerson}
        />
      ) : status === "loading" || status === "idle" ? (
        <div className="flex items-center gap-2 px-1 py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span className={MUTED_TEXT}>Finding them</span>
        </div>
      ) : status === "not_found" || !person ? (
        <EmptyState
          title="That person isn't available"
          description="They may have left One or the link is out of date."
          action={
            <Button asChild variant="outline" className="min-h-11">
              <Link href={hrefForLocationAction("ask")}>
                Choose someone else
              </Link>
            </Button>
          }
        />
      ) : !connected ? (
        <section
          className={cn(CARD_SURFACE, "space-y-4 p-5")}
          data-testid="ask-not-connected"
        >
          <div className="flex items-center gap-3">
            <ConnectionPersonAvatar
              label={person.name}
              photoUrl={person.photoUrl}
            />
            <div className="min-w-0 flex-1">
              <p className="ui-text-headline">
                You are not connected with {person.name} yet.
              </p>
              <p className={MUTED_TEXT}>
                {person.relationship === "pending_outgoing"
                  ? "Your connection request is waiting for their answer. Location requests open up once you're connected."
                  : person.relationship === "pending_incoming"
                    ? "They asked to connect with you. Accept in Connect, then you can ask for their location."
                    : "Location requests go between people who are connected on One. Invite them first."}
              </p>
            </div>
          </div>
          <Button asChild className="min-h-11 w-full sm:w-auto">
            <Link
              href={connectPersonReviewHref(person.userId)}
              data-testid="ask-invite-cta"
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              {person.relationship === "pending_incoming"
                ? "Open in Connect"
                : "Invite to connect"}
            </Link>
          </Button>
        </section>
      ) : (
        <section
          className={cn(CARD_SURFACE, "space-y-5 p-5")}
          data-testid="ask-connected"
        >
          <div className="flex items-center gap-3">
            <ConnectionPersonAvatar
              label={person.name}
              photoUrl={person.photoUrl}
              verified={person.verified}
            />
            <div className="min-w-0 flex-1">
              <p className="ui-text-row-label-emphasized truncate">
                {person.name}
              </p>
              <p className={MUTED_TEXT}>Connected</p>
            </div>
            {requestStatusPill(currentRequest)}
          </div>

          {currentRequest && currentRequest.status === "pending" ? (
            <div className="space-y-3" data-testid="ask-pending">
              <p className={MUTED_TEXT}>
                You already asked {person.name}
                {currentRequest.requestedDurationHours
                  ? ` for ${currentRequest.requestedDurationHours} ${currentRequest.requestedDurationHours === 1 ? "hour" : "hours"}`
                  : ""}
                . Nothing is visible until they approve.
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={withdrawing}
                onClick={() => void withdraw()}
              >
                {withdrawing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Withdraw request"
                )}
              </Button>
            </div>
          ) : currentRequest && currentRequest.status === "approved" ? (
            <div className="space-y-3" data-testid="ask-approved">
              <p className={MUTED_TEXT}>{person.name} is sharing with you.</p>
              <Button asChild className="min-h-11">
                <Link href={ROUTES.ONE_LOCATION_MAP}>Open the map</Link>
              </Button>
            </div>
          ) : (
            <>
              {!canRequest ? (
                <p className={MUTED_TEXT} data-testid="ask-needs-setup">
                  Finish Location setup before asking, so their location can be
                  delivered to you.
                </p>
              ) : null}
              <div className="space-y-2">
                <p
                  id="ask-duration-label"
                  className="ui-text-section-label px-1"
                >
                  For how long
                </p>
                <DurationPresetPicker
                  value={duration}
                  onChange={setDuration}
                  rungs={REQUEST_DURATION_LADDER}
                  allowUntilStop={false}
                  labelledBy="ask-duration-label"
                />
              </div>
              <label className="block space-y-2">
                <span className="ui-text-section-label px-1">
                  Add a note (optional)
                </span>
                <input
                  type="text"
                  value={message}
                  maxLength={200}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Where are you?"
                  className="min-h-11 w-full rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-3 text-[15px] text-[color:var(--app-label)] placeholder:text-[color:var(--app-tertiary-label)]"
                />
              </label>
              <Button
                type="button"
                className="min-h-11 w-full"
                disabled={sending || !canRequest || !workspace.vaultOwnerToken}
                onClick={() => void send()}
                data-testid="ask-send"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  `Ask ${person.name}`
                )}
              </Button>
              {currentRequest && currentRequest.status !== "pending" ? (
                <p className={MUTED_TEXT}>
                  Your last request was {currentRequest.status}. Asking again
                  sends a new one.
                </p>
              ) : null}
            </>
          )}
        </section>
      )}
    </section>
  );
}
