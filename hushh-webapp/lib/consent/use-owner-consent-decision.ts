"use client";

/**
 * Allow / Don't allow for one owner request, from any surface.
 *
 * The Feed, the Consent Center rows and the owner's own chat card all decide
 * inline. They go through this hook, which goes through `useConsentActions`,
 * so there is exactly one approve path (the on-device encrypted export, then
 * the server call) and one deny path, whichever button was tapped.
 *
 * The vault is the one thing an inline button cannot assume. Allowing builds
 * the export from the owner's encrypted memory on this device, so it needs the
 * vault key; the old path answered a locked vault with a toast that navigated
 * somewhere else and dropped the decision. Here the decision waits: the unlock
 * prompt opens, and when the key arrives the same decision runs. Cancelling the
 * unlock cancels the decision and nothing is sent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useVault } from "@/lib/vault/vault-context";
import { useConsentActions } from "@/lib/consent/use-consent-actions";
import {
  consentEntryToPendingConsent,
  type OwnerConsentRequest,
} from "@/lib/consent/owner-consent-request";
import { joinInformationLabels } from "@/lib/consent/consent-owner-copy";
import { useDeferredConsentDeclines } from "@/lib/consent/deferred-consent-decline";

export type OwnerConsentDecisionKind = "allow" | "deny";

/** The calls a decision needs from `useConsentActions`. */
export type OwnerConsentDecisionActions = Pick<
  ReturnType<typeof useConsentActions>,
  "handleApproveBundle" | "handleDenyBundle" | "bundleProgress"
>;

type PendingUnlock = {
  kind: OwnerConsentDecisionKind;
  request: OwnerConsentRequest;
  /** What runs once the key is here. */
  proceed: () => Promise<void>;
  resolve: (decided: boolean) => void;
  reject: (error: unknown) => void;
};

export type OwnerConsentUnlockPrompt = {
  open: boolean;
  title: string;
  description: string;
  /** Close without unlocking: the waiting decision is dropped, nothing sent. */
  cancel: () => void;
};

export interface OwnerConsentDecisionHooks {
  /** Runs once the vault is open, just before the decision goes out. */
  onStart?: () => void;
}

export interface DeclineWithUndoHooks {
  /** The row leaves now, before anything is sent. */
  onHide: () => void;
  /** Undo, or the deny failed: the row comes back. */
  onRestore: () => void;
}

const DECLINE_FAILED = "Could not decline this request. Try again.";

export function allowSuccessMessage(request: OwnerConsentRequest): string {
  return `${request.requesterShortName} can now see your ${joinInformationLabels(request.labels)}.`;
}

/** The Undo toast's line. Nothing has been sent while it shows. */
export function declineUndoMessage(request: OwnerConsentRequest): string {
  return `Declined ${request.requesterShortName}'s request.`;
}

export function useOwnerConsentDecision(options: {
  userId: string | null | undefined;
}) {
  const actions = useConsentActions({ userId: options.userId });
  return useOwnerConsentDecisionWith(actions);
}

/**
 * The same decision over an actions instance the caller already holds. The
 * Consent Center passes its own, so a row decision shares the sheet's busy
 * state and its confirmed-approval bookkeeping instead of running beside it.
 */
