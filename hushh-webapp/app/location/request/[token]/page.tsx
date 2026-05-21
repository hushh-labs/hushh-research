"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
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
  if (!invite) return "A trusted person";
  return (
    [invite.ownerDisplayName, invite.ownerMaskedPhone]
      .filter(Boolean)
      .join(" - ") || "A trusted person"
  );
}

export default function PublicLocationRequestPage() {
  const params = useParams<{ token?: string }>();
  const publicToken = useMemo(
    () => String(params?.token || "").trim(),
    [params?.token],
  );
  const [invite, setInvite] = useState<OneLocationPublicInvite | null>(null);
  const [submission, setSubmission] =
    useState<OneLocationPublicInviteSubmission | null>(null);
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
              : "This request link is unavailable.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (publicToken) {
      void loadInvite();
    } else {
      setError("This request link is invalid.");
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
      toast.success("Request sent.");
    } catch (submitError) {
      toast.error(
        submitError instanceof Error
          ? submitError.message
          : "Could not send request.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const submittedCopy =
    submission?.status === "matched_request_pending"
      ? "Request sent. The owner must approve before encrypted location appears in your One Location Agent."
      : "Request sent. Sign in with this phone and open One Location Agent once so the owner can approve encrypted sharing.";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-5 py-10">
        <div className="space-y-6 rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-[var(--shadow-xs)] sm:p-7">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-700 dark:text-amber-200">
              {error ? (
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              ) : submission ? (
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Clock3 className="h-5 w-5" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-600 dark:text-amber-300">
                One Location
              </div>
              <h1 className="mt-2 text-3xl font-semibold tracking-normal sm:text-4xl">
                Request location access
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {loading
                  ? "Checking request link."
                  : error
                    ? error
                    : `${ownerLabel(invite)} will decide before location is shared.`}
              </p>
            </div>
          </div>

          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-10 w-36 rounded-xl" />
            </div>
          ) : null}

          {!loading && invite && !submission ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">
                  Expires {formatDateTime(invite.expiresAt)}
                </Badge>
                <Badge variant="outline">
                  {invite.durationHours}h request window
                </Badge>
              </div>
              <Input
                value={visitorDisplayName}
                onChange={(event) => setVisitorDisplayName(event.target.value)}
                placeholder="Your name"
                maxLength={120}
              />
              <Input
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                placeholder="Phone number"
                inputMode="tel"
                maxLength={32}
              />
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Optional message"
                rows={4}
                maxLength={500}
              />
              <Button onClick={() => void handleSubmit()} disabled={submitting}>
                {submitting ? (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                Send Request
              </Button>
            </div>
          ) : null}

          {submission ? (
            <div className="rounded-[var(--app-card-radius-standard)] border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm leading-6 text-emerald-800 dark:text-emerald-100">
              {submittedCopy}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
