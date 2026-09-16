"use client";

/**
 * `/one/location?view=people` for the voice-first Location area.
 *
 * Connected people come from `listRecipientsPage` (server names, photos,
 * relationship); pending requests in both directions come from the Location
 * state. A person with no connections sees an honest empty state that sends
 * them to Connect -- nothing here ever fabricates a request.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, UserPlus } from "lucide-react";

import {
  personInitials,
  selectPendingIncomingRequests,
  selectPendingOutgoingRequests,
  useLocationVoiceReconcile,
  useLocationWorkspaceState,
} from "@/components/location/location-home";
import {
  PersonRow,
  type PersonRowAction,
} from "@/components/location/people/person-row";
import { Button } from "@/components/ui/button";
import {
  LOCATION_VOICE_SCREEN_IDS,
  hrefForLocationAction,
} from "@/lib/location/screen-ids";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import {
  AvatarBubble,
  EmptyState,
  StatusPill,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { ROUTES } from "@/lib/navigation/routes";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationAccessRequest,
  OneLocationGrant,
  OneLocationRecipient,
} from "@/lib/one-location/types";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const PEOPLE_VOICE_ACTIONS = deriveLocationVoiceActions("one_location_people");

type RecipientsStatus = "idle" | "loading" | "ready" | "error";

/**
 * Connected people, one page at a time.
 *
 * Exported so the Ask and Share flows resolve a `?person=` the same way the
 * list does, against the same server projection.
 */
export function useConnectedPeople({
  vaultOwnerToken,
  query = "",
}: {
  vaultOwnerToken: string | null;
  query?: string;
}) {
  const [items, setItems] = useState<OneLocationRecipient[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [status, setStatus] = useState<RecipientsStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(
    async (nextPage: number, replace: boolean) => {
      if (!vaultOwnerToken) return;
      const ticket = ++requestRef.current;
      setStatus("loading");
      try {
        const result = await OneLocationService.listRecipientsPage({
          vaultOwnerToken,
          page: nextPage,
          limit: PAGE_SIZE,
          query: query.trim() || undefined,
        });
        if (ticket !== requestRef.current) return;
        setItems((current) =>
          replace ? result.items : [...current, ...result.items],
        );
        setPage(result.page);
        setHasMore(result.hasMore);
        setTotalCount(result.totalCount);
        setError(null);
        setStatus("ready");
      } catch (caught) {
        if (ticket !== requestRef.current) return;
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : "Your people could not be loaded.",
        );
        setStatus("error");
      }
    },
    [query, vaultOwnerToken],
  );

  useEffect(() => {
    void load(1, true);
  }, [load]);

  const refresh = useCallback(() => load(1, true), [load]);
  const loadMore = useCallback(() => load(page + 1, false), [load, page]);

  return { items, hasMore, totalCount, status, error, refresh, loadMore };
}

function relationshipLabel(recipient: OneLocationRecipient): string | null {
  const raw = recipient.relationshipType?.trim();
  if (!raw) return recipient.recommendationCategoryLabel?.trim() || null;
  return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, " ");
}

function rowStatusFor(
  recipient: OneLocationRecipient,
  ownerGrants: OneLocationGrant[],
  receivedGrants: OneLocationGrant[],
  outgoing: OneLocationAccessRequest[],
): { label: string; tone: "ready" | "pending" | "live" | "neutral" } | null {
  if (
    ownerGrants.some(
      (grant) =>
        grant.status === "active" && grant.recipientUserId === recipient.userId,
    )
  ) {
    return { label: "Sees you", tone: "live" };
  }
  if (
    receivedGrants.some(
      (grant) =>
        grant.status === "active" && grant.ownerUserId === recipient.userId,
    )
  ) {
    return { label: "Sharing with you", tone: "live" };
  }
  if (outgoing.some((request) => request.ownerUserId === recipient.userId)) {
    return { label: "Asked", tone: "pending" };
  }
  return null;
}

