"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard, SurfaceCardContent, SurfaceCardDescription, SurfaceCardHeader, SurfaceCardTitle } from "@/components/app-ui/surfaces";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { GoogleCalendarService, type GoogleCalendarStatus } from "@/lib/services/google-calendar-service";

export default function IntegrationsPage() {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    setStatus(await GoogleCalendarService.status(await user.getIdToken(), user.uid));
  }, [user]);

  useEffect(() => { void refresh().catch((error) => toast.error(error instanceof Error ? error.message : "Unable to load integrations.")); }, [refresh]);

  const connect = async (accessLevel: "read" | "manage") => {
    if (!user) return;
    setBusy(true);
    try {
      const start = await GoogleCalendarService.startConnect({ idToken: await user.getIdToken(), userId: user.uid, accessLevel });
      window.location.assign(start.authorize_url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to connect Calendar.");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!user) return;
    setBusy(true);
    try {
      setStatus(await GoogleCalendarService.disconnect(await user.getIdToken(), user.uid));
      toast.success("Calendar disconnected from Hussh.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to disconnect Calendar.");
    } finally { setBusy(false); }
  };

  return <AppPageShell><AppPageHeaderRegion><PageHeader title="Connected apps" description="Choose exactly what each service can access." /></AppPageHeaderRegion><AppPageContentRegion>
    <SurfaceCard><SurfaceCardHeader><CalendarDays className="size-5" /><SurfaceCardTitle>Google Calendar</SurfaceCardTitle><SurfaceCardDescription>{status?.connected ? `${status.google_email || "Google account"} · ${status.access_level === "manage" ? "View and manage events" : "View events and availability"}` : "Connect only when you want Calendar help from One."}</SurfaceCardDescription></SurfaceCardHeader><SurfaceCardContent className="flex flex-wrap gap-2">
      {loading || (!status && !user) ? <Loader2 className="size-4 animate-spin" /> : status?.connected ? <><Button disabled={busy || status.access_level === "manage"} onClick={() => void connect("manage")}>{status.access_level === "manage" ? "Scheduling enabled" : "Enable scheduling"}</Button><Button variant="muted" disabled={busy} onClick={() => void disconnect()}>Disconnect Calendar</Button></> : <><Button disabled={busy} onClick={() => void connect("read")}>Connect Calendar</Button><Button variant="muted" disabled={busy} onClick={() => void connect("manage")}>Connect with scheduling</Button></>}
    </SurfaceCardContent></SurfaceCard>
  </AppPageContentRegion></AppPageShell>;
}
