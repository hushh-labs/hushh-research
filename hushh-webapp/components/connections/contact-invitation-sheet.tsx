"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  TAKEOVER_OVERLAY_Z_CLASSNAME,
  TAKEOVER_SURFACE_Z_CLASSNAME,
} from "@/components/one-location/onboarding/save-location-sheet-layout";
import { destinationKey } from "@/lib/contacts/invitation-candidates";
import type { ContactInvitationController } from "@/lib/contacts/use-contact-invitations";
import { personalizeInvitation } from "@/lib/contacts/personalize-invitation";
import {
  ContactInvitationsService,
  invitationBody,
  type InvitationOutcome,
} from "@/lib/services/contact-invitations-service";
import { cn } from "@/lib/utils";
import {
  CONTACT_INVITE_FOOTER_CLASSNAME,
  CONTACT_INVITE_HEADER_CLASSNAME,
  CONTACT_INVITE_LIST_CLASSNAME,
  CONTACT_INVITE_LIST_TRAILING_INSET_CLASSNAME,
  CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME,
  CONTACT_INVITE_SECONDARY_ACTION_CLASSNAME,
  CONTACT_INVITE_SEARCH_CLASSNAME,
  CONTACT_INVITE_SURFACE_CLASSNAME,
  CONTACT_INVITE_TITLE_CLASSNAME,
} from "@/components/connections/contact-sheet-layout";

