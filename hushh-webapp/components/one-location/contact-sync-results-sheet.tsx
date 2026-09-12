"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { ContactSourceBadge } from "@/components/connections/contact-source-badge";
import { ContactInvitationSheet } from "@/components/connections/contact-invitation-sheet";
import type { ContactInvitationController } from "@/lib/contacts/use-contact-invitations";
import {
  TAKEOVER_OVERLAY_Z_CLASSNAME,
  TAKEOVER_SURFACE_Z_CLASSNAME,
} from "@/components/one-location/onboarding/save-location-sheet-layout";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { OneLocationContactSignalResult } from "@/lib/one-location/contact-signals";
import { CONTACT_SYNC_MAX_LOOKUPS } from "@/lib/marketplace/contact-matching";
import { cn } from "@/lib/utils";
import type { GoogleContactSyncController } from "@/lib/contacts/use-google-contact-sync-session";
import { googleContactSyncSummary } from "@/lib/contacts/google-contact-sync-summary";

const MATCH_PAGE_SIZE = 100;

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function resultStatus(
  outcome: OneLocationContactSignalResult["matches"][number]["outcome"],
): string {
  if (outcome === "auto_connected") return "Connected now";
  if (outcome === "already_connected") return "Already connected";
  if (outcome === "request_required") return "Connection request required";
  return "Kept disconnected";
}