export function useOwnerConsentDecisionWith(
  actions: OwnerConsentDecisionActions,
) {
  const { vaultKey } = useVault();
  const [pendingUnlock, setPendingUnlock] = useState<PendingUnlock | null>(
    null,
  );
  const { schedule: scheduleDecline } = useDeferredConsentDeclines();

  // useConsentActions returns a fresh object every render; reading it through
  // a ref keeps `allow`/`deny` stable, so a list that builds rows around them
  // (the Feed memoises its rows) does not rebuild on every render.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const run = useCallback(
    async (
      kind: OwnerConsentDecisionKind,
      request: OwnerConsentRequest,
      durationHours?: number,
      runOptions: { quiet?: boolean } = {},
    ): Promise<void> => {
      if (!request.complete) {
        throw new Error("This request is still arriving. Open Details to review it.");
      }
      if (kind === "allow") {
        await actionsRef.current.handleApproveBundle(
          request.members.map((member) =>
            consentEntryToPendingConsent(
              member,
              durationHours ?? request.durationHours ?? undefined,
            ),
          ),
          {
            bundleId: request.key,
            successMessage: allowSuccessMessage(request),
          },
        );
        return;
      }
      await actionsRef.current.handleDenyBundle(
        request.members.map((member) => member.request_id || member.id),
        {
          bundleId: request.key,
          successMessage: "Declined. Nothing was shared.",
          quiet: runOptions.quiet,
        },
      );
    },
    [],
  );

  /**
   * Run `proceed` once the vault is open. With the vault locked the unlock
   * prompt opens and nothing runs until the key is here; closing the prompt
   * resolves false and nothing runs at all.
   */
  const whenUnlocked = useCallback(
    (
      kind: OwnerConsentDecisionKind,
      request: OwnerConsentRequest,
      proceed: () => Promise<void>,
    ): Promise<boolean> => {
      if (vaultKey) {
        return proceed().then(() => true);
      }
      return new Promise<boolean>((resolve, reject) => {
        setPendingUnlock((current) => {
          // A second tap while the prompt is open replaces the first; the
          // first resolves as not decided so its spinner stops.
          current?.resolve(false);
          return { kind, request, proceed, resolve, reject };
        });
      });
    },
    [vaultKey],
  );

  useEffect(() => {
    if (!pendingUnlock || !vaultKey) return;
    const waiting = pendingUnlock;
    setPendingUnlock(null);
    // The actions ref is refreshed by the render that carried the new key, so
    // this runs the approve path that can see it.
    waiting.proceed().then(() => waiting.resolve(true), waiting.reject);
  }, [pendingUnlock, vaultKey]);

  const decide = useCallback(
    (
      kind: OwnerConsentDecisionKind,
      request: OwnerConsentRequest,
      durationHours?: number,
      hooks: OwnerConsentDecisionHooks = {},
    ): Promise<boolean> =>
      whenUnlocked(kind, request, () => {
        hooks.onStart?.();
        return run(kind, request, durationHours);
      }),
    [run, whenUnlocked],
  );

  const cancel = useCallback(() => {
    setPendingUnlock((current) => {
      current?.resolve(false);
      return null;
    });
  }, []);

  const unlockPrompt: OwnerConsentUnlockPrompt = {
    open: Boolean(pendingUnlock),
    title:
      pendingUnlock?.kind === "deny" ? "Unlock to decline" : "Unlock to allow",
    description: pendingUnlock
      ? pendingUnlock.kind === "deny"
        ? `Unlock your vault to answer ${pendingUnlock.request.requesterShortName}. Nothing is shared.`
        : `Your ${joinInformationLabels(pendingUnlock.request.labels)} stays encrypted on this device until you unlock. Nothing is shared before you do.`
      : "",
    cancel,
  };

  const allow = useCallback(
    (
      request: OwnerConsentRequest,
      durationHours?: number,
      hooks?: OwnerConsentDecisionHooks,
    ) => decide("allow", request, durationHours, hooks),
    [decide],
  );
  const deny = useCallback(
    (request: OwnerConsentRequest) => decide("deny", request),
    [decide],
  );

  /**
   * Don't allow with a five-second Undo (see deferred-consent-decline.ts).
   *
   * The unlock comes first, so the Undo window never ends in a prompt: once
   * the vault is open the row leaves, the toast offers Undo, and the deny goes
   * out when the window closes. Resolves true once the decline is scheduled,
   * false when the unlock was closed and nothing changed.
   */
  const declineWithUndo = useCallback(
    (request: OwnerConsentRequest, hooks: DeclineWithUndoHooks) =>
      whenUnlocked("deny", request, async () => {
        hooks.onHide();
        scheduleDecline({
          key: request.key,
          message: declineUndoMessage(request),
          onUndo: hooks.onRestore,
          send: () =>
            run("deny", request, undefined, { quiet: true }).catch(
              (error: unknown) => {
                // The quiet bundle path rejects with an owner-facing sentence.
                hooks.onRestore();
                toast.error(
                  error instanceof Error && error.message
                    ? error.message
                    : DECLINE_FAILED,
                );
              },
            ),
        });
      }),
    [run, scheduleDecline, whenUnlocked],
  );

  return {
    allow,
    deny,
    declineWithUndo,
    unlockPrompt,
    bundleProgress: actions.bundleProgress,
  };
}