const PAGE_SIZE = 50;
const OUTCOME_TEXT: Record<InvitationOutcome, string> = {
  queued_or_sent: "Handed to Messages. Delivery is not confirmed.",
  opened: "Messages opened. Sending is confirmed in that app.",
  launch_requested:
    "Requested your messaging app. If it did not open, copy or share the invitation below.",
  cancelled: "Cancelled. You can retry or skip this recipient.",
  failed: "The message could not be handed off. Retry, copy or share it.",
  unavailable:
    "Messages is unavailable here. Copy or share the invitation instead.",
  "native-share":
    "Invitation handed to the share sheet. Delivery is not confirmed.",
  "web-share":
    "Invitation handed to the share sheet. Delivery is not confirmed.",
  copied: "Invitation copied. Paste it into your chosen conversation.",
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
    step,
    setStep,
    query,
    setQuery,
    previewId,
    setPreviewId,
    visible,
    setVisible,
    choices,
    setChoices,
    selected,
    setSelected,
    processed,
    skipped,
    outcome,
    error,
    busy,
    busyRef,
    queue,
    current,
    next,
    act,
  } = controller.draft;
  const [smsAvailable, setSmsAvailable] = useState(false);
  const selectionId = useId();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void ContactInvitationsService.canComposeSms().then((available) => {
      if (alive.current) setSmsAvailable(available);
    });
    return () => {
      alive.current = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return controller.candidates
      .filter(
        (candidate) =>
          !search ||
          candidate.displayName.toLowerCase().includes(search) ||
          candidate.destinations.some((destination) =>
            destination.value.toLowerCase().includes(search),
          ),
      )
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName, undefined, {
            sensitivity: "base",
            numeric: true,
          }) || left.id.localeCompare(right.id),
      );
  }, [query, controller.candidates]);
  const selectedKeys = new Set(Object.values(selected).map(destinationKey));
  const previewCandidate =
    step === "queue"
      ? current
      : (queue.find((candidate) => candidate.id === previewId) ?? queue[0]);
  const previewShare =
    controller.share && previewCandidate
      ? personalizeInvitation(controller.share, previewCandidate.displayName)
      : null;

  const finish = () => {
    controller.clear();
    onFinish();
  };
  const hasFooter = step !== "queue" || !current;
  const needsCompletionConfirmation =
    outcome && !["cancelled", "failed", "unavailable"].includes(outcome);
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
        // Native composers, share sheets, and the clipboard fallback can all
        // move focus outside the WebView dialog without dismissing this task.
        onFocusOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busyRef.current) event.preventDefault();
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
                : "Personal invitations"}
          </SheetTitle>
          <SheetDescription>
            {step === "select"
              ? // Kept to one line of privacy so the list below keeps its room;
                // the no-match caveat sits under the heading it explains.
                "Contact details stay in this session on your device."
              : "Send a personal invitation, one contact at a time."}
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
                setVisible(PAGE_SIZE);
              }}
            />
          </div>
        ) : null}
        <div
          data-contact-invite-list
          className={cn(
            CONTACT_INVITE_LIST_CLASSNAME,
            !hasFooter && CONTACT_INVITE_LIST_TRAILING_INSET_CLASSNAME,
          )}
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
                    <h3 className="text-sm font-medium">
                      {classification === "no_match"
                        ? "No match found"
                        : "Not checked—mail only"}
                    </h3>
                    {classification === "no_match" ? (
                      <p className="text-xs text-muted-foreground">
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
                          selectedKeys.has(destinationKey(chosen)) &&
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
                                disabled={!chosen || Boolean(duplicate)}
                                onCheckedChange={(checked) => {
                                  setSelected((previous) => {
                                    const updated = { ...previous };
                                    if (checked && chosen) {
                                      if (
                                        Object.entries(previous).some(
                                          ([id, destination]) =>
                                            id !== candidate.id &&
                                            destinationKey(destination) ===
                                              destinationKey(chosen),
                                        )
                                      )
                                        return previous;
                                      updated[candidate.id] = chosen;
                                    } else delete updated[candidate.id];
                                    return updated;
                                  });
                                }}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block break-words text-sm font-medium">
                                  {candidate.displayName}
                                </span>
                                <span className="block break-all text-sm text-muted-foreground">
                                  {chosen?.value ??
                                    "Choose a number or mail below"}
                                </span>
                                {duplicate ? (
                                  <span className="block text-xs text-muted-foreground">
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
                                  Choose a number or mail
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
                <p className="py-6 text-sm text-muted-foreground">
                  No contacts match your search.
                </p>
              ) : null}
              {filtered.length > visible ? (
                <Button
                  variant="outline"
                  className="mt-3 min-h-11"
                  onClick={() => setVisible((count) => count + PAGE_SIZE)}
                >
                  Show more contacts
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {controller.preparing ? (
                <p role="status">Preparing invitation…</p>
              ) : null}
              {controller.error ? (
                <div className="mb-3">
                  <p role="alert">{controller.error}</p>
                  <Button
                    className="mt-2 min-h-11"
                    variant="outline"
                    disabled={controller.preparing}
                    onClick={() => void controller.retryPreparation()}
                  >
                    Retry invitation link
                  </Button>
                </div>
              ) : null}
              {previewShare ? (
                <div className="rounded-2xl bg-muted/40 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-[15px] font-semibold leading-5">
                        {step === "queue"
                          ? previewCandidate?.displayName
                          : `Message preview for ${previewCandidate?.displayName}`}
                      </p>
                      <p className="mt-0.5 break-all text-[13px] leading-[18px] text-muted-foreground">
                        {previewCandidate &&
                          selected[previewCandidate.id]?.value}
                      </p>
                    </div>
                    {step === "queue" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-mr-2 -mt-1.5 min-h-11 shrink-0"
                        disabled={busy}
                        onClick={() => void act("copy")}
                      >
                        Copy invitation
                      </Button>
                    ) : null}
                  </div>
                  {/* The message sits under a hairline on its own padding-free
                      box, so its first glyph aligns with the name above and
                      nothing in the card can overlap it. */}
                  <textarea
                    aria-label={`Invitation message for ${previewCandidate?.displayName}`}
                    readOnly
                    rows={Math.min(
                      8,
                      invitationBody(previewShare).split("\n").length + 1,
                    )}
                    className="mt-3 block w-full resize-none select-text appearance-none rounded-none border-0 border-t border-border/70 bg-transparent p-0 pt-3 text-[15px] leading-6 [text-indent:0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    value={invitationBody(previewShare)}
                  />
                </div>
              ) : null}
              {step === "review" ? (
                <ul className="mt-2 divide-y divide-border">
                  {queue.map((candidate) => (
                    <li
                      key={candidate.id}
                      className="flex items-center gap-3 py-2"
                    >
                      <button
                        type="button"
                        className="min-h-11 min-w-0 flex-1 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        aria-label={`Preview message for ${candidate.displayName}`}
                        aria-pressed={previewCandidate?.id === candidate.id}
                        onClick={() => setPreviewId(candidate.id)}
                      >
                        <p className="break-words text-[15px] font-semibold leading-5">
                          {candidate.displayName}
                        </p>
                        <p className="break-all text-[13px] leading-[18px] text-muted-foreground">
                          {selected[candidate.id]?.value}
                        </p>
                        <span className="mt-0.5 block text-xs font-medium text-primary">
                          Preview message
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        className="-mr-2 min-h-11 shrink-0 font-semibold"
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
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  <p className="mt-3 text-sm" aria-live="polite">
                    {processed.size} processed · {skipped.size} skipped ·{" "}
                    {queue.length - processed.size - skipped.size} remaining
                  </p>
                  {current ? (
                    <div className="mt-4">
                      {selected[current.id]?.kind === "phone" &&
                      !ContactInvitationsService.isNative() ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                          Copy the invitation first. Open Messages fills the
                          number; paste the message there.
                        </p>
                      ) : null}
                      {outcome ? (
                        <p role="status" className="mt-3 text-sm">
                          {OUTCOME_TEXT[outcome]}
                        </p>
                      ) : null}
                      {error ? (
                        <p role="alert" className="mt-3 text-sm">
                          {error}
                        </p>
                      ) : null}
                      <div className="mt-4 flex flex-col gap-2">
                        {needsCompletionConfirmation ? (
                          <Button disabled={busy} onClick={() => next(false)}>
                            Done with this contact
                          </Button>
                        ) : null}
                        <Button
                          variant={
                            needsCompletionConfirmation ? "outline" : "default"
                          }
                          disabled={
                            busy ||
                            !controller.share ||
                            (selected[current.id]?.kind === "phone" &&
                              ContactInvitationsService.isNative() &&
                              !smsAvailable)
                          }
                          onClick={() => void act("compose")}
                        >
                          {selected[current.id]?.kind === "email"
                            ? "Open mail"
                            : "Open Messages"}
                        </Button>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            className="min-h-11 flex-1"
                            disabled={busy || !controller.share}
                            onClick={() => void act("share")}
                          >
                            Share invitation
                          </Button>
                          <Button
                            variant="ghost"
                            className="min-h-11"
                            disabled={busy}
                            onClick={() => next(true)}
                          >
                            Skip
                          </Button>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        When sharing, choose the recipient in your sharing app.
                      </p>
                      {!smsAvailable && ContactInvitationsService.isNative() ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                          Direct Messages is unavailable. You can still copy or
                          share.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-4">Your invitation queue is complete.</p>
                  )}
                </>
              )}
            </>
          )}
        </div>
        {hasFooter ? (
          <div className={CONTACT_INVITE_FOOTER_CLASSNAME}>
            {step === "select" ? (
              <Button
                className={CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME}
                disabled={!queue.length}
                onClick={() => setStep("review")}
              >
                Review {queue.length} invitations
              </Button>
            ) : step === "review" ? (
              <>
                <Button
                  className={CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME}
                  disabled={
                    !queue.length || !controller.share || controller.preparing
                  }
                  onClick={() => setStep("queue")}
                >
                  Continue with {queue.length} invitations
                </Button>
                <Button
                  variant="ghost"
                  className={CONTACT_INVITE_SECONDARY_ACTION_CLASSNAME}
                  onClick={() => setStep("select")}
                >
                  Back to selection
                </Button>
              </>
            ) : null}
            {step === "queue" ? (
              <Button
                className={CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME}
                onClick={finish}
              >
                Done
              </Button>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
