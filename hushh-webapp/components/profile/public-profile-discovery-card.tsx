"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { PublicProfileDiscoveryService, type PublicProfileDiscoveryJob } from "@/lib/services/public-profile-discovery-service";
import { Button } from "@/lib/morphy-ux/button";

function statusCopy(job: PublicProfileDiscoveryJob): string {
  switch (job.status) {
    case "queued":
    case "scanning":
      return "Still building your profile. We’ll notify you here.";
    case "ready":
      return "Your profile is ready to review.";
    case "needs_details":
      if (job.last_error_code === "no_reviewable_findings") return "We couldn’t prepare source-linked details to review. Add a public profile link or another search detail to try again.";
      return "We need one more detail to distinguish your public profile.";
    case "failed":
      if (job.last_error_code === "daily_budget_exhausted") return "Today’s search limit is reached. Your profile search will resume automatically when capacity is available.";
      if (job.last_error_code === "scan_retry_limit") return "We reached the retry limit for this one-time search. You can continue using One.";
      return "We couldn’t finish this search. You can retry with an extra detail.";
    case "claimed":
      return job.claim_decision === "rejected_all"
        ? "Your review is complete. Nothing was added to your private knowledge model."
        : "Your selected information was handed off to your private knowledge model.";
    case "cancelled":
      return "This profile search was cancelled.";
  }
}

