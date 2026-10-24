"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent as UnscopedSheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  TAKEOVER_OVERLAY_Z_CLASSNAME,
  TAKEOVER_SURFACE_Z_CLASSNAME,
} from "@/components/one-location/onboarding/save-location-sheet-layout";
import {
  destinationKey,
  MAX_INVITATION_RECIPIENTS,
} from "@/lib/contacts/invitation-candidates";
import type { ContactInvitationController } from "@/lib/contacts/use-contact-invitations";
import {
  ContactInvitationsService,
  invitationBody,
  type InvitationOutcome,
} from "@/lib/services/contact-invitations-service";
import { cn } from "@/lib/utils";
import { withLocationTypography } from "@/components/one-location/redesign/location-typography";
import {
  CONTACT_INVITE_FOOTER_CLASSNAME,
  CONTACT_INVITE_HEADER_CLASSNAME,
  CONTACT_INVITE_LIST_CLASSNAME,
  CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME,
  CONTACT_INVITE_SECONDARY_ACTION_CLASSNAME,
  CONTACT_INVITE_SEARCH_CLASSNAME,
  CONTACT_INVITE_SURFACE_CLASSNAME,
  CONTACT_INVITE_TITLE_CLASSNAME,
} from "@/components/connections/contact-sheet-layout";

const SheetContent = withLocationTypography(UnscopedSheetContent);

const OUTCOME_TEXT: Record<InvitationOutcome, string> = {
  queued_or_sent: "Handed to Messages. Delivery is not confirmed.",
  opened:
    "Messages opened. Check all recipients and tap Send there. One cannot confirm sending or delivery.",
  launch_requested:
    "Email draft requested. Check that all selected addresses are in BCC, then send in your email app. If nothing opened, copy the invitation.",
  cancelled: "Cancelled. Your selection is saved here; you can try again.",
  failed:
    "The message could not be handed off. Try again or copy the invitation.",
  unavailable:
    "Messages is unavailable or this app version does not support batch invitations. Update One or copy the invitation.",
  "native-share":
    "Share sheet opened. Choose recipients there; sending and delivery are not confirmed.",
  "web-share":
    "Share sheet opened. Choose recipients there; sending and delivery are not confirmed.",
  copied: "Invitation copied. Paste it into your chosen conversation or email.",
};

