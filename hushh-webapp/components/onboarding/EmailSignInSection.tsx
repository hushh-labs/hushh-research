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

export function EmailSignInSection({ disabled, onBusyChange, onExpandedChange, onAuthenticated }: Props) {
  const [view, setView] = useState<"closed" | "email" | "code">("closed");
  const [available, setAvailable] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<EmailChallenge | null>(null);
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
    setCode(""); setChallenge(null); setNotice(""); setView("email");
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
      setChallenge(result); setCode(""); setView("code");
    });
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (!challenge || !binding.current) return;
    await operation(async (epoch) => {
      const result = await ApiService.emailAuthRequest<EmailVerification>("verify", {
        challenge_id: challenge.challenge_id, code, browser_binding: binding.current!,
      });
      if (!mounted.current || epoch !== generation.current) return;
      setCode("");
      await onAuthenticated(result.custom_token);
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
      <Button type="button" variant="ghost" className={styles.emailQuietAction}
        disabled={busy || disabled || remaining > 0} onClick={() => { requestKey.current = null; void requestCode(); }}>
        {remaining > 0 ? `Resend in ${remaining}s` : "Send a new code"}
      </Button>
    </form> : null}
    {notice ? <p role="alert" className="text-sm text-destructive">{notice}</p> : null}
    <Button type="button" variant="ghost" className={styles.emailQuietAction} disabled={busy || disabled}
      onClick={() => { reset(); setView("closed"); }}>Use another sign-in method</Button>
  </div>;
}
