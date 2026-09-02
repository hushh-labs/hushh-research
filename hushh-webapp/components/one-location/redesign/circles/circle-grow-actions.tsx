"use client";

/**
 * CircleGrowActions — reusable "grow this Circle" affordance.
 *
 * Surfaces the two consent-preserving ways to add loved ones to a named Circle
 * *in context* (Check-In, SMS contacts, the share composer, …) instead of only
 * from the Circle detail screen:
 *   1. Invite an existing connection (targeted member invite they must accept).
 *   2. Share the 12-character Circle code via the native/web share sheet.
 *
 * PRESENTATION + LOCAL SELECTION STATE ONLY. Every network mutation is delegated
 * to the injected handlers, which are the exact same page/view-model callbacks
 * used by the Circle detail flow. No new crypto, grants, or consent surfaces are
 * introduced here — joining a Circle stays relationship-consent only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Search, Send, Share2, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { EmptyState } from "@/components/one-location/redesign/primitives";
import { LOCATION_SEARCH_INPUT_CLASSNAME } from "@/components/one-location/redesign/selectors";
import type {
  OneLocationCircleEligibleConnection,
  OneLocationCircleEligibleConnections,
  OneLocationCircleEligibleConnectionsPage,
  OneLocationCircleMemberInvite,
} from "@/lib/one-location/types";
import {
  filterPeopleByQuery,
  sortPeopleByName,
} from "@/lib/one-location/people-search";
import { BLOCKED_CTA } from "@/components/one-location/redesign/circles/blocked-cta";
import { cn } from "@/lib/utils";
import { ContactSourceBadge } from "@/components/connections/contact-source-badge";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import {
  CIRCLE_INVITE_BATCH_LIMIT,
  circleInviteSelectionLimit,
} from "@/lib/one-location/circle-invite-contract";

function growErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

/**
 * Self-contained "Add people" bottom sheet. Mirrors the Circle detail sheet but
 * owns its own eligibility/selection state so it can be embedded anywhere.
 */
