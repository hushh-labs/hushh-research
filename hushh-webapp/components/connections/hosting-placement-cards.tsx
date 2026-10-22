"use client";

import { useEffect } from "react";

import { GoogleCloudLogo } from "@/components/brand/google-cloud-logo";
import { MicrosoftAzureLogo } from "@/components/brand/microsoft-azure-logo";
import type { HostingChoiceOption } from "@/components/connections/hosting-choice-cards";
import {
  DedicatedHostingRowIcon,
  OwnCloudRowIcon,
  PauseRowIcon,
  SharedHostingRowIcon,
} from "@/components/icons";
import { ROUTES } from "@/lib/navigation/routes";
import {
  attachBlockedCopy,
  type ConsentPendingEntry,
  type DirectIngressBlocker,
} from "@/lib/one/hosting-placement";

/**
 * The cloud step's placement states between "chose a tier" and "talking to the
 * agent directly". Each card says where things stand and offers the one next move.
 */

const CARD = "space-y-2 rounded-2xl border border-[var(--app-border)] p-4";
const BODY = "text-sm text-[var(--app-text-secondary)]";
const ACTION = "min-h-11 self-start text-sm underline underline-offset-4 disabled:opacity-60";

/** How often a connecting agent is re-checked while this screen is open. */
export const CONNECTING_POLL_MS = 5_000;

/** The three tier cards. Your own cloud leads: it is the agent Hussh is built around. */
export function hostingOptionsFor({
  azureSelectable,
  hostedUnderMaintenance,
}: {
  azureSelectable: boolean;
  hostedUnderMaintenance: boolean;
}): HostingChoiceOption[] {
  return [
    {
      value: "own",
      icon: OwnCloudRowIcon,
      title: "Bring your own cloud",
      description: azureSelectable
        ? "Your agent runs in your own Google Cloud Platform or Microsoft Azure account. You own it and pay for it."
        : "Your agent runs in your own Google Cloud Platform account. You own it and pay for it.",
      supporting: (
        <>
          <GoogleCloudLogo decorative className="h-4" />
          {azureSelectable ? <MicrosoftAzureLogo decorative className="h-4 w-4" /> : null}
        </>
      ),
      supportingDecorative: true,
      testId: "cloud-tier-own",
    },
    {
      value: "shared",
      icon: SharedHostingRowIcon,
      title: "Hussh Shared",
      description: "Start right away. Your private information stays locked to you.",
      supporting: "Not a dedicated agent. You can move to your own cloud later.",
      testId: "cloud-tier-shared-option",
    },
    {
      value: "hosted",
      icon: DedicatedHostingRowIcon,
      title: "Hussh Pods",
      description: "A dedicated agent we run for you.",
      supporting: hostedUnderMaintenance ? (
        <>
          <PauseRowIcon size={14} color="currentColor" aria-hidden="true" />
          Paused for maintenance
        </>
      ) : undefined,
      unavailable: hostedUnderMaintenance,
      testId: "cloud-tier-hosted",
    },
  ];
}

/** A begun own-cloud setup whose sign-in has not come back yet. */
export function ConsentPendingCard({
  entry,
  busy,
  onContinue,
  onChooseShared,
}: {
  entry: ConsentPendingEntry;
  busy: boolean;
  onContinue: (() => void) | null;
  onChooseShared: () => void;
}) {
  const cloud = entry.provider === "azure" ? "Microsoft" : "Google";
  return (
    <div className={CARD} data-testid="hosting-consent-pending" aria-live="polite">
      <p className="text-sm font-semibold">Finish signing in to set up your cloud</p>
      <p className={BODY}>
        Your setup starts once {cloud} sends you back here. Nothing runs on Hussh Shared in
        the meantime.
      </p>
      <div className="flex flex-wrap gap-x-5">
        {onContinue ? (
          <button type="button" className={ACTION} disabled={busy} onClick={onContinue}
            data-testid="hosting-consent-continue">
            Sign in again
          </button>
        ) : null}
        <button type="button" className={ACTION} disabled={busy} onClick={onChooseShared}
          data-testid="hosting-consent-choose-shared">
          Use Hussh Shared instead
        </button>
      </div>
    </div>
  );
}

/** An own-cloud agent on its way to answering this app directly. Re-checks on its own. */
export function ConnectingToAgentCard({ onRefresh }: { onRefresh: () => void }) {
  useEffect(() => {
    const timer = setInterval(onRefresh, CONNECTING_POLL_MS);
    return () => clearInterval(timer);
  }, [onRefresh]);
  return (
    <div className={CARD} data-testid="hosting-connecting" aria-live="polite">
      <p className="text-sm font-semibold">Connecting to your agent</p>
      <p className={BODY}>
        Your agent is starting in your own cloud. This updates by itself once your agent
        answers this app directly.
      </p>
    </div>
  );
}

/** The automatic attach after a recorded setup stopped; the reason, typed by the hub. */
export function AttachBlockedCard({ code, onRetry }: { code: string; onRetry: () => void }) {
  const copy = attachBlockedCopy(code);
  if (!copy) return null;
  return (
    <div className={CARD} role="status" data-testid="hosting-attach-blocked" data-code={code}>
      <p className="text-sm font-semibold">Your cloud is connected</p>
      <p className={BODY}>{copy.message}</p>
      {copy.needsPhone ? (
        <a className={ACTION} href={ROUTES.PHONE_MANDATE} data-testid="hosting-attach-verify-phone">
          Verify your phone number
        </a>
      ) : (
        <button type="button" className={ACTION} onClick={onRetry}
          data-testid="hosting-attach-retry">
          Try again
        </button>
      )}
    </div>
  );
}

/** Direct access refused by the owner's organization policy (typed by the hub). */
export function DirectIngressBlockedCard({
  blocker,
  onRetry,
}: {
  blocker: DirectIngressBlocker;
  onRetry: () => void;
}) {
  return (
    <div className={CARD} role="alert" data-testid="hosting-direct-blocked" data-code={blocker.code}>
      <p className="text-sm font-semibold">Your organization&rsquo;s policy blocks direct access</p>
      <p className={BODY}>
        {blocker.message ??
          "Your agent is running in your cloud, and a policy there does not allow this app to reach it directly. Ask your cloud administrator to allow public access for your agent, then try again."}
      </p>
      <p className={BODY}>Hussh does not work around the policy.</p>
      {blocker.retryable ? (
        <button type="button" className={ACTION} onClick={onRetry} data-testid="hosting-direct-retry">
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Hussh Pods is paused: the two ways forward. Neither changes anything until chosen. */
export function HusshPodsPausedCard() {
  // No move buttons: the hub refuses both moves while a Hussh Pods place is held
  // (POD_ASSIGNMENT_PRESERVED). Offering them would be a button that always fails.
  return (
    <div className={CARD} data-testid="hussh-pods-paused">
      <p className="text-sm font-semibold">Hussh Pods is paused</p>
      <p className={BODY}>
        Your Hussh Pods agent and its information stay where they are. Moving it to your own
        cloud or to Hussh Shared needs the Hussh team to release your Hussh Pods place first.
        Once they do, this screen shows the choice.
      </p>
    </div>
  );
}