export function ContactSyncResultsSheet({
  open,
  onOpenChange,
  result,
  syncing,
  onSyncAgain,
  onInvite,
  onRequestConnection,
  takeover = false,
  invitations,
  googleSync,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: OneLocationContactSignalResult | null;
  syncing: boolean;
  onSyncAgain: () => void | Promise<void>;
  onInvite: () => void | Promise<void>;
  onRequestConnection: (userId: string) => Promise<void>;
  /** Use the existing Location onboarding layer for its nested results. */
  takeover?: boolean;
  invitations?: ContactInvitationController;
  googleSync?: GoogleContactSyncController;
}) {
  const [requestingUserId, setRequestingUserId] = useState<string | null>(null);
  const [requestedUserIds, setRequestedUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [visibleMatchCount, setVisibleMatchCount] = useState(MATCH_PAGE_SIZE);
  useEffect(() => {
    setRequestingUserId(null);
    setRequestedUserIds(new Set());
    setVisibleMatchCount(MATCH_PAGE_SIZE);
  }, [result]);
  // Admission gates can remount the route after an external composer returns.
  // The active, account/route-owned invitation session survives that temporary
  // remount even though the route's matching results/open flag do not.
  if (invitations?.enabled && invitations.active) {
    return (
      <ContactInvitationSheet
        key={invitations.version}
        controller={invitations}
        takeover={takeover}
        onFinish={() => onOpenChange(false)}
      />
    );
  }
  if (
    googleSync &&
    googleSync.phase !== "idle" &&
    googleSync.phase !== "complete"
  ) {
    const title =
      googleSync.phase === "authorizing"
        ? "Connect Google Contacts"
        : googleSync.phase === "syncing"
          ? "Checking your Google contacts"
          : googleSync.phase === "cancelled"
            ? "Contact sync cancelled"
            : "Could not sync Google contacts";
    return (
      <Sheet modal={takeover} open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          dragDismiss={false}
          onFocusOutside={(event) => event.preventDefault()}
          overlayClassName={takeover ? TAKEOVER_OVERLAY_Z_CLASSNAME : undefined}
          className={cn(
            "mx-auto max-h-[88dvh] w-full max-w-2xl overflow-y-auto rounded-t-[24px] px-6 pb-[max(1rem,env(safe-area-inset-bottom))]",
            takeover && TAKEOVER_SURFACE_Z_CLASSNAME,
          )}
        >
          <SheetHeader className="text-left">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>
              {googleSync.phase === "authorizing"
                ? "Choose the Google account where your contacts are saved. Keep One open; your results will appear here when you return."
                : googleSync.phase === "syncing"
                  ? "Reading saved contacts and checking phone numbers for matches."
                  : googleSync.phase === "cancelled"
                    ? "No contacts were read. You can choose a Google account and try again."
                    : googleSync.error}
            </SheetDescription>
          </SheetHeader>
          {googleSync.busy ? (
            <p
              role="status"
              className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              {googleSync.phase === "authorizing"
                ? "Waiting for Google…"
                : "Syncing contacts…"}
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-2">
            {!googleSync.busy ? (
              <Button type="button" onClick={() => void onSyncAgain()}>
                Choose Google account
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {googleSync.busy ? "Cancel" : "Close"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  if (!result) return null;
  const googleSummary = googleContactSyncSummary(result);
  const emptyGoogleBook =
    result.sourcePlatform === "google" &&
    !result.partial &&
    result.totalContacts === 0;

  const connectedCount =
    result.autoConnectedCount + result.alreadyConnectedCount;
  const visibleMatches = result.matches.slice(0, visibleMatchCount);
  const hiddenMatchCount = Math.max(
    0,
    result.matches.length - visibleMatches.length,
  );
  const capOnlyPartial =
    result.lookupLimitExceeded &&
    !result.mutationOutcomeUnknown &&
    !result.partialFailureMessage &&
    !result.limited &&
    !result.truncated &&
    result.unknownContactCount === 0 &&
    result.uncheckedContactCount === result.lookupLimitedContactCount;

  return (
    <Sheet modal={takeover} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        dragDismiss={false}
        // The launching menu may restore focus after an async sync opens us.
        // Keep results visible; outside pointer presses, Escape and Close still dismiss.
        onFocusOutside={(event) => event.preventDefault()}
        overlayClassName={takeover ? TAKEOVER_OVERLAY_Z_CLASSNAME : undefined}
        className={cn(
          "mx-auto flex max-h-[calc(88dvh-var(--kb-height,0px))] w-full max-w-2xl flex-col rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6",
          takeover && TAKEOVER_SURFACE_Z_CLASSNAME,
        )}
      >
        <SheetHeader className="text-left">
          <SheetTitle>Contact sync results</SheetTitle>
          <SheetDescription>
            {invitations?.enabled
              ? "Names, numbers and invitation emails stay on your device. Choose contacts to invite from this session after reviewing your matches."
              : "Only eligible Hushh accounts are listed. Names and raw phone numbers are never sent to Hushh; contacts without a match are shown only as counts."}
          </SheetDescription>
        </SheetHeader>

        {result.sourcePlatform === "google" ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Read {result.readContactCount} saved Google{" "}
            {result.readContactCount === 1 ? "contact" : "contacts"}.{" "}
            <a
              href="https://contacts.google.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              Check Google Contacts
            </a>
          </p>
        ) : null}

        {!emptyGoogleBook ? (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Checked", result.checkedContactCount],
              ["Matched", result.matchedContactCount],
              ["Connected", connectedCount],
              ["No match", result.unmatchedContactCount],
            ].map(([label, count]) => (
              <div
                key={String(label)}
                className="rounded-2xl bg-muted/45 px-3 py-2.5"
              >
                <p className="text-lg font-semibold text-foreground">{count}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        ) : null}

        {result.partial ||
        result.lookupLimitExceeded ||
        result.excludedSelfContactCount ||
        result.unknownContactCount ||
        result.uncheckableContactCount ? (
          <div className="mt-3 rounded-2xl border border-border/70 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
            {result.partial &&
            !result.partialFailureMessage &&
            !result.unknownContactCount &&
            !result.uncheckedContactCount &&
            !result.lookupLimitExceeded ? (
              <p>Only part of your contact list was checked.</p>
            ) : null}
            {result.partialFailureMessage ? (
              <p className="flex items-start gap-2 text-foreground">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {result.partialFailureMessage}
              </p>
            ) : null}
            {result.unknownContactCount ? (
              <p>
                {result.unknownContactCount} contacts need confirmation. They
                are not counted as unmatched or inviteable.
              </p>
            ) : null}
            {result.uncheckedContactCount ? (
              <p>
                {result.uncheckedContactCount} contacts were not checked yet.
              </p>
            ) : null}
            {result.lookupLimitExceeded ? (
              <p>
                This address book exceeded the secure{" "}
                {CONTACT_SYNC_MAX_LOOKUPS.toLocaleString()}-number sync limit.
                {result.lookupLimitedContactCount
                  ? ` ${result.lookupLimitedContactCount} contacts with overflow numbers were left unchecked and are not inviteable.`
                  : " Additional numbers were outside the limit, but no matched contact was reclassified as unchecked or inviteable."}
              </p>
            ) : null}
            {result.uncheckableContactCount ? (
              <p>
                {result.uncheckableContactCount} contacts had no usable phone
                number.
              </p>
            ) : null}
            {result.excludedSelfContactCount ? (
              <p>
                {result.excludedSelfContactCount} contact entries containing
                your own number were skipped.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {result.matches.length ? (
            <ul className="divide-y divide-border/70 rounded-2xl border border-border/70">
              {visibleMatches.map((match) => {
                const name = match.displayName || "Hushh user";
                const requested = requestedUserIds.has(match.userId);
                return (
                  <li
                    key={match.userId}
                    className="flex min-h-16 items-center gap-3 px-3 py-2.5"
                  >
                    <Avatar className="h-10 w-10 shrink-0">
                      {match.photoUrl ? (
                        <AvatarImage src={match.photoUrl} alt="" />
                      ) : null}
                      <AvatarFallback>{initials(name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                        <p className="min-w-0 break-words text-sm font-semibold [overflow-wrap:anywhere]">
                          {name}
                        </p>
                        {match.outcome === "auto_connected" ||
                        match.outcome === "already_connected" ? (
                          <ContactSourceBadge />
                        ) : null}
                      </div>
                      <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {requested
                          ? "Request sent"
                          : resultStatus(match.outcome)}
                      </p>
                    </div>
                    {match.outcome === "request_required" && !requested ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={requestingUserId === match.userId}
                        aria-label={`Send a connection request to ${name}`}
                        onClick={() => {
                          setRequestingUserId(match.userId);
                          void onRequestConnection(match.userId)
                            .then(() => {
                              setRequestedUserIds((current) => {
                                const next = new Set(current);
                                next.add(match.userId);
                                return next;
                              });
                            })
                            .catch((error: unknown) => {
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : "Could not send connection request.",
                              );
                            })
                            .finally(() => setRequestingUserId(null));
                        }}
                      >
                        {requestingUserId === match.userId ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Request"
                        )}
                      </Button>
                    ) : null}
                    {requested ? (
                      <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="rounded-2xl bg-muted/35 px-4 py-6 text-center text-sm text-muted-foreground">
              {googleSummary ? (
                <>
                  <p className="font-medium text-foreground">
                    {googleSummary.title}
                  </p>
                  <p className="mt-2">{googleSummary.description}</p>
                </>
              ) : (
                <>
                  No eligible contacts matched. ONE users need an exact verified
                  phone match and must remain visible in the Connect directory.
                  Explicit opt-outs and previous disconnects stay protected.
                </>
              )}
            </div>
          )}
          {hiddenMatchCount ? (
            <div className="mt-3 flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Showing {visibleMatches.length} of {result.matches.length}{" "}
                matched people
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 rounded-full px-5"
                onClick={() =>
                  setVisibleMatchCount((current) =>
                    Math.min(current + MATCH_PAGE_SIZE, result.matches.length),
                  )
                }
              >
                Show more ({Math.min(MATCH_PAGE_SIZE, hiddenMatchCount)})
              </Button>
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            "mt-4 grid grid-cols-1 gap-2",
            !emptyGoogleBook && "sm:grid-cols-2",
          )}
        >
          {capOnlyPartial ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="h-11 rounded-full"
            >
              Done
            </Button>
          ) : (
            <Button
              type="button"
              variant={emptyGoogleBook ? "default" : "outline"}
              disabled={syncing}
              onClick={() => void onSyncAgain()}
              className="h-11 rounded-full"
            >
              {syncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {result.sourcePlatform === "google"
                ? "Choose Google account"
                : "Sync again"}
            </Button>
          )}
          {!emptyGoogleBook ? (
            <Button
              type="button"
              disabled={
                syncing ||
                !(invitations?.enabled
                  ? invitations.candidates.length
                  : result.inviteCandidateCount)
              }
              onClick={() => void onInvite()}
              className="h-11 rounded-full"
            >
              <Send className="mr-2 h-4 w-4" />
              Invite contacts
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