function RequestRow({
  name,
  photoUrl,
  detail,
  actions,
  testId,
}: {
  name: string;
  photoUrl?: string | null;
  detail: string;
  actions: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className={cn(
        SUBCARD_SURFACE,
        "flex min-h-[58px] flex-wrap items-center gap-3 px-3.5 py-2.5",
      )}
      data-testid={testId}
    >
      <AvatarBubble
        initials={personInitials(name)}
        imageUrl={photoUrl}
        size={36}
      />
      <div className="min-w-0 flex-1">
        <p className="ui-text-row-label truncate">{name}</p>
        <p className={cn(MUTED_TEXT, "truncate")}>{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

export function LocationPeople({
  focusedUserId = null,
}: {
  focusedUserId?: string | null;
}) {
  const router = useRouter();
  const workspace = useLocationWorkspaceState();
  const [query, setQuery] = useState("");
  const people = useConnectedPeople({
    vaultOwnerToken: workspace.vaultOwnerToken,
    query,
  });
  const [deciding, setDeciding] = useState<string | null>(null);

  useLocationVoiceReconcile({
    onLocationState: () => void people.refresh(),
  });

  const incoming = useMemo(
    () => selectPendingIncomingRequests(workspace.state, workspace.userId),
    [workspace.state, workspace.userId],
  );
  const outgoing = useMemo(
    () => selectPendingOutgoingRequests(workspace.state, workspace.userId),
    [workspace.state, workspace.userId],
  );
  const ownerGrants = workspace.state?.ownerGrants ?? [];
  const receivedGrants = workspace.state?.receivedGrants ?? [];

  const noConnections =
    people.status === "ready" && !query.trim() && people.items.length === 0;

  usePublishVoiceSurfaceMetadata(
    useMemo(
      () => ({
        screenId: LOCATION_VOICE_SCREEN_IDS.people,
        title: "People",
        purpose:
          "Your connections and pending location requests in both directions.",
        spokenSubject: "Location, People",
        activeTab: "people",
        actions: PEOPLE_VOICE_ACTIONS,
        availableActions: PEOPLE_VOICE_ACTIONS.map((action) => action.label),
        screenState: {
          connection_count: people.totalCount,
          pending_incoming: incoming.length,
          pending_outgoing: outgoing.length,
          no_connections: noConnections,
        },
        deadEnd: noConnections
          ? {
              reason:
                "You have no connections yet, so there is no one to share with or ask.",
              remedyActionId: "location.add_connections",
            }
          : null,
      }),
      [incoming.length, noConnections, outgoing.length, people.totalCount],
    ),
  );

  const onAction = useCallback(
    (action: PersonRowAction, userId: string) => {
      router.push(hrefForLocationAction(action, { userId }), { scroll: false });
    },
    [router],
  );

  const decide = useCallback(
    async (
      request: OneLocationAccessRequest,
      kind: "approve" | "deny" | "withdraw",
    ) => {
      if (!workspace.vaultOwnerToken || !workspace.userId) return;
      setDeciding(request.id);
      try {
        if (kind === "approve") {
          const approved = await OneLocationService.approveRequest({
            vaultOwnerToken: workspace.vaultOwnerToken,
            requestId: request.id,
            approvalMode: "manual",
          });
          OneLocationStateResource.mergeRequestStatus(
            workspace.userId,
            approved.request,
          );
          morphyToast.success(
            `${request.requesterDisplayName || "They"} can see your location now.`,
          );
        } else if (kind === "deny") {
          const denied = await OneLocationService.denyRequest({
            vaultOwnerToken: workspace.vaultOwnerToken,
            requestId: request.id,
          });
          OneLocationStateResource.mergeRequestStatus(workspace.userId, denied);
          morphyToast.success("Request declined.");
        } else {
          const withdrawn = await OneLocationService.withdrawRequest({
            vaultOwnerToken: workspace.vaultOwnerToken,
            requestId: request.id,
          });
          OneLocationStateResource.mergeRequestStatus(
            workspace.userId,
            withdrawn,
          );
          morphyToast.success("Request withdrawn.");
        }
        await workspace.refresh({ invalidate: true });
      } catch (error) {
        morphyToast.error(
          error instanceof Error && error.message
            ? error.message
            : "That didn't go through.",
        );
      } finally {
        setDeciding(null);
      }
    },
    [workspace],
  );

  return (
    <div className="space-y-6" data-testid="location-people">
      {incoming.length ? (
        <section className="space-y-2" data-testid="location-people-incoming">
          <p className="ui-text-section-label px-1">Waiting for you</p>
          {incoming.map((request) => (
            <RequestRow
              key={request.id}
              name={request.requesterDisplayName || "Someone"}
              photoUrl={request.requesterPhotoUrl}
              detail={
                request.requestedDurationHours
                  ? `Wants to see you for ${request.requestedDurationHours} ${request.requestedDurationHours === 1 ? "hour" : "hours"}`
                  : "Wants to see your location"
              }
              testId="location-people-incoming-row"
              actions={
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={deciding === request.id}
                    onClick={() => void decide(request, "deny")}
                  >
                    Deny
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11"
                    disabled={deciding === request.id}
                    onClick={() => void decide(request, "approve")}
                  >
                    {deciding === request.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Approve"
                    )}
                  </Button>
                </>
              }
            />
          ))}
        </section>
      ) : null}

      {outgoing.length ? (
        <section className="space-y-2" data-testid="location-people-outgoing">
          <p className="ui-text-section-label px-1">You asked</p>
          {outgoing.map((request) => (
            <RequestRow
              key={request.id}
              name={request.ownerDisplayName || "Someone"}
              photoUrl={request.ownerPhotoUrl}
              detail="Waiting for their answer"
              testId="location-people-outgoing-row"
              actions={
                <>
                  <StatusPill tone="pending">Pending</StatusPill>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={deciding === request.id}
                    onClick={() => void decide(request, "withdraw")}
                  >
                    {deciding === request.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Withdraw"
                    )}
                  </Button>
                </>
              }
            />
          ))}
        </section>
      ) : null}

      <section className="space-y-3" data-testid="location-people-connected">
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="ui-text-section-label">
            Connected
            {people.totalCount !== null && people.totalCount > 0
              ? ` · ${people.totalCount}`
              : ""}
          </p>
          <Button asChild variant="ghost" size="sm" className="min-h-11">
            <Link
              href={ROUTES.CONNECT}
              data-testid="location-people-invite-link"
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Invite
            </Link>
          </Button>
        </div>

        {noConnections ? (
          <EmptyState
            icon={<UserPlus className="h-6 w-6" aria-hidden="true" />}
            title="No one to share with yet"
            description="Location works between people who are connected on One. Invite someone and they show up here once you're connected."
            action={
              <Button asChild className="min-h-11">
                <Link
                  href={ROUTES.CONNECT}
                  data-testid="location-people-empty-invite"
                >
                  Invite someone
                </Link>
              </Button>
            }
          />
        ) : (
          <>
            {(people.totalCount ?? 0) > 8 || query ? (
              <label className="relative block">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name"
                  aria-label="Search your people"
                  className="min-h-11 w-full rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] pl-9 pr-3 text-[15px] text-[color:var(--app-label)] placeholder:text-[color:var(--app-tertiary-label)]"
                />
              </label>
            ) : null}

            {people.status === "loading" && !people.items.length ? (
              <div className="flex items-center gap-2 px-1 py-4 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span className={MUTED_TEXT}>Loading your people</span>
              </div>
            ) : people.status === "error" && !people.items.length ? (
              <EmptyState
                title="Your people couldn't load"
                description={people.error ?? undefined}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => void people.refresh()}
                  >
                    Try again
                  </Button>
                }
              />
            ) : people.items.length ? (
              <div className="space-y-2">
                {people.items.map((recipient) => (
                  <PersonRow
                    key={recipient.userId}
                    userId={recipient.userId}
                    name={recipient.displayName}
                    photoUrl={recipient.photoUrl}
                    relationship={relationshipLabel(recipient)}
                    verified={recipient.phoneVerified}
                    canReceiveLocation={recipient.canReceiveLocation}
                    status={rowStatusFor(
                      recipient,
                      ownerGrants,
                      receivedGrants,
                      outgoing,
                    )}
                    focused={focusedUserId === recipient.userId}
                    onAction={onAction}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No one matches"
                description="Try a different name."
              />
            )}

            {people.hasMore ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full"
                disabled={people.status === "loading"}
                onClick={() => void people.loadMore()}
              >
                {people.status === "loading" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Show more"
                )}
              </Button>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
