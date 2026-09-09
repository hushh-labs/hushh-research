"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  destinationKey,
  type InviteDestination,
} from "@/lib/contacts/invitation-candidates";
import type { ContactInvitationController } from "@/lib/contacts/use-contact-invitations";
import { personalizeInvitation } from "@/lib/contacts/personalize-invitation";
import {
  ContactInvitationsService,
  invitationBody,
  type InvitationOutcome,
} from "@/lib/services/contact-invitations-service";
import { isShareCancellationError } from "@/lib/share/share-link";
import { cn } from "@/lib/utils";

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
  const [step, setStep] = useState<"select" | "review" | "queue">("select");
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, InviteDestination>>(
    {},
  );
  const [processed, setProcessed] = useState<Set<string>>(() => new Set());
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [outcome, setOutcome] = useState<InvitationOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [smsAvailable, setSmsAvailable] = useState(false);
  const busyRef = useRef(false);
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
    return controller.candidates.filter(
      (candidate) =>
        !search ||
        candidate.displayName.toLowerCase().includes(search) ||
        candidate.destinations.some((destination) =>
          destination.value.toLowerCase().includes(search),
        ),
    );
  }, [query, controller.candidates]);
  const queue = controller.candidates.filter(
    (candidate) => selected[candidate.id],
  );
  const current = queue.find(
    (candidate) => !processed.has(candidate.id) && !skipped.has(candidate.id),
  );
  const selectedKeys = new Set(Object.values(selected).map(destinationKey));
  const previewCandidate =
    step === "queue"
      ? current
      : (queue.find((candidate) => candidate.id === previewId) ?? queue[0]);
  const previewShare =
    controller.share && previewCandidate
      ? personalizeInvitation(controller.share, previewCandidate.displayName)
      : null;

  const act = async (kind: "compose" | "share" | "copy") => {
    if (!current || !controller.share || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const personalizedShare = personalizeInvitation(
        controller.share,
        current.displayName,
      );
      const result =
        kind === "compose"
          ? await ContactInvitationsService.compose(
              selected[current.id]!,
              personalizedShare,
            )
          : kind === "share"
            ? await ContactInvitationsService.share(personalizedShare)
            : await ContactInvitationsService.copy(personalizedShare);
      if (alive.current) setOutcome(result);
    } catch (failure) {
      if (!alive.current) return;
      if (isShareCancellationError(failure)) setOutcome("cancelled");
      else setError("Could not open or copy the invitation. Please try again.");
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const next = (skip: boolean) => {
    if (!current || busyRef.current) return;
    if (skip) setSkipped((previous) => new Set(previous).add(current.id));
    else setProcessed((previous) => new Set(previous).add(current.id));
    setOutcome(null);
    setError(null);
  };

  const finish = () => {
    controller.clear();
    onFinish();
  };
  const successfulHandoff =
    outcome && !["cancelled", "failed", "unavailable"].includes(outcome);
  return (
    <Sheet
      modal={takeover}
      open={controller.active}
      onOpenChange={(open) => {
        if (!open) finish();
      }}
    >
      <SheetContent
        side="bottom"
        dragDismiss={false}
        overlayClassName={takeover ? TAKEOVER_OVERLAY_Z_CLASSNAME : undefined}
        className={cn(
          "mx-auto flex max-h-[calc(88dvh-var(--kb-height,0px))] w-full max-w-2xl flex-col rounded-t-[24px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6",
          takeover && TAKEOVER_SURFACE_Z_CLASSNAME,
        )}
      >
        <SheetHeader className="text-left">
          <SheetTitle>
            {step === "select"
              ? "Invite your contacts"
              : step === "review"
                ? "Review invitations"
                : "Personal invitations"}
          </SheetTitle>
          <SheetDescription>
            {step === "select"
              ? "Choose each person you want to invite. No match does not necessarily mean they are not on One. Contact details stay in this session on your device."
              : "Each invitation opens separately. You send it from your selected Messages or mail account, not from One."}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3">
          {step === "select" ? (
            <>
              <Input
                aria-label="Search contacts to invite"
                placeholder="Search contacts…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisible(PAGE_SIZE);
                }}
              />
              {(["no_match", "email_only"] as const).map((classification) => {
                const rows = filtered
                  .slice(0, visible)
                  .filter(
                    (candidate) => candidate.classification === classification,
                  );
                if (!rows.length) return null;
                return (
                  <section key={classification} className="mt-4">
                    <h3 className="mb-2 text-sm font-medium">
                      {classification === "no_match"
                        ? "No match found"
                        : "Not checked—email only"}
                    </h3>
                    <ul className="divide-y divide-border">
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
                          <li
                            key={candidate.id}
                            className="flex items-start gap-3 py-3"
                          >
                            <label className="flex min-h-11 min-w-11 items-center justify-center">
                              <Checkbox
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
                            </label>
                            <div className="min-w-0 flex-1">
                              <p className="break-words text-sm font-medium">
                                {candidate.displayName}
                              </p>
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
                                    Choose a number or email
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
                              ) : (
                                <p className="break-all text-sm text-muted-foreground">
                                  {chosen?.value}
                                </p>
                              )}
                              {duplicate ? (
                                <p className="text-xs text-muted-foreground">
                                  This destination is already selected.
                                </p>
                              ) : null}
                            </div>
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
                <div className="rounded-xl bg-muted/40 p-3">
                  <p className="mb-2 text-xs text-muted-foreground">
                    Message preview for {previewCandidate?.displayName}
                  </p>
                  <textarea
                    aria-label={`Invitation message for ${previewCandidate?.displayName}`}
                    readOnly
                    rows={5}
                    className="w-full resize-y select-text rounded-md bg-transparent text-sm leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    value={invitationBody(previewShare)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    You can also select and copy this message yourself.
                  </p>
                </div>
              ) : null}
              {step === "review" ? (
                <ul className="mt-3 divide-y divide-border">
                  {queue.map((candidate) => (
                    <li
                      key={candidate.id}
                      className="flex items-center gap-3 py-3"
                    >
                      <button
                        type="button"
                        className="min-h-11 min-w-0 flex-1 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        aria-label={`Preview message for ${candidate.displayName}`}
                        aria-pressed={previewCandidate?.id === candidate.id}
                        onClick={() => setPreviewId(candidate.id)}
                      >
                        <p className="break-words text-sm font-medium">
                          {candidate.displayName}
                        </p>
                        <p className="break-all text-sm text-muted-foreground">
                          {selected[candidate.id]?.value}
                        </p>
                        <span className="text-xs text-primary underline">
                          Preview message
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        className="min-h-11"
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
                      <p className="break-words font-medium">
                        {current.displayName}
                      </p>
                      <p className="break-all text-sm text-muted-foreground">
                        {selected[current.id]?.value}
                      </p>
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
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          disabled={
                            busy ||
                            !controller.share ||
                            (selected[current.id]?.kind === "phone" &&
                              ContactInvitationsService.isNative() &&
                              !smsAvailable)
                          }
                          onClick={() => void act("compose")}
                        >
                          {outcome
                            ? "Retry composer"
                            : selected[current.id]?.kind === "phone" &&
                                !ContactInvitationsService.isNative()
                              ? "Open Messages"
                              : "Compose invitation"}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy || !controller.share}
                          onClick={() => void act("copy")}
                        >
                          Copy invitation
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy || !controller.share}
                          onClick={() => void act("share")}
                        >
                          Share invitation
                        </Button>
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
                      <div className="mt-3 flex gap-2">
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => next(true)}
                        >
                          Skip
                        </Button>
                        <Button
                          disabled={busy || !successfulHandoff}
                          onClick={() => next(false)}
                        >
                          Next recipient
                        </Button>
                      </div>
                      {!successfulHandoff ? (
                        <Button
                          variant="ghost"
                          className="mt-2 min-h-11"
                          disabled={busy}
                          onClick={() => next(false)}
                        >
                          I handled it elsewhere
                        </Button>
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
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {step === "select" ? (
            <Button
              className="min-h-11 flex-1"
              disabled={!queue.length}
              onClick={() => setStep("review")}
            >
              Review {queue.length} invitations
            </Button>
          ) : step === "review" ? (
            <>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => setStep("select")}
              >
                Back to selection
              </Button>
              <Button
                className="min-h-11 flex-1"
                disabled={
                  !queue.length || !controller.share || controller.preparing
                }
                onClick={() => setStep("queue")}
              >
                Continue with {queue.length} invitations
              </Button>
            </>
          ) : null}
          <Button variant="ghost" className="min-h-11" onClick={finish}>
            Finish and clear
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
