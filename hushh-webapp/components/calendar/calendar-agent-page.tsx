"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
} from "@/components/app-ui/surfaces";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import {
  clearCalendarSetupOAuthReturn,
  markCalendarSetupOAuthReturn,
} from "@/lib/calendar/calendar-oauth-journey";
import {
  GoogleCalendarService,
  type GoogleCalendarStatus,
} from "@/lib/services/google-calendar-service";

type CalendarAgentPageProps = {
  journeyVariant?: "workspace" | "onboarding";
  onConnectionStateChange?: (connected: boolean) => void;
  onFinishSetup?: () => void;
  onSkipSetup?: () => void;
  finishingSetup?: boolean;
  skippingSetup?: boolean;
};

/**
 * Calendar's normal and onboarding surfaces share one owner-bound connection
 * body. The OAuth callback returns to this agent workspace; no profile-level
 * connected-apps surface owns Calendar anymore.
 */
export function CalendarAgentPage({
  journeyVariant = "workspace",
  onConnectionStateChange,
  onFinishSetup,
  onSkipSetup,
  finishingSetup = false,
  skippingSetup = false,
}: CalendarAgentPageProps) {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    setStatus(
      await GoogleCalendarService.status(await user.getIdToken(), user.uid),
    );
  }, [user]);

  useEffect(() => {
    void refresh().catch((error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to load Calendar connection.",
      );
    });
  }, [refresh]);

  const connected =
    status?.connected === true && status.status !== "needs_reauth";

  useEffect(() => {
    onConnectionStateChange?.(connected);
  }, [connected, onConnectionStateChange]);

  const connect = async (accessLevel: "read" | "manage") => {
    if (!user) return;
    setBusy(true);
    try {
      if (journeyVariant === "onboarding") {
        markCalendarSetupOAuthReturn();
      } else {
        clearCalendarSetupOAuthReturn();
      }
      const start = await GoogleCalendarService.startConnect({
        idToken: await user.getIdToken(),
        userId: user.uid,
        accessLevel,
      });
      window.location.assign(start.authorize_url);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to connect Calendar.",
      );
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const next = await GoogleCalendarService.disconnect(
        await user.getIdToken(),
        user.uid,
      );
      setStatus(next);
      toast.success("Calendar disconnected from Hussh.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to disconnect Calendar.",
      );
    } finally {
      setBusy(false);
    }
  };

  const detail = connected
    ? `${status?.google_email || "Google account"} · ${
        status?.access_level === "manage"
          ? "View and manage events"
          : "View events and availability"
      }`
    : "Connect Calendar only when you want help with your schedule.";

  return (
    <AppPageShell>
      <AppPageHeaderRegion>
        <PageHeader
          title="Calendar"
          description="Summarize your schedule, find time, and confirm meeting changes."
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SurfaceCard>
          <SurfaceCardHeader>
            <CalendarDays className="size-5" />
            <SurfaceCardTitle>Google Calendar</SurfaceCardTitle>
            <SurfaceCardDescription>{detail}</SurfaceCardDescription>
          </SurfaceCardHeader>
          <SurfaceCardContent className="flex flex-wrap gap-2">
            {loading || (!status && !user) ? (
              <Loader2 className="size-4 animate-spin" />
            ) : connected ? (
              <>
                <Button
                  disabled={busy || status?.access_level === "manage"}
                  onClick={() => void connect("manage")}
                >
                  {status?.access_level === "manage"
                    ? "Scheduling enabled"
                    : "Enable scheduling"}
                </Button>
                <Button
                  variant="muted"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect Calendar
                </Button>
              </>
            ) : (
              <>
                <Button
                  disabled={busy}
                  onClick={() => void connect("read")}
                  data-voice-control-id="open_calendar_connector"
                  data-voice-action-id={
                    journeyVariant === "onboarding"
                      ? "setup.connect_calendar"
                      : undefined
                  }
                  data-voice-label="Connect Calendar"
                  data-voice-purpose="starts Google Calendar authorization from this Calendar agent."
                >
                  Connect Calendar
                </Button>
                <Button
                  variant="muted"
                  disabled={busy}
                  onClick={() => void connect("manage")}
                >
                  Connect with scheduling
                </Button>
              </>
            )}
          </SurfaceCardContent>
        </SurfaceCard>

        {journeyVariant === "onboarding" && onFinishSetup && onSkipSetup ? (
          <SetupCompletionFooter
            label={connected ? "Finish Calendar setup" : "Skip Calendar setup"}
            onComplete={connected ? onFinishSetup : onSkipSetup}
            busy={connected ? finishingSetup : skippingSetup}
            disabled={busy}
            controlId={
              connected ? "finish_calendar_setup" : "skip_calendar_setup"
            }
            actionId={
              connected ? "setup.finish_calendar" : "setup.skip_calendar"
            }
            purpose={
              connected
                ? "records the verified Calendar connection and returns to setup."
                : "returns to setup without recording Calendar as complete."
            }
            variant={connected ? "blue-gradient" : "none"}
            effect={connected ? "fill" : "fade"}
            supportingText={
              connected
                ? undefined
                : "You can connect Calendar from setup whenever you are ready."
            }
          />
        ) : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
