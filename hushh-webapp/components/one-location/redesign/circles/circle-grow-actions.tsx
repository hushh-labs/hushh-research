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
import {
  Check,
  Loader2,
  Search,
  Send,
  Share2,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { EmptyState } from "@/components/one-location/redesign/primitives";
import type {
  OneLocationCircleEligibleConnection,
  OneLocationCircleEligibleConnections,
  OneLocationCircleMemberInvite,
} from "@/lib/one-location/types";
import { filterPeopleByQuery } from "@/lib/one-location/people-search";
import { BLOCKED_CTA } from "@/components/one-location/redesign/circles/blocked-cta";
import { cn } from "@/lib/utils";

function circleInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function growErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
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
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
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
      filterPeopleByQuery(
        eligibleConnections,
        search,
        (connection) => connection.displayName,
      ),
    [eligibleConnections, search],
  );

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await onLoadEligibleConnections(circleId);
      if (requestId !== requestRef.current) return;
      setEligibleConnections(result.eligibleConnections);
      setPendingInvites(result.pendingInvites);
      setRemainingCapacity(result.remainingCapacity);
      setSelectedIds((current) => {
        const available = new Set(
          result.eligibleConnections.map((connection) => connection.userId),
        );
        return new Set(
          [...current]
            .filter((id) => available.has(id))
            .slice(0, result.remainingCapacity),
        );
      });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setLoadError(
        growErrorMessage(error, "Could not load your connections."),
      );
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [circleId, onLoadEligibleConnections]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelectedIds(new Set());
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [open, load]);

  const sendInvites = async () => {
    if (submitInFlightRef.current || !selectedIds.size) return;
    const inviteeUserIds = [...selectedIds];
    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      await onInviteConnections(circleId, inviteeUserIds);
      toast.success(
        inviteeUserIds.length === 1
          ? "Circle invitation sent."
          : `${inviteeUserIds.length} Circle invitations sent.`,
      );
      setSelectedIds(new Set());
      onInvited?.();
      await load();
    } catch (error) {
      toast.error(
        growErrorMessage(error, "Could not send the invitation."),
      );
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
      toast.error(
        growErrorMessage(error, "Could not cancel the invitation."),
      );
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
          setSelectedIds(new Set());
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
              className="h-12 w-full rounded-full border border-border bg-muted/40 pl-11 pr-4 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
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
                      remainingCapacity === 1
                        ? "You can invite 1 more person right now."
                        : `You can invite ${remainingCapacity} more people right now.`
                    }
                    testId="one-location-circle-grow-eligible-connections"
                  >
                    {filtered.map((connection) => {
                      const selected = selectedIds.has(connection.userId);
                      const atCapacity = selectedIds.size >= remainingCapacity;
                      return (
                        <SettingsRow
                          key={connection.userId}
                          leading={
                            <Avatar className="h-10 w-10 rounded-xl">
                              {connection.photoUrl ? (
                                <AvatarImage src={connection.photoUrl} alt="" />
                              ) : null}
                              <AvatarFallback className="rounded-xl">
                                {circleInitials(connection.displayName)}
                              </AvatarFallback>
                            </Avatar>
                          }
                          title={connection.displayName}
                          description="Connected on One"
                          ariaPressed={selected}
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
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              if (next.has(connection.userId)) {
                                next.delete(connection.userId);
                              } else if (next.size < remainingCapacity) {
                                next.add(connection.userId);
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

      {pendingInvites.length ? (
        <SettingsGroup
          title="Pending invitations"
          description="Cancel anytime before acceptance."
        >
                    {pendingInvites.map((invite) => (
                      <SettingsRow
                        key={invite.id}
                        icon={Send}
                        iconTone="blue"
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
              !selectedIds.size ||
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
            {selectedIds.size
              ? `Invite ${selectedIds.size} ${
                  selectedIds.size === 1 ? "person" : "people"
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
      toast.error(
        growErrorMessage(error, "Could not share the Circle code."),
      );
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
          onInviteConnections={onInviteConnections}
          onCancelMemberInvite={onCancelMemberInvite}
          onInvited={onInvited}
        />
      ) : null}
    </div>
  );
}