export function ContactInvitationSheet({
  controller,
  onFinish,
  takeover = false,
}: {
  controller: ContactInvitationController;
  onFinish: () => void;
  takeover?: boolean;
}) {
  const {
    native,
    candidates,
    step,
    setStep,
    query,
    setQuery,
    visible,
    setVisible,
    choices,
    setChoices,
    selected,
    setSelected,
    outcome,
    handoffOutcome,
    error,
    busy,
    busyRef,
    queue,
    act,
  } = controller.draft;
  const [smsAvailable, setSmsAvailable] = useState<boolean | null>(null);
  const selectionId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [step]);
  useEffect(() => {
    let alive = true;
    void ContactInvitationsService.canComposeBatchSms().then((available) => {
      if (alive) setSmsAvailable(available);
    });
    return () => {
      alive = false;
    };
  }, []);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return candidates.filter(
      (candidate) =>
        !search ||
        candidate.displayName.toLowerCase().includes(search) ||
        candidate.destinations.some((destination) =>
          destination.value.toLowerCase().includes(search),
        ),
    );
  }, [query, candidates]);
  const selectedKeys = new Set(
    Object.values(selected).map((destination) =>
      destinationKey(destination).toLowerCase(),
    ),
  );
  const atLimit = queue.length >= MAX_INVITATION_RECIPIENTS;
  const finish = () => {
    controller.clear();
    onFinish();
  };
  const back = () => {
    if (busyRef.current) return;
    setStep(step === "queue" ? "review" : "select");
  };
  const handedOff =
    handoffOutcome &&
    ["queued_or_sent", "opened", "launch_requested"].includes(handoffOutcome);

  return (
    <Sheet
      modal
      open={controller.active}
      onOpenChange={(open) => {
        if (!open) finish();
      }}
    >
      <SheetContent
        side="bottom"
        dragDismiss={false}
        onFocusOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busyRef.current || step !== "select") {
            event.preventDefault();
            back();
          }
        }}
        overlayClassName={takeover ? TAKEOVER_OVERLAY_Z_CLASSNAME : undefined}
        className={cn(
          CONTACT_INVITE_SURFACE_CLASSNAME,
          takeover && TAKEOVER_SURFACE_Z_CLASSNAME,
        )}
      >
        <SheetHeader className={CONTACT_INVITE_HEADER_CLASSNAME}>
          <SheetTitle className={CONTACT_INVITE_TITLE_CLASSNAME}>
            {step === "select"
              ? "Invite your contacts"
              : step === "review"
                ? "Review invitations"
                : "Your invitation"}
          </SheetTitle>
          <SheetDescription>
            {step === "select"
              ? "Choose up to 15. Contact details stay on your device."
              : "One message for all selected contacts."}
          </SheetDescription>
        </SheetHeader>
        {step === "select" ? (
          <div className={CONTACT_INVITE_SEARCH_CLASSNAME}>
            <Input
              aria-label="Search contacts to invite"
              placeholder="Search contacts…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisible(50);
              }}
            />
          </div>
        ) : null}
        <div
          ref={listRef}
          data-contact-invite-list
          className={CONTACT_INVITE_LIST_CLASSNAME}
        >
          {step === "select" ? (
            <>
              {(["no_match", "email_only"] as const).map((classification) => {
                const rows = filtered
                  .slice(0, visible)
                  .filter(
                    (candidate) => candidate.classification === classification,
                  );
                if (!rows.length) return null;
                return (
                  <section key={classification} className="mt-2 first:mt-0">
                    <h3 data-location-type-role="source-heading" className="text-sm font-medium">
                      {classification === "no_match"
                        ? "No match found"
                        : "Not checked—mail only"}
                    </h3>
                    {classification === "no_match" ? (
                      <p data-location-type-role="helper" className="text-xs text-muted-foreground">
                        No match does not necessarily mean they are not on One.
                      </p>
                    ) : null}
                    <ul className="mt-1 divide-y divide-border">
                      {rows.map((candidate) => {
                        const chosen =
                          candidate.destinations.find(
                            (destination) =>
                              destinationKey(destination) ===
                              choices[candidate.id],
                          ) ??
                          (candidate.destinations.length === 1
                            ? candidate.destinations[0]
                            : undefined);
                        const duplicate =
                          chosen &&
                          selectedKeys.has(
                            destinationKey(chosen).toLowerCase(),
                          ) &&
                          !selected[candidate.id];
                        return (
                          <li key={candidate.id}>
                            <label
                              htmlFor={`${selectionId}-${candidate.id}`}
                              className="flex min-h-14 w-full cursor-pointer items-center gap-3 py-3"
                            >
                              <Checkbox
                                id={`${selectionId}-${candidate.id}`}
                                aria-label={`Select ${candidate.displayName}`}
                                checked={Boolean(selected[candidate.id])}
                                disabled={
                                  !chosen ||
                                  Boolean(duplicate) ||
                                  (atLimit && !selected[candidate.id])
                                }
                                onCheckedChange={(checked) =>
                                  setSelected((previous) => {
                                    const updated = { ...previous };
                                    if (checked && chosen)
                                      updated[candidate.id] = chosen;
                                    else delete updated[candidate.id];
                                    return updated;
                                  })
                                }
                              />
                              <span className="min-w-0 flex-1">
                                <span data-location-type-role="row-title" className="block break-words text-sm font-medium">
                                  {candidate.displayName}
                                </span>
                                <span data-location-type-role="row-description" className="block break-all text-sm text-muted-foreground">
                                  {chosen?.value ??
                                    `Choose ${native ? "a number" : "an email"} below`}
                                </span>
                                {duplicate ? (
                                  <span data-location-type-role="helper" className="block text-xs text-muted-foreground">
                                    This destination is already selected.
                                  </span>
                                ) : null}
                              </span>
                            </label>
                            {candidate.destinations.length > 1 ? (
                              <select
                                aria-label={`Destination for ${candidate.displayName}`}
                                className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
                                value={choices[candidate.id] ?? ""}
                                onChange={(event) => {
                                  setChoices((previous) => ({
                                    ...previous,
                                    [candidate.id]: event.target.value,
                                  }));
                                  setSelected((previous) => {
                                    const updated = { ...previous };
                                    delete updated[candidate.id];
                                    return updated;
                                  });
                                }}
                              >
                                <option value="">
                                  Choose {native ? "a number" : "an email"}
                                </option>
                                {candidate.destinations.map((destination) => (
                                  <option
                                    key={destinationKey(destination)}
                                    value={destinationKey(destination)}
                                  >
                                    {destination.value}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
              {!filtered.length ? (
                <p data-location-type-role="row-description" className="py-6 text-sm text-muted-foreground">
                  {query.trim()
                    ? "No contacts match your search."
                    : native
                      ? "No contacts with a valid phone number are available to invite."
                      : "No contacts with an email address are available to invite. Sync Google contacts with emails, or share your invitation link."}
                </p>
              ) : null}
              {candidates.length < controller.candidates.length ? (
                <p data-location-type-role="helper" className="mt-3 text-xs text-muted-foreground">
                  {native
                    ? "Only contacts with a phone number appear here."
                    : "Only contacts with an email address appear here. Phone-only contacts can be invited from the One mobile app."}
                </p>
              ) : null}
              {atLimit ? (
                <p data-location-type-role="status" role="status" className="mt-3 text-sm text-muted-foreground">
                  15 contacts selected. Remove one to choose another.
                </p>
              ) : null}
              {!candidates.length && controller.share ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button data-location-type-role="utility-action"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => void act("share")}
                  >
                    Share link instead
                  </Button>
                  <Button data-location-type-role="utility-action"
                    variant="ghost"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => void act("copy")}
                  >
                    Copy invitation
                  </Button>
                </div>
              ) : null}
              {!candidates.length && controller.preparing ? (
                <p data-location-type-role="status" role="status">Preparing invitation…</p>
              ) : null}
              {!candidates.length && controller.error ? (
                <div className="mt-3">
                  <p data-location-type-role="row-description" role="alert">{controller.error}</p>
                  <Button data-location-type-role="utility-action"
                    variant="outline"
                    className="mt-2 min-h-11"
                    disabled={controller.preparing || busy}
                    onClick={() => void controller.retryPreparation()}
                  >
                    Retry invitation link
                  </Button>
                </div>
              ) : null}
              {!candidates.length && outcome ? (
                <p data-location-type-role="status" role="status" className="mt-3 text-sm">
                  {OUTCOME_TEXT[outcome]}
                </p>
              ) : null}
              {!candidates.length && error ? (
                <p data-location-type-role="row-description" role="alert" className="mt-3 text-sm">
                  {error}
                </p>
              ) : null}
              {filtered.length > visible ? (
                <Button data-location-type-role="utility-action"
                  variant="outline"
                  className="mt-3 min-h-11"
                  onClick={() => setVisible((count) => count + 50)}
                >
                  Show more contacts
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {busy ? (
                <p data-location-type-role="status" role="status" className="mt-3 text-sm">
                  Preparing invitation…
                </p>
              ) : outcome ? (
                <p data-location-type-role="status" role="status" className="mt-3 text-sm">
                  {OUTCOME_TEXT[outcome]}
                </p>
              ) : null}
              {error ? (
                <p data-location-type-role="row-description" role="alert" className="mt-3 text-sm">
                  {error}
                </p>
              ) : null}
              {handedOff ? (
                <p data-location-type-role="helper" className="mt-2 text-xs text-muted-foreground">
                  Before opening again, check your app to avoid sending the same
                  invitation twice.
                </p>
              ) : null}
              {controller.preparing ? (
                <p data-location-type-role="status" role="status">Preparing invitation…</p>
              ) : null}
              {controller.error ? (
                <div className="mb-3">
                  <p data-location-type-role="row-description" role="alert">{controller.error}</p>
                  <Button data-location-type-role="utility-action"
                    className="mt-2 min-h-11"
                    variant="outline"
                    disabled={controller.preparing || busy}
                    onClick={() => void controller.retryPreparation()}
                  >
                    Retry invitation link
                  </Button>
                </div>
              ) : null}
              {controller.share ? (
                <div className="rounded-2xl bg-muted/40 px-4 py-3.5">
                  <p data-location-type-role="section-heading" className="text-[15px] font-semibold leading-5">
                    Message preview
                  </p>
                  <textarea
                    aria-label="Invitation message"
                    readOnly
                    rows={5}
                    className="mt-3 block w-full resize-none select-text appearance-none rounded-none border-0 border-t border-border/70 bg-transparent p-0 pt-3 text-[15px] leading-6 [text-indent:0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    value={invitationBody(controller.share)}
                  />
                </div>
              ) : null}
              <p data-location-type-role="row-description" className="mt-3 text-sm text-muted-foreground">
                {native
                  ? "Opens one Messages draft from your device’s messaging account. This may create a group: recipients can see each other’s numbers. Check recipients and tap Send there. Carrier charges may apply."
                  : "Opens one email draft with the selected addresses in BCC. Check BCC and send from your email account. Your email app must support BCC links."}
              </p>
              <h3 data-location-type-role="source-heading" className="mt-4 text-sm font-medium">
                {queue.length} selected{" "}
                {queue.length === 1 ? "contact" : "contacts"}
              </h3>
              <ul className="mt-1 divide-y divide-border">
                {queue.map((candidate) => (
                  <li
                    key={candidate.id}
                    className="flex items-center gap-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p data-location-type-role="row-title" className="break-words text-sm font-medium">
                        {candidate.displayName}
                      </p>
                      <p data-location-type-role="row-description" className="break-all text-sm text-muted-foreground">
                        {selected[candidate.id]?.value}
                      </p>
                    </div>
                    {step === "review" ? (
                      <Button data-location-type-role="utility-action"
                        variant="ghost"
                        className="-mr-2 min-h-11 shrink-0"
                        disabled={busy}
                        aria-label={`Remove ${candidate.displayName}`}
                        onClick={() =>
                          setSelected((previous) => {
                            const updated = { ...previous };
                            delete updated[candidate.id];
                            return updated;
                          })
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {native && smsAvailable === false ? (
                <p data-location-type-role="status" role="status" className="mt-3 text-sm text-muted-foreground">
                  Batch Messages is unavailable. Update One and check your
                  messaging app. You can still copy the invitation.
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button data-location-type-role="utility-action"
                  variant="ghost"
                  className="min-h-11"
                  disabled={busy || !controller.share}
                  onClick={() => void act("copy")}
                >
                  Copy invitation
                </Button>
                <Button data-location-type-role="utility-action"
                  variant="ghost"
                  className="min-h-11"
                  disabled={busy || !controller.share}
                  onClick={() => void act("share")}
                >
                  Share link instead
                </Button>
              </div>
              <p data-location-type-role="helper" className="text-xs text-muted-foreground">
                Sharing the link lets you choose recipients in another app.
              </p>
            </>
          )}
        </div>
        <div className={CONTACT_INVITE_FOOTER_CLASSNAME}>
          {step === "select" ? (
            <Button
              className={CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME}
              disabled={!queue.length}
              onClick={() => setStep("review")}
            >
              Review {queue.length}{" "}
              {queue.length === 1 ? "invitation" : "invitations"}
            </Button>
          ) : (
            <>
              {step === "review" || !handedOff ? (
                <Button
                  className={CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME}
                  disabled={
                    busy ||
                    !queue.length ||
                    !controller.share ||
                    controller.preparing ||
                    (native && smsAvailable !== true)
                  }
                  onClick={() => void act("compose")}
                >
                  {native ? "Open Messages" : "Open email"} · {queue.length}{" "}
                  {queue.length === 1 ? "contact" : "contacts"}
                </Button>
              ) : (
                <Button
                  className={CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME}
                  onClick={finish}
                >
                  Done
                </Button>
              )}
              <Button
                variant="ghost"
                className={CONTACT_INVITE_SECONDARY_ACTION_CLASSNAME}
                disabled={busy}
                onClick={back}
              >
                {step === "review" ? "Back to selection" : "Back to review"}
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
