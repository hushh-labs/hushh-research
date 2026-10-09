"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { User } from "firebase/auth";
import { Button } from "@/lib/morphy-ux/morphy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { AuthService } from "@/lib/services/auth-service";
import { AccountService, type LostVaultDeleteOptions } from "@/lib/services/account-service";
import { prepareRecaptchaVerifier, resetRecaptcha } from "@/lib/firebase/config";
import {
  executeLostVaultAccountDeletion,
  lostVaultDeletionErrorMessage,
} from "@/lib/flows/delete-account";

type DeletionStage = "review" | "phone" | "confirm" | "deleting" | "pending" | "ready" | "uncertain";
type ProviderId = "google.com" | "apple.com";

const SUPPORT_URL = "/delete-account";

function providerName(providerId: ProviderId): string {
  return providerId === "google.com" ? "Google" : "Apple";
}

function verificationMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "identity_cancelled") return "Sign-in check cancelled. Try again.";
  if (code === "identity_popup_blocked") return "Allow the sign-in window, then try again.";
  if (code === "native_identity_unavailable") return "Use One on the web, or contact support.";
  if (code === "session_changed" || code === "identity_mismatch") return "Your account changed. Sign in again.";
  return "We could not verify you. Try again.";
}

export function LostVaultDeletePanel({ user, onBack }: { user: User; onBack: () => void }) {
  const { resolveVerifiedPhoneNumber } = useAuth();
  const [options, setOptions] = useState<LostVaultDeleteOptions | null>(null);
  const [stage, setStage] = useState<DeletionStage>("review");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerIdToken, setProviderIdToken] = useState("");
  const [verificationId, setVerificationId] = useState("");
  const [phoneIdToken, setPhoneIdToken] = useState("");
  const [code, setCode] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const deleteAttemptRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const result = await AccountService.getLostVaultDeleteOptions(idToken);
        if (cancelled) return;
        setOptions(result);
        if (result.phone_available) {
          const linkedPhone = await resolveVerifiedPhoneNumber();
          if (!cancelled) setPhoneNumber(linkedPhone);
        }
      } catch {
        if (!cancelled) setError("We could not load deletion options. Try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      resetRecaptcha();
    };
  }, [resolveVerifiedPhoneNumber, user]);

  const providers = options?.providers.filter(
    (provider): provider is ProviderId => provider === "google.com" || provider === "apple.com",
  ) ?? [];
  const hintDigits = options?.phone_hint?.replace(/\D/g, "") ?? "";
  const phoneMatchesHint = !hintDigits || Boolean(phoneNumber?.replace(/\D/g, "").endsWith(hintDigits));
  const phoneProofAvailable = Boolean(options?.phone_available && phoneNumber && phoneMatchesHint && !Capacitor.isNativePlatform());
  const hasUsableProvider = providers.some(
    (provider) => provider === "google.com" || !Capacitor.isNativePlatform(),
  );

  async function verifyProvider(provider: ProviderId) {
    setBusy(true);
    setError(null);
    setProviderIdToken("");
    setPhoneIdToken("");
    setAcknowledged(false);
    try {
      const token = await AuthService.reauthenticateAccountDeletionIdentity(
        user.uid,
        provider,
        () => mountedRef.current,
      );
      if (!mountedRef.current) return;
      setProviderIdToken(token);
      setStage(options?.phone_available ? "phone" : "confirm");
    } catch (cause) {
      if (mountedRef.current) setError(verificationMessage(cause));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function sendCode() {
    if (!phoneProofAvailable || !phoneNumber) return;
    setBusy(true);
    setError(null);
    try {
      const verifier = await prepareRecaptchaVerifier("recaptcha-container");
      const verificationId = await AuthService.startPhoneDeletionVerification(phoneNumber, verifier);
      if (!mountedRef.current) return;
      setVerificationId(verificationId);
      setCode("");
    } catch {
      if (mountedRef.current) setError("We could not send the code. Try again.");
      resetRecaptcha();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function verifyCode() {
    if (!verificationId || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const token = await AuthService.getPhoneClaimIdToken({
        verificationCode: code.trim(),
        verificationId,
      });
      if (!mountedRef.current) return;
      setPhoneIdToken(token);
      setStage("confirm");
    } catch {
      if (mountedRef.current) setError("That code did not work. Try again.");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function deleteAccount() {
    if (deleteAttemptRef.current || !acknowledged || !providerIdToken || (options?.phone_available && !phoneIdToken)) return;
    deleteAttemptRef.current = true;
    setStage("deleting");
    setError(null);
    try {
      const result = await executeLostVaultAccountDeletion({
        userId: user.uid,
        sessionUser: user,
        firebaseIdToken: providerIdToken,
        phoneIdToken: phoneIdToken || undefined,
      });
      if (mountedRef.current) setStage(result.ready_to_start_fresh ? "ready" : "pending");
    } catch (cause) {
      if (!mountedRef.current) return;
      const errorCode = cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code: unknown }).code)
        : "";
      if (errorCode === "ACCOUNT_DELETION_OUTCOME_UNCERTAIN") {
        setStage("uncertain");
      } else {
        deleteAttemptRef.current = false;
        setStage("review");
        setProviderIdToken("");
        setPhoneIdToken("");
        setAcknowledged(false);
        setError(lostVaultDeletionErrorMessage(cause));
      }
    }
  }

  return (
    <div
      data-testid="lost-vault-delete-panel"
      className="max-h-[var(--vault-available-height,min(640px,calc(90svh-3rem-var(--kb-height,0px))))] overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] pt-1 [scrollbar-width:none] sm:px-7 [&::-webkit-scrollbar]:hidden"
    >
      <div className="mx-auto w-full max-w-[25rem] space-y-5">
        <div className="space-y-2 text-center">
          <h2 className="type-title-2 font-semibold text-[color:var(--app-label)]">Delete and start fresh</h2>
          <p className="type-footnote text-[color:var(--app-secondary-label)]">
            Lost every way into your vault? You can delete this account without its passphrase or recovery key.
          </p>
        </div>

        {(stage === "review" || stage === "phone" || stage === "confirm") && (
          <div className="space-y-3 type-footnote text-[color:var(--app-secondary-label)]">
            <p>Your vault, memories, chats, connections, and One context will be removed. A new account starts empty.</p>
            <p>Remove One or Plaid access in your bank settings if you connected a bank. Outside services and records we must retain may remain.</p>
          </div>
        )}

        {error && <p role="alert" className="type-footnote text-destructive">{error}</p>}

        {loading ? (
          <p role="status" className="type-footnote text-center text-[color:var(--app-secondary-label)]">Checking your options…</p>
        ) : stage === "review" ? (
          <div className="space-y-3">
            {hasUsableProvider ? (
              <>
                <p className="type-footnote text-[color:var(--app-secondary-label)]">First, confirm it is you.</p>
                {providers.map((provider) => (
                  <Button
                    key={provider}
                    variant="none"
                    effect="fill"
                    fullWidth
                    className="min-h-11 rounded-full border border-[color:var(--app-accent-border)]"
                    disabled={busy || (provider === "apple.com" && Capacitor.isNativePlatform())}
                    onClick={() => void verifyProvider(provider)}
                  >
                    Continue with {providerName(provider)}
                  </Button>
                ))}
              </>
            ) : (
              <p className="type-footnote text-[color:var(--app-secondary-label)]">Use One on the web, or ask support to verify your request.</p>
            )}
          </div>
        ) : stage === "phone" ? (
          <div className="space-y-3">
            <p className="type-footnote text-[color:var(--app-secondary-label)]">
              Next, verify your linked phone{options?.phone_hint ? ` ${options.phone_hint}` : ""}.
            </p>
            {phoneProofAvailable ? (
              <>
                <div id="recaptcha-container" />
                <Button variant="none" effect="fill" fullWidth className="min-h-11 rounded-full border border-[color:var(--app-accent-border)]" disabled={busy} onClick={() => void sendCode()}>
                  {verificationId ? "Send another code" : "Send code"}
                </Button>
                {verificationId && (
                  <>
                    <Label htmlFor="lost-vault-delete-code">Verification code</Label>
                    <Input id="lost-vault-delete-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
                    <Button variant="none" effect="fill" fullWidth className="min-h-11 rounded-full" disabled={busy || !code.trim()} onClick={() => void verifyCode()}>
                      Verify code
                    </Button>
                  </>
                )}
              </>
            ) : (
              <p className="type-footnote text-[color:var(--app-secondary-label)]">This phone check is unavailable here. Use One on the web or contact support.</p>
            )}
          </div>
        ) : stage === "confirm" ? (
          <div className="space-y-4">
            <label className="flex min-h-11 items-start gap-3 type-footnote text-[color:var(--app-label)]">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" />
              <span>I understand my old information cannot be recovered.</span>
            </label>
            <Button variant="none" effect="fill" fullWidth className="min-h-12 rounded-full !bg-[color:var(--app-destructive)] !text-white" disabled={!acknowledged} onClick={() => void deleteAccount()}>
              Permanently delete account
            </Button>
          </div>
        ) : stage === "deleting" ? (
          <p role="status" className="type-footnote text-center text-[color:var(--app-secondary-label)]">Deleting your account…</p>
        ) : stage === "pending" ? (
          <p role="status" className="type-footnote text-center text-[color:var(--app-secondary-label)]">Your information is deleted. We are finishing account removal before you can start again.</p>
        ) : stage === "ready" ? (
          <div className="space-y-3 text-center">
            <p role="status" className="type-footnote text-[color:var(--app-secondary-label)]">Your old account is deleted. Your new account will start empty.</p>
            <a href="/login" className="inline-flex min-h-11 items-center font-semibold text-[color:var(--app-accent-deep)] underline-offset-2 hover:underline">Create a new account</a>
          </div>
        ) : (
          <p role="status" className="type-footnote text-center text-[color:var(--app-secondary-label)]">We are checking whether deletion finished. Contact support before trying again.</p>
        )}

        {(stage === "review" || stage === "phone" || stage === "confirm") && (
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 type-footnote">
            <button type="button" onClick={onBack} className="min-h-11 text-[color:var(--app-accent-deep)] underline-offset-2 hover:underline">Back to unlock</button>
            <a href={SUPPORT_URL} className="inline-flex min-h-11 items-center text-[color:var(--app-accent-deep)] underline-offset-2 hover:underline">Get help</a>
          </div>
        )}
      </div>
    </div>
  );
}
