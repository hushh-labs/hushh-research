"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { Button } from "@/lib/morphy-ux/button";
import { LocationBus } from "@/lib/one-location/location-bus";

type PrimerPhase = "checking" | "ask" | "asking" | "done";

/**
 * The one place One asks the device for a position.
 *
 * It runs inside setup so the ask happens once, early, in a screen that says
 * why — and the fix it produces lands on the shared LocationBus, where every
 * agent and surface reads it. Nothing downstream needs to prompt again.
 *
 * Two rules this screen exists to enforce:
 * - The OS dialog fires from a tap, never from mount. iOS grants exactly one
 *   system prompt per install; spending it before the user has read anything
 *   converts a recoverable "later" into a permanent "no".
 * - A refusal never blocks setup. It resolves the screen like any other answer.
 *
 * It self-skips when the OS has already decided, so re-entering the step never
 * shows a dead screen and a denial is never nagged at.
 */
export function LocationPermissionPrimerGate({
  children,
}: {
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<PrimerPhase>("checking");
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const permission = await LocationBus.syncPermission();
      if (cancelled) return;

      if (permission === "granted") {
        // Already granted elsewhere: seed the bus quietly and move on.
        void LocationBus.ensure();
        setPhase("done");
        return;
      }
      // Denied/restricted/unavailable cannot be re-prompted from here, so
      // showing the ask would be a button that does nothing.
      setPhase(
        permission === "prompt" || permission === null ? "ask" : "done",
      );
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const allow = useCallback(async () => {
    setPhase("asking");
    const snapshot = await LocationBus.request();
    if (snapshot) {
      setPhase("done");
      return;
    }
    // Say what happened, then let them continue. Setup is never held hostage
    // to a permission.
    setDenied(true);
    setPhase("ask");
  }, []);

  if (phase === "done") return <>{children}</>;
  if (phase === "checking") return null;

  return (
    <FullscreenFlowShell
      width="reading"
      className="min-h-[calc(100dvh-var(--top-shell-reserved-height,0px))] justify-center px-[var(--page-inline-gutter-standard)] py-10"
      data-testid="location-permission-primer"
    >
      <section
        className="motion-step-enter mx-auto flex w-full max-w-[30rem] flex-col items-center text-center"
        aria-labelledby="location-permission-primer-title"
      >
        <h1
          id="location-permission-primer-title"
          className="type-display text-foreground"
        >
          Turn on location
        </h1>
        <p className="mt-3 type-title3 text-muted-foreground">
          Your agents work from where you are.
        </p>

        <div className="mt-10 w-full">
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="lg"
            fullWidth
            className="min-h-14 justify-center"
            disabled={phase === "asking"}
            onClick={() => void allow()}
            data-testid="location-permission-primer-allow"
          >
            {phase === "asking" ? "Waiting…" : "Allow"}
          </Button>
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="lg"
            fullWidth
            className="mt-2 text-muted-foreground"
            onClick={() => setPhase("done")}
            data-testid="location-permission-primer-skip"
          >
            Not now
          </Button>
        </div>

        {denied ? (
          <p
            className="mt-6 type-footnote text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            Location is off. Turn it on in Settings anytime.
          </p>
        ) : null}
      </section>
    </FullscreenFlowShell>
  );
}
