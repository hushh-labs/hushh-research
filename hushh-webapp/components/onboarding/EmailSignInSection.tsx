"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Mail } from "@/components/icons";
import { AuthProviderButton } from "./AuthProviderButton";
import styles from "./AuthStepLight.module.css";
import { cn } from "@/lib/utils";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { ApiService } from "@/lib/services/api-service";
import { LEGAL_CONTACT_EMAIL } from "@/lib/legal/legal-documents";
import { startJourneyTrace } from "@/lib/observability/journey-trace";
import {
  createEmailBrowserBinding, EmailAuthRequestError,
  type EmailChallenge, type EmailVerification,
} from "@/lib/auth/email-auth-contracts";

type Props = {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onExpandedChange: (expanded: boolean) => void;
  onAuthenticated: (customToken: string) => Promise<void>;
};

// Verify consumed the code, then the account changed (409) or the enrollment lapsed
// (409 at verify, 400 while finishing sign-in): that code can never succeed, so only a new code continues.
const staleCode = (error: unknown): error is EmailAuthRequestError => error instanceof EmailAuthRequestError
  && (error.code === "enrollment_expired" || error.status === 409 && error.code === "enrollment_changed");

export function EmailSignInSection({ disabled, onBusyChange, onExpandedChange, onAuthenticated }: Props) {
  const [view, setView] = useState<"closed" | "email" | "code" | "registration">("closed");
  const [available, setAvailable] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stale, setStale] = useState(false);
  const [trace] = useState(() => startJourneyTrace("email_code"));
  const [challenge, setChallenge] = useState<EmailChallenge | null>(null);
  const [registration, setRegistration] = useState<Extract<EmailVerification, { status: "registration_required" }> | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const now = useCoarseClock(1000);
  const binding = useRef<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void ApiService.emailAuthRequest<{ enabled: boolean }>("capabilities")
      .then((result) => { if (mounted.current) setAvailable(result.enabled); })
      .catch(() => { if (mounted.current) setAvailable(false); });
    return () => { mounted.current = false; generation.current += 1; onBusyChange(false); };
  }, [onBusyChange]);

  useEffect(() => { onExpandedChange(view !== "closed"); }, [view, onExpandedChange]);

  const remaining = Math.max(0, Math.ceil((challenge?.resend_at ?? 0) - now / 1000));
  const expirySeconds = challenge
    ? Math.max(0, Math.ceil((Date.parse(challenge.expires_at) - now) / 1000)) : 0;
  const expired = Boolean(challenge) && expirySeconds === 0;
  const expiryCountdown = `${Math.floor(expirySeconds / 60)}:${String(expirySeconds % 60).padStart(2, "0")}`;

  function reset() {
    generation.current += 1;
    binding.current = null;
    requestKey.current = null;
    setCode(""); setStale(false); setChallenge(null); setRegistration(null); setAccepted(false); setSubmitted(false); setNotice(""); setView("email");
  }

  async function operation(work: (epoch: number) => Promise<void>) {
    if (busy || disabled) return;
    const epoch = ++generation.current;
    setBusy(true); onBusyChange(true); setNotice("");
    try { await work(epoch); }
    catch (error) {
      if (mounted.current && generation.current === epoch) {
        setNotice(error instanceof EmailAuthRequestError ? error.message : "Could not finish sign-in. Please try again.");
      }
    } finally {
      if (mounted.current && generation.current === epoch) { setBusy(false); onBusyChange(false); }
    }
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    await operation(async (epoch) => {
      binding.current ??= createEmailBrowserBinding();
      requestKey.current ??= crypto.randomUUID();
      const result = await ApiService.emailAuthRequest<EmailChallenge>("request", {
        email, browser_binding: binding.current, request_key: requestKey.current,
      });
      if (!mounted.current || epoch !== generation.current) return;
      setChallenge(result); setCode(""); setStale(false); setRegistration(null); setAccepted(false); setSubmitted(false); setView("code");
    });
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (!challenge || !binding.current) return;
    await operation(async (epoch) => {
      const result = await ApiService.emailAuthRequest<EmailVerification>("verify", {
        challenge_id: challenge.challenge_id, code, browser_binding: binding.current!,
      }).catch((error: unknown) => {
        if (!staleCode(error)) throw error;
        trace("code_stale", { code: error.code, status: error.status });
        return null;
      });
      if (!mounted.current || epoch !== generation.current) return;
      setCode("");
      if (!result) { setStale(true); setNotice("Request a new sign-in code."); return; }
      if (result.status === "registration_required") {
        setRegistration(result); setAccepted(false); setSubmitted(false); setView("registration");
        return;
      }
      await onAuthenticated(result.custom_token);
    });
  }

  async function startFresh() {
    if (!challenge || !binding.current || registration?.registration.state !== "ready"
        || !registration.enrollment_ticket || !accepted || submitted) return;
    const reviewed = registration;
    await operation(async (epoch) => {
      // One explicit attempt. If its response is lost, a new normal code will
      // discover the activated account without replaying account creation.
      setSubmitted(true);
      const result = await ApiService.emailAuthRequest<EmailVerification>("enroll", {
        challenge_id: challenge.challenge_id, browser_binding: binding.current!,
        enrollment_ticket: reviewed.enrollment_ticket!,
        accepted_review_digest: registration.registration.state === "ready" ? registration.registration.review.digest : "",
        confirmed: true,
      });
      if (!mounted.current || epoch !== generation.current) return;
      if (result.status === "authenticated") await onAuthenticated(result.custom_token);
    });
  }

  if (!available) return null;
  if (view === "closed") return (
    <AuthProviderButton label="Continue with email"
      icon={<Mail className={cn("size-6", styles.emailProviderIcon)} aria-hidden="true" />}
      className={styles.providerButton} disabled={disabled} onClick={() => setView("email")} />
  );

  return <div className={styles.emailSection} aria-label="Email sign-in">
    {view === "email" ? <form onSubmit={requestCode} className={styles.emailForm}>
      <label htmlFor="email-sign-in-address" className={styles.emailLabel}>Email address</label>
      <Input id="email-sign-in-address" type="email" autoComplete="email" maxLength={254}
        className={styles.emailInput}
        value={email} onChange={(event) => setEmail(event.target.value)} required disabled={busy || disabled} />
      <Button type="submit" className={cn(styles.providerButton, styles.emailSubmit)} disabled={busy || disabled || !email.trim()}>
        {busy ? "Checking domain and sending…" : "Send sign-in code"}
      </Button>
    </form> : null}
    {view === "code" && challenge ? <form onSubmit={verifyCode} className={styles.emailForm}>
      {stale ? null : <>
        <p className={styles.emailHint}>Enter the code sent to {challenge.destination}.</p>
        <label htmlFor="email-sign-in-code" className={styles.emailLabel}>Six-digit code</label>
        <Input id="email-sign-in-code" inputMode="numeric" autoComplete="one-time-code"
          aria-describedby="email-sign-in-expiry"
          pattern="[0-9]{6}" maxLength={6} value={code} required autoFocus
          className={cn(styles.emailInput, styles.emailCode)} disabled={busy || disabled || expired}
          onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} />
        <p id="email-sign-in-expiry" className={styles.emailHint} role="timer" aria-live="off">
          {expired ? "This code expired. Request a new one." : `Code expires in ${expiryCountdown}.`}
        </p>
        <Button type="submit" className={cn(styles.providerButton, styles.emailSubmit)} disabled={busy || disabled || expired || code.length !== 6}>
          {busy ? "Verifying…" : "Verify and sign in"}
        </Button>
      </>}
      <Button type="button" variant={stale ? "default" : "ghost"}
        className={stale ? cn(styles.providerButton, styles.emailSubmit) : styles.emailQuietAction}
        disabled={busy || disabled || remaining > 0} onClick={() => { if (stale) trace("resend_requested"); requestKey.current = null; void requestCode(); }}>
        {remaining > 0 ? `Resend in ${remaining}s` : "Send a new code"}
      </Button>
    </form> : null}
    {view === "registration" && registration ? <div className={styles.emailForm}>
      <h2 className={styles.emailLabel}>Start fresh</h2>
      {registration.registration.state === "ready" ? <>
        <p className={styles.emailHint}>Your previous account was deleted. Create a new account with this sign-in. Previous files, memory and connections will not return.</p>
        <label className={cn(styles.emailHint, "flex items-start gap-3")}>
          <input type="checkbox" checked={accepted} disabled={busy || disabled || submitted}
            onChange={(event) => setAccepted(event.target.checked)} />
          I want to create a new account.
        </label>
        <Button type="button" className={cn(styles.providerButton, styles.emailSubmit)}
          disabled={!accepted || busy || disabled || submitted} onClick={() => void startFresh()}>
          {busy ? "Creating account…" : "Create new account"}
        </Button>
        {submitted && !busy ? <p className={styles.emailHint}>Request a new code to reconnect and check the result.</p> : null}
      </> : <p className={styles.emailHint}>
        {registration.registration.state === "action_required"
          ? "Previous account cleanup needs review before you can start fresh."
          : "Account recovery is not ready yet. Wait a minute, then request a new code."}
      </p>}
      {/* Support-led cleanup never changes on a new code, so support replaces that dead end. */}
      {registration.registration.state === "action_required"
        ? <a className={cn(styles.providerButton, styles.emailSubmit)} href={`mailto:${LEGAL_CONTACT_EMAIL}`}>Email {LEGAL_CONTACT_EMAIL}</a>
        : <Button type="button" variant="ghost" className={styles.emailQuietAction}
          disabled={busy || disabled || remaining > 0}
          onClick={() => { requestKey.current = null; void requestCode(); }}>
          {remaining > 0 ? `Request a new code in ${remaining}s` : "Request a new code"}
        </Button>}
    </div> : null}
    {notice ? <p role="alert" className="text-sm text-destructive">{notice}</p> : null}
    <Button type="button" variant="ghost" className={styles.emailQuietAction} disabled={busy || disabled}
      onClick={() => { reset(); setView("closed"); }}>Use another sign-in method</Button>
  </div>;
}
