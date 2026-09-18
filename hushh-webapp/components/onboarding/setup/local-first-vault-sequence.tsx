"use client";

import { useState } from "react";
import { Eye, LockKeyhole, PauseCircle, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";

/**
 * The last stretch of setup, in plain language (dev-only, Workstream D3/D5).
 *
 * One idea per screen. Short sentences. No jargon, no hedging, nothing extra.
 * A six-year-old could follow it and an adult is not talked down to.
 *
 * These screens only appear when `isLocalFirstOnboardingEnabled()` is true.
 * They change the ORDER of setup, never the vault logic itself: the existing
 * `VaultUnlockDialog` / `VaultFlow` still owns every bootstrap mode.
 */

function SetupStoryScreen(props: {
  icon: LucideIcon;
  title: string;
  body: string;
  testId: string;
  titleId: string;
  children: React.ReactNode;
}) {
  const Icon = props.icon;
  return (
    <section
      className="motion-step-enter mx-auto flex min-h-[18rem] w-full max-w-[30rem] flex-col items-center justify-center text-center"
      aria-labelledby={props.titleId}
      data-testid={props.testId}
    >
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--app-accent-tint)] text-[var(--app-accent-deep)]"
        aria-hidden="true"
      >
        <Icon className="h-6 w-6" />
      </div>
      <h2
        id={props.titleId}
        className="mt-5 text-balance type-title2 text-foreground"
      >
        {props.title}
      </h2>
      <p className="mt-3 max-w-[28rem] text-pretty type-subhead text-muted-foreground">
        {props.body}
      </p>
      <div className="mt-8 flex w-full max-w-[24rem] flex-col gap-3">
        {props.children}
      </div>
    </section>
  );
}

/**
 * D3 — the single guided-connection screen.
 *
 * Shown once, after the private agent is ready, before anything moves. It is
 * the one moment where the person sees the handoff instead of it happening
 * behind their back.
 *
 * The body copy used to end "into your private agent", which described the
 * destination as if it were the present. The drain runs through
 * `PkmWriteCoordinator` into the person's encrypted records, which their agent
 * then reads. The records move to the pod itself later, and this sentence stays
 * true when they do.
 */
export function GuidedConnectionScreen({
  agentReady,
  busy,
  onContinue,
}: {
  agentReady?: boolean;
  busy?: boolean;
  onContinue: () => void;
}) {
  return (
    <SetupStoryScreen
      icon={Sparkles}
      titleId="one-setup-guided-connection-title"
      testId="one-setup-guided-connection"
      title={agentReady ? "Your private agent is ready" : "One last connection"}
      body="What you told us is on this device, encrypted. Next it moves into your private records, which only your agent reads."
    >
      <Button
        type="button"
        variant="blue-gradient"
        effect="fill"
        size="lg"
        fullWidth
        className="min-h-14 justify-center text-center"
        disabled={busy}
        onClick={onContinue}
        data-testid="one-setup-guided-connection-continue"
      >
        {busy ? "Connecting…" : "Connect"}
      </Button>
    </SetupStoryScreen>
  );
}

/** Shown while the buffered records are moving into the person's private records. */
export function BufferHandoffScreen() {
  return (
    <SetupStoryScreen
      icon={Sparkles}
      titleId="one-setup-buffer-handoff-title"
      testId="one-setup-buffer-handoff"
      title="Moving your details across"
      body="This takes a moment. You can stay on this screen."
    >
      <span className="sr-only" role="status">
        Moving your details into your private records.
      </span>
    </SetupStoryScreen>
  );
}

type ExplainerScreen = {
  id: string;
  icon: LucideIcon;
  title: string;
  body: string;
  action: string;
};

/**
 * D5 — three screens, one idea each, before the vault is created.
 *
 * The third one is deliberately about the cost of stopping. An expectation you
 * set out loud is a kindness; the same fact discovered later is a trap.
 */
const VAULT_EXPLAINER_SCREENS: [ExplainerScreen, ...ExplainerScreen[]] = [
  {
    id: "what",
    icon: LockKeyhole,
    title: "Your vault is a locked box",
    body: "Everything you save goes inside it. Nothing else can reach in.",
    action: "Next",
  },
  {
    id: "who",
    icon: Eye,
    title: "Only you can open it",
    body: "The key is made on this device and never leaves it. We cannot see inside — not even us.",
    action: "Next",
  },
  {
    id: "skip",
    icon: PauseCircle,
    title: "If you stop here, nothing is saved",
    body: "Your details stay on this device, encrypted. They move into your private records once your vault exists. You can finish this any time.",
    action: "Set up my vault",
  },
];

export function VaultExplainerScreens({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const [index, setIndex] = useState(0);
  const screen = VAULT_EXPLAINER_SCREENS[index] ?? VAULT_EXPLAINER_SCREENS[0];
  const isLast = index >= VAULT_EXPLAINER_SCREENS.length - 1;

  return (
    <div data-testid="one-setup-vault-explainer" data-explainer-step={screen.id}>
      <SetupStoryScreen
        icon={screen.icon}
        titleId="one-setup-vault-explainer-title"
        testId={`one-setup-vault-explainer-${screen.id}`}
        title={screen.title}
        body={screen.body}
      >
        <Button
          type="button"
          variant="blue-gradient"
          effect="fill"
          size="lg"
          fullWidth
          className="min-h-14 justify-center text-center"
          onClick={() => {
            if (isLast) {
              onComplete();
              return;
            }
            setIndex((current) => current + 1);
          }}
          data-testid="one-setup-vault-explainer-next"
        >
          {screen.action}
        </Button>
        {index > 0 ? (
          <Button
            type="button"
            variant="muted"
            effect="fade"
            size="sm"
            onClick={() => setIndex((current) => current - 1)}
            data-testid="one-setup-vault-explainer-back"
          >
            Back
          </Button>
        ) : null}
      </SetupStoryScreen>
      <div
        className="mt-6 flex items-center justify-center gap-2"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={VAULT_EXPLAINER_SCREENS.length}
        aria-valuenow={index + 1}
        aria-label={`Step ${index + 1} of ${VAULT_EXPLAINER_SCREENS.length}`}
      >
        {VAULT_EXPLAINER_SCREENS.map((entry, position) => (
          <span
            key={entry.id}
            className={
              position === index
                ? "h-1.5 w-6 rounded-full bg-[var(--app-accent)]"
                : "h-1.5 w-1.5 rounded-full bg-border"
            }
          />
        ))}
      </div>
    </div>
  );
}

export const VAULT_EXPLAINER_SCREEN_COUNT = VAULT_EXPLAINER_SCREENS.length;