export function PublicProfileDiscoveryCard({ userId, onboarding = false }: { userId?: string | null; onboarding?: boolean }) {
  const { user } = useAuth();
  const [job, setJob] = useState<PublicProfileDiscoveryJob | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [consent, setConsent] = useState(false);
  const [phoneConsent, setPhoneConsent] = useState(false);
  const [profileUrl, setProfileUrl] = useState("");
  const [nameHint, setNameHint] = useState("");
  const [emailHint, setEmailHint] = useState("");
  const [employer, setEmployer] = useState("");
  const [city, setCity] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user || (userId && user.uid !== userId)) return;
    try {
      const next = await PublicProfileDiscoveryService.getStatus(await user.getIdToken());
      setJob(next);
      setAvailable(true);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "profile_discovery_unavailable") {
        setAvailable(false);
      } else {
        setError("Profile discovery status is temporarily unavailable.");
      }
    } finally {
      setLoading(false);
    }
  }, [user, userId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (job?.status !== "queued" && job?.status !== "scanning") return;
    const timer = window.setInterval(() => { void refresh(); }, 12_000);
    return () => window.clearInterval(timer);
  }, [job?.status, refresh]);

  const start = async () => {
    if (!user || !consent || starting) return;
    setStarting(true);
    setError(null);
    try {
      const next = await PublicProfileDiscoveryService.start(await user.getIdToken(), {
        consent: true,
        consentVersion: "public_profile_discovery_v2",
        externalPhoneConsent: phoneConsent,
        ...(nameHint.trim() ? { name: nameHint.trim() } : {}),
        ...(emailHint.trim() ? { email: emailHint.trim() } : {}),
        ...(profileUrl.trim() ? { profileUrl: profileUrl.trim() } : {}),
        ...(employer.trim() ? { employer: employer.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
      });
      setJob(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn’t start the search. Please try again.");
    } finally {
      setStarting(false);
    }
  };

  if (!available || loading || job?.status === "claimed" || job?.status === "cancelled") return null;
  if (onboarding && job) return (
    <p className="mb-3 text-sm text-muted-foreground" role="status" aria-live="polite">
      {job.status === "ready" ? "Your profile is ready. You can review it after setting up your vault."
        : job.status === "needs_details" || job.status === "failed" ? "Your profile search needs attention. You can return to it after setup."
        : "Building your profile in the background. Continue setting up One."}
    </p>
  );

  return (
    <section className="mb-5 rounded-[var(--app-card-radius)] border border-border/70 bg-card p-4 sm:p-5" aria-labelledby="public-profile-discovery-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="public-profile-discovery-title" className="text-base font-semibold">Claim your public profile</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Review information already available on the public web, then choose what belongs in your private knowledge model. The profile name, source-linked findings, and public profile link may be retained in Hussh’s restricted pool for future exact-profile matches; your corrections and claim choice never change that pool or trigger another personal scan.
          </p>
        </div>
        {job ? <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{job.status === "ready" ? "Ready" : job.status === "failed" ? "Needs attention" : job.status === "needs_details" ? "Needs details" : "In progress"}</span> : null}
      </div>

      {job ? (
        <div className="mt-4" role="status" aria-live="polite">
          <p className="text-sm">{statusCopy(job)}</p>
          {job.status === "ready" ? <Link className="mt-3 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" href={ROUTES.ONE_PROFILE_DISCOVERY}>Review your profile</Link> : null}
          {(job.status === "needs_details" || job.status === "failed") ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {!user?.displayName || job.status === "needs_details" ? <Input aria-label="Name to search" placeholder="Name to search (optional)" value={nameHint} onChange={(event) => setNameHint(event.target.value)} /> : null}
              {!user?.email || job.status === "needs_details" ? <Input aria-label="Email to search" type="email" placeholder="Email to search (optional)" value={emailHint} onChange={(event) => setEmailHint(event.target.value)} /> : null}
              <Input aria-label="Public profile URL" type="url" placeholder="Public profile URL (optional)" value={profileUrl} onChange={(event) => setProfileUrl(event.target.value)} />
              <Input aria-label="Employer" placeholder="Employer (optional)" value={employer} onChange={(event) => setEmployer(event.target.value)} />
              <Input aria-label="City" placeholder="City (optional)" value={city} onChange={(event) => setCity(event.target.value)} />
              <Button type="button" variant="blue" effect="fill" disabled={starting || job.last_error_code === "scan_retry_limit"} onClick={() => void (async () => {
                if (!user) return;
                setStarting(true);
                setError(null);
                try {
                  setJob(await PublicProfileDiscoveryService.submitAnchors(await user.getIdToken(), {
                    ...(nameHint.trim() ? { name: nameHint.trim() } : {}),
                    ...(emailHint.trim() ? { email: emailHint.trim() } : {}),
                    ...(profileUrl.trim() ? { profileUrl: profileUrl.trim() } : {}),
                    ...(employer.trim() ? { employer: employer.trim() } : {}),
                    ...(city.trim() ? { city: city.trim() } : {}),
                  }));
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "We couldn’t resume the search. Please try again.");
                } finally {
                  setStarting(false);
                }
              })()}>{starting ? "Resuming…" : "Continue search"}</Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {!user?.displayName ? <Input aria-label="Name to search" placeholder="Name to search (optional)" value={nameHint} onChange={(event) => setNameHint(event.target.value)} /> : null}
            {!user?.email ? <Input aria-label="Email to search" type="email" placeholder="Email to search (optional)" value={emailHint} onChange={(event) => setEmailHint(event.target.value)} /> : null}
            <Input aria-label="Public profile URL" type="url" placeholder="Public profile URL (optional)" value={profileUrl} onChange={(event) => setProfileUrl(event.target.value)} />
            <Input aria-label="Employer" placeholder="Employer (optional)" value={employer} onChange={(event) => setEmployer(event.target.value)} />
            <Input aria-label="City" placeholder="City (optional)" value={city} onChange={(event) => setCity(event.target.value)} />
          </div>
          <label className="flex min-h-11 items-start gap-3 py-2 text-sm leading-5">
            <input className="mt-1 size-4 accent-primary" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>I agree to a one-time public-web search using my name, account email, and any details I add below. I understand the profile name, source-linked findings, and public profile link may be retained for future exact-profile matches in Hussh’s restricted pool. My corrections, claim choice, and account deletion do not remove that shared record; this release has no self-serve or scheduled pool removal. I’ll review findings before anything is added to my private knowledge model.</span>
          </label>
          <label className="flex min-h-11 items-start gap-3 py-2 text-sm leading-5">
            <input className="mt-1 size-4 accent-primary" type="checkbox" checked={phoneConsent} onChange={(event) => setPhoneConsent(event.target.checked)} />
            <span>Optional: allow the discovery provider to use my verified phone number as an additional matching signal. It is not sent unless I check this.</span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="blue" effect="fill" disabled={!consent || starting} onClick={() => void start()}>{starting ? "Starting search…" : "Start one-time search"}</Button>
            <span className="text-xs text-muted-foreground">You can continue setup while the search runs.</span>
          </div>
        </div>
      )}
      {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
    </section>
  );
}
