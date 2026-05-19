"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, LocateFixed, MapPin, Radio, RefreshCw, Send, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_PUBLIC_LIVE_POLL_INTERVAL_MS,
  buildMapsUrls,
  KaiLocationSharingService,
} from "@/lib/location-sharing/service";
import type { LocationAccessRequestResponse, LocationPublicView } from "@/lib/location-sharing/types";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function SharedLocationFallback() {
  return (
    <main className="min-h-dvh bg-background px-4 py-6 text-foreground sm:px-6">
      <div className="mx-auto w-full max-w-5xl rounded-md border p-6">
        <p className="text-sm text-muted-foreground">Loading shared location...</p>
      </div>
    </main>
  );
}

function BadgeLikeLiveIndicator({ stale }: { stale: boolean }) {
  return (
    <span
      className={
        stale
          ? "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
          : "inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white"
      }
    >
      <Radio className="size-3" aria-hidden="true" />
      {stale ? "Delayed" : "Live"}
    </span>
  );
}

function SharedLocationContent() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<LocationPublicView | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [requestResult, setRequestResult] = useState<LocationAccessRequestResponse | null>(null);
  const [requesterLabel, setRequesterLabel] = useState("");
  const [requesterMessage, setRequesterMessage] = useState("");

  const activeLatest = view?.state === "active" && view.latest ? view.latest : null;
  const activeShare = activeLatest ? view?.share : null;
  const maps = useMemo(() => (activeLatest ? buildMapsUrls(activeLatest) : null), [activeLatest]);
  const pollIntervalMs = Math.max(
    view?.live?.pollIntervalMs ?? DEFAULT_PUBLIC_LIVE_POLL_INTERVAL_MS,
    5_000
  );
  const staleAfterSeconds = view?.live?.staleAfterSeconds ?? 90;
  const freshnessSeconds = view?.live?.freshnessSeconds;
  const stale =
    typeof freshnessSeconds === "number" && freshnessSeconds > staleAfterSeconds;

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") || "");
  }, []);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (token === null) return;
    if (!token) {
      setView({ state: "invalid", canRequestAccess: false, share: null, latest: null });
      setLoading(false);
      return;
    }
    if (!options?.silent) setLoading(true);
    try {
      const nextView = await KaiLocationSharingService.resolvePublicShare(token);
      setView(nextView);
    } catch (error) {
      if (!options?.silent) {
        toast.error(error instanceof Error ? error.message : "Could not open this location link.");
        setView({ state: "invalid", canRequestAccess: false, share: null, latest: null });
      }
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token !== null) {
      void load();
    }
  }, [load, token]);

  useEffect(() => {
    if (token === null || !token || view?.state !== "active") return;
    const intervalId = window.setInterval(() => {
      void load({ silent: true });
    }, pollIntervalMs);
    return () => window.clearInterval(intervalId);
  }, [load, pollIntervalMs, token, view?.state]);

  const requestAccess = useCallback(async () => {
    if (!token) return;
    setRequesting(true);
    try {
      const result = await KaiLocationSharingService.requestAccess({
        token,
        requesterLabel,
        requesterMessage,
      });
      setRequestResult(result);
      if (result.status === "auto_approved" && result.publicView) {
        setView(result.publicView);
        toast.success("Location access renewed.");
      } else {
        toast.success("Access request sent.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not request access.");
    } finally {
      setRequesting(false);
    }
  }, [requesterLabel, requesterMessage, token]);

  const active = Boolean(activeLatest);
  const invalidTitle =
    view?.state === "revoked"
      ? "Live location stopped"
      : view?.state === "expired" || view?.state === "deactivated"
        ? "Location link expired"
        : "Location link invalid";

  return (
    <main className="min-h-dvh bg-background px-4 py-6 text-foreground sm:px-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-card">
              <MapPin className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                KAI Location
              </p>
              <h1 className="text-2xl font-semibold leading-tight">
                {active ? "Shared Location" : invalidTitle}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Location is visible only while this bearer link is active.
              </p>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} isLoading={loading}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        </header>

        {loading ? (
          <section className="rounded-md border p-6">
            <p className="text-sm text-muted-foreground">Loading shared location...</p>
          </section>
        ) : activeLatest && maps ? (
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="overflow-hidden rounded-md border bg-card">
              <iframe
                title="KAI shared location map"
                src={maps.osmEmbed}
                className="h-[420px] w-full border-0"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            </div>
            <aside className="space-y-4 rounded-md border bg-card p-4">
              <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div>
                  <p className="text-xs text-muted-foreground">Live status</p>
                  <p className="mt-1 text-sm font-medium">
                    {stale ? "Waiting for update" : "Live"}
                  </p>
                </div>
                <BadgeLikeLiveIndicator stale={stale} />
              </div>
              <div>
                <p className="text-sm font-medium">Coordinates</p>
                <p className="mt-1 font-mono text-sm">
                  {activeLatest.latitude.toFixed(6)}, {activeLatest.longitude.toFixed(6)}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Accuracy</p>
                  <p className="mt-1 font-medium">
                    {activeLatest.accuracyM ? `${Math.round(activeLatest.accuracyM)}m` : "Unknown"}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Freshness</p>
                  <p className="mt-1 font-medium">
                    {typeof freshnessSeconds === "number"
                      ? `${freshnessSeconds}s ago`
                      : formatDateTime(activeLatest.capturedAt)}
                  </p>
                </div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <p className="text-xs text-muted-foreground">Expires</p>
                <p className="mt-1 font-medium">{formatDateTime(activeShare?.expiresAt)}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button asChild>
                  <a href={maps.google} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Open in Google Maps
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a href={maps.apple} target="_blank" rel="noreferrer">
                    <LocateFixed aria-hidden="true" />
                    Open in Apple Maps
                  </a>
                </Button>
              </div>
            </aside>
          </section>
        ) : (
          <section className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="rounded-md border bg-card p-5">
              <ShieldAlert className="size-8 text-amber-600" aria-hidden="true" />
              <h2 className="mt-4 text-lg font-semibold">{invalidTitle}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {view?.state === "revoked"
                  ? "The KAI owner stopped this live location share. Coordinates are hidden now."
                  : "The original access window is no longer active. Coordinates are hidden until the KAI owner grants access again."}
              </p>
            </div>
            <div className="rounded-md border bg-card p-5">
              <h2 className="text-lg font-semibold">Request access again</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Friends and non-auto family recipients require owner approval. Trusted family
                recipients may renew automatically if the owner enabled it.
              </p>
              {view?.canRequestAccess ? (
                <div className="mt-4 space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="location-requester-name">Your name</Label>
                    <Input
                      id="location-requester-name"
                      value={requesterLabel}
                      onChange={(event) => setRequesterLabel(event.target.value)}
                      placeholder="Optional"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="location-requester-message">Message</Label>
                    <Textarea
                      id="location-requester-message"
                      value={requesterMessage}
                      onChange={(event) => setRequesterMessage(event.target.value)}
                      placeholder="Optional"
                      rows={3}
                    />
                  </div>
                  <Button
                    type="button"
                    onClick={() => void requestAccess()}
                    isLoading={requesting}
                    disabled={requestResult?.status === "pending"}
                  >
                    <Send aria-hidden="true" />
                    {requestResult?.status === "pending" ? "Request sent" : "Request access"}
                  </Button>
                </div>
              ) : (
                <p className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  This link cannot request renewed access.
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

export default function SharedLocationPage() {
  return (
    <Suspense fallback={<SharedLocationFallback />}>
      <SharedLocationContent />
    </Suspense>
  );
}
