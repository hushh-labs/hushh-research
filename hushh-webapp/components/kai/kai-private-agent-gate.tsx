"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { BodyText, PageTitle, SupportingText } from "@/components/app-ui/typography";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { useKaiPlacement } from "@/lib/kai/kai-placement";
import { useAuth } from "@/lib/firebase/auth-context";
import { Button } from "@/lib/morphy-ux/button";
import { resolveAppRouteLayoutMode } from "@/lib/navigation/app-route-layout";
import { ApiService } from "@/lib/services/api-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

/**
 * Kai renders only for a Shared owner. Everyone else sees, plainly, that Kai is
 * coming to their own agent, and can switch to Hussh Shared in 1 click if they
 * want to use standalone Finance right now without losing any data.
 */
export function KaiPrivateAgentGate({ children }: { children: ReactNode }) {
  const { user, loading, accountPrincipal } = useAuth();
  const pathname = usePathname();
  const [attempt, setAttempt] = useState(0);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const principal = !loading && accountPrincipal?.firebaseUid === user?.uid
    ? accountPrincipal : null;
  const placement = useKaiPlacement(principal, attempt);
  if (placement === "shared") return <>{children}</>;
  if (placement === "checking") return <HushhLoader label="Opening Finance…" />;

  async function handleSwitchToShared() {
    if (switching || !principal) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await ApiService.switchHostingMode({ target: "shared" });
      await PreVaultUserStateService.bootstrapState(principal.ownerId, {
        force: true,
      }).catch(() => undefined);
      dispatchFeedStateChanged();
      setAttempt((value) => value + 1);
    } catch (error) {
      setSwitchError(
        error instanceof Error && error.message
          ? error.message
          : "Could not switch to Hussh Shared right now. Try again in a moment.",
      );
    } finally {
      setSwitching(false);
    }
  }

  const fallback = (
    <section
      className="mx-auto flex max-w-md flex-col gap-3 px-4 py-16 text-center"
      data-kai-placement={placement}
      aria-live="polite"
    >
      {placement === "private" ? (
        <>
          <PageTitle>Kai is coming to your agent</PageTitle>
          <BodyText>
            Your agent runs privately, so Kai will run inside it too. Your finance questions
            and holdings will stay with your agent and never pass through Hussh.
          </BodyText>
          <SupportingText>Kai will be available on your agent soon.</SupportingText>
          <SupportingText>
            Need standalone Finance today? Switch to Hussh Shared anytime and switch back to
            Confidential Sandbox in Hosting with zero data loss.
          </SupportingText>
          {switchError ? (
            <SupportingText className="text-destructive">{switchError}</SupportingText>
          ) : null}
          <div className="mt-2 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <Button
              type="button"
              disabled={switching || !principal}
              onClick={() => void handleSwitchToShared()}
              data-testid="kai-switch-to-shared"
            >
              {switching ? "Switching to Hussh Shared…" : "Switch to Hussh Shared"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <PageTitle>Kai could not check where your agent runs</PageTitle>
          <BodyText>Try again in a moment.</BodyText>
          <div>
            <Button onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
          </div>
        </>
      )}
    </section>
  );
  return resolveAppRouteLayoutMode(pathname ?? "/one/kai") === "flow"
    ? <FullscreenFlowShell width="agent">{fallback}</FullscreenFlowShell>
    : fallback;
}