export function CircleInvitePeopleSheet({
  open,
  onOpenChange,
  circleId,
  circleName,
  busy,
  onLoadEligibleConnections,
  onLoadEligibleConnectionsPage,
  onInviteConnections,
  onCancelMemberInvite,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  circleId: string;
  circleName: string;
  busy?: boolean;
  onLoadEligibleConnections: (
    circleId: string,
  ) => Promise<OneLocationCircleEligibleConnections>;
  onLoadEligibleConnectionsPage?: (
    circleId: string,
    options: { page: number; limit: number; query?: string },
  ) => Promise<OneLocationCircleEligibleConnectionsPage>;
  onInviteConnections: (
    circleId: string,
    inviteeUserIds: string[],
  ) => Promise<void>;
  onCancelMemberInvite: (inviteId: string) => Promise<void>;
  onInvited?: () => void;
}) {
  const [eligibleConnections, setEligibleConnections] = useState<
    OneLocationCircleEligibleConnection[]
  >([]);
  const [pendingInvites, setPendingInvites] = useState<
    OneLocationCircleMemberInvite[]
  >([]);
  const [remainingCapacity, setRemainingCapacity] = useState(0);
  const selectionLimit = circleInviteSelectionLimit(remainingCapacity);
  const [search, setSearch] = useState("");
  const [selectedConnections, setSelectedConnections] = useState<
    Map<string, OneLocationCircleEligibleConnection>
  >(() => new Map());
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingInviteId, setCancellingInviteId] = useState<string | null>(
    null,
  );
  const requestRef = useRef(0);
  const submitInFlightRef = useRef(false);
  const cancelInFlightRef = useRef(false);

  const filtered = useMemo(
    () =>
      // Sorted before filtering, like every other people picker in Location.
      // These two sheets were rendering whatever order the server returned, so
      // the same two connections could swap places between two openings and a
      // long list had nowhere to start looking.
      onLoadEligibleConnectionsPage
        ? eligibleConnections
        : filterPeopleByQuery(
            sortPeopleByName(
              eligibleConnections,
              (connection) => connection.displayName,
            ),
        search,
        (connection) => connection.displayName,
      ),
    [eligibleConnections, onLoadEligibleConnectionsPage, search],
  );

  const load = useCallback(
    async ({
      requestedPage = 1,
      append = false,
      query = search,
    }: { requestedPage?: number; append?: boolean; query?: string } = {}) => {
    const requestId = ++requestRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
    setLoadError(null);
    try {
        const result = onLoadEligibleConnectionsPage
          ? await onLoadEligibleConnectionsPage(circleId, {
              page: requestedPage,
              limit: 50,
              query: query.trim() || undefined,
            })
          : await onLoadEligibleConnections(circleId);
      if (requestId !== requestRef.current) return;
        setEligibleConnections((current) => {
          if (!append) return result.eligibleConnections;
          const byUserId = new Map(current.map((row) => [row.userId, row]));
          for (const row of result.eligibleConnections)
            byUserId.set(row.userId, row);
          return [...byUserId.values()];
        });
      setPendingInvites(result.pendingInvites);
      setRemainingCapacity(result.remainingCapacity);
        const pagedResult = onLoadEligibleConnectionsPage
          ? (result as OneLocationCircleEligibleConnectionsPage)
          : null;
        setPage(pagedResult?.page ?? 1);
        setHasMore(pagedResult?.hasMore ?? false);
        setSelectedConnections(
          (current) =>
            new Map(
              [...current].slice(
                0,
                circleInviteSelectionLimit(result.remainingCapacity),
              ),
            ),
        );
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setLoadError(
        growErrorMessage(error, "Could not load your connections."),
      );
    } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
    }
    },
    [
      circleId,
      onLoadEligibleConnections,
      onLoadEligibleConnectionsPage,
      search,
    ],
  );

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelectedConnections(new Map());
    void load();
    return () => {
      requestRef.current += 1;
    };
    // Initial open only. Paged search changes are handled by the debounced
    // effect below without resetting the person's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circleId, open]);

  useEffect(() => {
    if (!open || !onLoadEligibleConnectionsPage) return;
    const timer = window.setTimeout(() => void load({ query: search }), 250);
    return () => window.clearTimeout(timer);
  }, [load, onLoadEligibleConnectionsPage, open, search]);

  const sendInvites = async () => {
    if (submitInFlightRef.current || !selectedConnections.size) return;
    const inviteeUserIds = [...selectedConnections.keys()].slice(
      0,
      selectionLimit,
    );
    if (!inviteeUserIds.length) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      await onInviteConnections(circleId, inviteeUserIds);
      toast.success(
        inviteeUserIds.length === 1
          ? "Circle invitation sent."
          : `${inviteeUserIds.length} Circle invitations sent.`,
      );
      setSelectedConnections(new Map());
      onInvited?.();
      await load();
    } catch (error) {
      toast.error(growErrorMessage(error, "Could not send the invitation."));
      // Do not reconcile selected ids against one partial page. A failed
      // mutation can mean eligibility/capacity changed, so clear the stale
      // authority and reload a fresh bounded page.
      setSelectedConnections(new Map());
      await load();
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const cancelInvite = async (inviteId: string) => {
    if (cancelInFlightRef.current) return;
    cancelInFlightRef.current = true;
    setCancellingInviteId(inviteId);
    try {
      await onCancelMemberInvite(inviteId);
      toast.success("Circle invitation cancelled.");
      await load();
    } catch (error) {
      toast.error(growErrorMessage(error, "Could not cancel the invitation."));
    } finally {
      cancelInFlightRef.current = false;
      setCancellingInviteId(null);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          requestRef.current += 1;
          setSearch("");
          setSelectedConnections(new Map());
        }
      }}
    >
      <SheetContent
        side="bottom"
        // Same pair as the Circle detail sheet: keep the drag gesture off a
        // scrollable list, and keep the keyboard height inside the max-height
        // so the search field does not leave the screen when the keyboard opens.
        dragDismiss={false}
        className="mx-auto flex max-h-[calc(88dvh-var(--kb-height,0px))] w-full max-w-2xl flex-col rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6"
      >
        <SheetHeader className="text-left">
          <SheetTitle>Add people to {circleName}</SheetTitle>
          <SheetDescription>
            Choose existing connections. They join only after accepting the
            Circle invitation; no second Connect request is needed.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
          <label className="relative block">
            <span className="sr-only">Search connections</span>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search connections"
              className={cn(
                LOCATION_SEARCH_INPUT_CLASSNAME,
                "h-12 rounded-full bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70",
              )}
            />
          </label>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {loading ? (
              <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                Loading connections…
              </div>
            ) : loadError ? (
              <div className="space-y-3 rounded-2xl bg-muted/45 p-4">
                <p className="text-sm text-muted-foreground">{loadError}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void load()}
                  className="h-11 rounded-full"
                >
                  Retry
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {remainingCapacity > 0 && filtered.length ? (
                  <SettingsGroup
                    title="Your connections"
                    description={
                      remainingCapacity > CIRCLE_INVITE_BATCH_LIMIT
                        ? `Invite up to ${CIRCLE_INVITE_BATCH_LIMIT} people at a time. ${remainingCapacity} Circle slots remain.`
                        : remainingCapacity === 1
                        ? "You can invite 1 more person right now."
                        : `You can invite ${remainingCapacity} more people right now.`
                    }
                    testId="one-location-circle-grow-eligible-connections"
                  >
                    {filtered.map((connection) => {
                      const selected = selectedConnections.has(
                        connection.userId,
                      );
                      const atCapacity =
                        selectedConnections.size >= selectionLimit;
                      return (
                        <SettingsRow
                          key={connection.userId}
                          leading={
                            <ConnectionPersonAvatar
                              photoUrl={connection.photoUrl ?? null}
                              label={connection.displayName}
                              verified={Boolean(connection.isRia)}
                            />
                          }
                          title={
                            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
                                {connection.displayName}
                              </span>
                              {connection.connectedFromContacts ? (
                                <ContactSourceBadge />
                              ) : null}
                            </span>
                          }
                          description="Connected on One"
                          ariaPressed={selected}
                          ariaLabel={`${selected ? "Deselect" : "Select"} ${connection.displayName} for Circle invitation${connection.connectedFromContacts ? ", connected from your contacts" : ""}`}
                          disabled={!selected && atCapacity}
                          trailing={
                            <span
                              className={cn(
                                "flex h-6 w-6 items-center justify-center rounded-full border",
                                selected
                                  ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                                  : "border-border bg-background",
                              )}
                            >
                              {selected ? <Check className="h-4 w-4" /> : null}
                            </span>
                          }
                          onClick={() =>
                            setSelectedConnections((current) => {
                              const next = new Map(current);
                              if (next.has(connection.userId)) {
                                next.delete(connection.userId);
                              } else if (next.size < selectionLimit) {
                                next.set(connection.userId, connection);
                              }
                              return next;
                            })
                          }
                          testId={`one-location-circle-grow-eligible-${connection.userId}`}
                        />
                      );
                    })}
                  </SettingsGroup>
                ) : (
                  <EmptyState
                    title={
                      remainingCapacity === 0
                        ? "No invitation slots available"
                        : search.trim()
                          ? "No matching connections"
                          : "No connections to add"
                    }
                    description={
                      remainingCapacity === 0
                        ? "Circle is full."
                        : search.trim()
                          ? "Try a different name."
                          : "Add someone in Connect first."
                    }
                  />
                )}

                {hasMore && !loading ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loadingMore}
                    isLoading={loadingMore}
                    onClick={() =>
                      void load({ requestedPage: page + 1, append: true })
                    }
                    className="h-11 w-full rounded-full"
                  >
                    Load more connections
                  </Button>
                ) : null}

      {pendingInvites.length ? (
        <SettingsGroup
          title="Pending invitations"
          description="Cancel anytime before acceptance."
        >
                    {pendingInvites.map((invite) => (
                      <SettingsRow
                        key={invite.id}
                        icon={Send}
                        // Awaiting acceptance is PENDING, not an action.
                        iconTone="orange"
                        title={invite.inviteeDisplayName || "One connection"}
                        description="Waiting for them to join"
                        trailing={
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={Boolean(cancellingInviteId)}
                            isLoading={cancellingInviteId === invite.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              void cancelInvite(invite.id);
                            }}
                            className="h-11 rounded-full px-3 text-destructive hover:text-destructive"
                          >
                            Cancel
                          </Button>
                        }
                      />
                    ))}
                  </SettingsGroup>
                ) : null}
              </div>
            )}
          </div>

          <Button
            type="button"
            disabled={
              !selectedConnections.size ||
              loading ||
              submitting ||
              Boolean(busy) ||
              Boolean(cancellingInviteId)
            }
            isLoading={submitting}
            onClick={() => void sendInvites()}
            className={cn(
              "h-12 w-full shrink-0 rounded-full text-base font-semibold",
              BLOCKED_CTA,
            )}
          >
            {selectedConnections.size
              ? `Invite ${selectedConnections.size} ${
                  selectedConnections.size === 1 ? "person" : "people"
                }`
              : "Select people"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The two grow actions rendered as a pair of pill buttons. Drop it under a
 * selected Circle in any flow. `canInvite` mirrors the server capability so
 * members who cannot invite still get the "Share code" affordance alone.
 */
export function CircleGrowActions({
  circleId,
  circleName,
  busy,
  canInvite = true,
  onShareCode,
  onLoadEligibleConnections,
  onLoadEligibleConnectionsPage,
  onInviteConnections,
  onCancelMemberInvite,
  onInvited,
  className,
  testId,
}: {
  circleId: string;
  circleName: string;
  busy?: boolean;
  canInvite?: boolean;
  onShareCode: (circleId: string) => Promise<void>;
  onLoadEligibleConnections: (
    circleId: string,
  ) => Promise<OneLocationCircleEligibleConnections>;
  onLoadEligibleConnectionsPage?: (
    circleId: string,
    options: { page: number; limit: number; query?: string },
  ) => Promise<OneLocationCircleEligibleConnectionsPage>;
  onInviteConnections: (
    circleId: string,
    inviteeUserIds: string[],
  ) => Promise<void>;
  onCancelMemberInvite: (inviteId: string) => Promise<void>;
  onInvited?: () => void;
  className?: string;
  testId?: string;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareInFlightRef = useRef(false);

  const shareCode = async () => {
    if (shareInFlightRef.current) return;
    shareInFlightRef.current = true;
    setSharing(true);
    try {
      await onShareCode(circleId);
    } catch (error) {
      toast.error(growErrorMessage(error, "Could not share the Circle code."));
    } finally {
      shareInFlightRef.current = false;
      setSharing(false);
    }
  };

  return (
    <div
      className={cn("grid grid-cols-2 gap-2", className)}
      data-testid={testId ?? "one-location-circle-grow-actions"}
    >
      {canInvite ? (
        <Button
          type="button"
          variant="outline"
          disabled={Boolean(busy)}
          onClick={() => setSheetOpen(true)}
          className="h-11 rounded-full font-semibold"
        >
          <UserPlus className="mr-2 h-4 w-4" />
          Invite people
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={Boolean(busy) || sharing}
        isLoading={sharing}
        onClick={() => void shareCode()}
        className={cn(
          "h-11 rounded-full font-semibold",
          !canInvite && "col-span-2",
        )}
      >
        <Share2 className="mr-2 h-4 w-4" />
        Share code
      </Button>

      {canInvite ? (
        <CircleInvitePeopleSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          circleId={circleId}
          circleName={circleName}
          busy={busy}
          onLoadEligibleConnections={onLoadEligibleConnections}
          onLoadEligibleConnectionsPage={onLoadEligibleConnectionsPage}
          onInviteConnections={onInviteConnections}
          onCancelMemberInvite={onCancelMemberInvite}
          onInvited={onInvited}
        />
      ) : null}
    </div>
  );
}
