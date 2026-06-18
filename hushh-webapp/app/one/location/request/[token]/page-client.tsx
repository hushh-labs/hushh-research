"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MapPin,
  Navigation,
  Route,
  Send,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationPublicInvite,
  OneLocationPublicInviteSubmission,
  PlainLocationPoint,
} from "@/lib/one-location/types";

function formatDateTime(value?: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function ownerLabel(invite: OneLocationPublicInvite | null): string {
  return invite?.ownerLabel || "a trusted person";
}

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : "0.000000";
}

function coordinateQuery(point: PlainLocationPoint): string {
  return `${formatCoordinate(point.latitude)},${formatCoordinate(point.longitude)}`;
}

function googleMapsEmbedUrl(point: PlainLocationPoint): string {
  return `https://www.google.com/maps?q=${encodeURIComponent(coordinateQuery(point))}&z=16&output=embed`;
}

function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    coordinateQuery(point),
  )}&travelmode=driving`;
}

function googleMapsStartUrl(point: PlainLocationPoint): string {
  return `${googleMapsDirectionsUrl(point)}&dir_action=navigate`;
}

function PublicLocationMap({ point }: { point: PlainLocationPoint }) {
  const capturedAt = formatDateTime(point.capturedAt);
  const accuracy =
    typeof point.accuracyM === "number" && Number.isFinite(point.accuracyM)
      ? `Accuracy +/- ${Math.round(point.accuracyM)} m`
      : null;
  return (
    <div className="overflow-hidden rounded-[24px] border border-black/[0.04] bg-white/95 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_14px_34px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90">
      <div className="relative h-64 overflow-hidden bg-muted sm:h-72">
        <iframe
          title="Public location map"
          src={googleMapsEmbedUrl(point)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
          className="h-full w-full border-0"
        />
        <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 rounded-full border border-emerald-300/40 bg-emerald-950/75 px-3 py-1.5 text-xs font-semibold text-emerald-50 shadow-lg backdrop-blur-xl">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
          Public location
        </div>
      </div>
      <div className="space-y-4 p-4">
        <div className="min-w-0">
          <p className="text-[16px] font-semibold text-[#1c1c1e] dark:text-white">
            Shared location
          </p>
          <p className="mt-1 text-[13px] leading-5 text-[#6e6e73] dark:text-white/60">
            Updated {capturedAt}
            {accuracy ? ` - ${accuracy}` : ""}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button asChild variant="outline" size="sm" className="h-11 rounded-full border-black/[0.06] bg-[#f2f2f7] text-[#1c1c1e] hover:bg-[#e5e5ea] dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15">
            <a
              href={googleMapsDirectionsUrl(point)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Route className="h-4 w-4" aria-hidden="true" />
              Directions
            </a>
          </Button>
          <Button asChild size="sm" className="h-11 rounded-full bg-[#007aff] text-white shadow-[0_10px_24px_rgba(0,122,255,0.22)] hover:bg-[#006fe6]">
            <a
              href={googleMapsStartUrl(point)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Navigation className="h-4 w-4" aria-hidden="true" />
              Start
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PublicLocationRequestPageClient() {
  const params = useParams<{ token?: string }>();
  const publicToken = useMemo(
    () => String(params?.token || "").trim(),
    [params?.token],
  );
  const [invite, setInvite] = useState<OneLocationPublicInvite | null>(null);
  const [submission, setSubmission] =
    useState<OneLocationPublicInviteSubmission | null>(null);
  const [publicLocation, setPublicLocation] =
    useState<PlainLocationPoint | null>(null);
  const [visitorDisplayName, setVisitorDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadInvite = async () => {
      setLoading(true);
      setError(null);
      try {
        const response =
          await OneLocationService.resolvePublicInvite(publicToken);
        if (!cancelled) setInvite(response.invite);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "This public location link is unavailable.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (publicToken) {
      void loadInvite();
    } else {
      setError("This public location link is invalid.");
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [publicToken]);

  const handleSubmit = async () => {
    if (!visitorDisplayName.trim() || !phoneNumber.trim()) {
      toast.error("Enter your name and phone number.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await OneLocationService.submitPublicInviteRequest({
        publicToken,
        visitorDisplayName: visitorDisplayName.trim(),
        phoneNumber: phoneNumber.trim(),
        message: message.trim() || undefined,
      });
      setSubmission(response.submission);
      setPublicLocation(response.publicLocation ?? null);
      toast.success("Location ready.");
    } catch (submitError) {
      toast.error(
        submitError instanceof Error
          ? submitError.message
          : "Could not open this public location.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f5f5f7] text-[#1c1c1e] dark:bg-[#050506] dark:text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-[620px] flex-col justify-center px-5 py-10">
        <div className="space-y-7">
          <div className="text-center">
            <div className="mx-auto flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[#eaf3ff] text-[#007aff] shadow-[0_14px_32px_rgba(0,122,255,0.12)] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
              {error ? (
                <AlertTriangle className="h-7 w-7" aria-hidden="true" />
              ) : publicLocation ? (
                <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
              ) : (
                <MapPin className="h-7 w-7" aria-hidden="true" />
              )}
            </div>
            <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#007aff] dark:text-[#76b7ff]">
              One Location
            </div>
            <h1 className="mt-2 text-[40px] font-semibold leading-[1.06] tracking-normal sm:text-[48px]">
              View shared location.
            </h1>
            <p className="mx-auto mt-4 max-w-[500px] text-[17px] leading-7 text-[#6e6e73] dark:text-white/60">
              {loading
                ? "Checking public location link."
                : error
                  ? error
                  : publicLocation
                    ? `${ownerLabel(invite)} shared this public location with you.`
                    : `Enter your details to view ${ownerLabel(invite)}'s public location.`}
            </p>
          </div>

          {loading ? (
            <div className="space-y-3 rounded-[28px] bg-white/95 p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_14px_34px_rgba(15,23,42,0.06)] dark:bg-[#1c1c1e]/90">
              <Skeleton className="h-12 rounded-[18px]" />
              <Skeleton className="h-12 rounded-[18px]" />
              <Skeleton className="h-28 rounded-[20px]" />
              <Skeleton className="h-11 w-40 rounded-full" />
            </div>
          ) : null}

          {!loading && invite && !submission ? (
            <div className="space-y-4 rounded-[28px] border border-black/[0.04] bg-white/95 p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_14px_34px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 sm:p-6">
              <div className="flex flex-wrap items-center justify-center gap-2 text-sm sm:justify-start">
                <Badge variant="secondary">
                  Expires {formatDateTime(invite.expiresAt)}
                </Badge>
                <Badge variant="outline">
                  {invite.durationHours}h public viewing window
                </Badge>
              </div>
              <Input
                value={visitorDisplayName}
                onChange={(event) => setVisitorDisplayName(event.target.value)}
                placeholder="Your name"
                autoComplete="name"
                maxLength={120}
                className="h-12 rounded-[18px] border-black/[0.06] bg-[#f7f7fa] text-[16px] shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]"
              />
              <Input
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                placeholder="Phone number"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={32}
                className="h-12 rounded-[18px] border-black/[0.06] bg-[#f7f7fa] text-[16px] shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]"
              />
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Optional message"
                rows={4}
                maxLength={500}
                className="min-h-28 rounded-[20px] border-black/[0.06] bg-[#f7f7fa] text-[16px] shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]"
              />
              <Button
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="h-12 w-full rounded-full bg-[#007aff] text-[15px] font-semibold text-white shadow-[0_14px_30px_rgba(0,122,255,0.24)] hover:bg-[#006fe6]"
              >
                {submitting ? (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                View Location
              </Button>
            </div>
          ) : null}

          {submission && publicLocation ? (
            <PublicLocationMap point={publicLocation} />
          ) : submission ? (
            <div className="rounded-[24px] border border-amber-500/30 bg-amber-500/10 p-4 text-[14px] leading-6 text-amber-800 dark:text-amber-100">
              This link was opened, but no public location snapshot is attached.
              Ask the sender to create a fresh public location link.
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
