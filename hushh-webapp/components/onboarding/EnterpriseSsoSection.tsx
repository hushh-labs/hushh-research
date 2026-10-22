"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import lightStyles from "./AuthStepLight.module.css";
import { cn } from "@/lib/utils";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { LegalAcceptanceService } from "@/lib/services/legal-acceptance-service";
import { useAuth } from "@/lib/firebase/auth-context";
import { isWeb } from "@/lib/capacitor/platform";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { trackEvent } from "@/lib/observability/client";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import {
  EnterpriseSsoRequestError,
  decideEnterpriseSsoCallback,
  hasEnterpriseSsoCallbackParams,
  isEnterpriseSsoEnabled,
  looksLikeWorkEmail,
  savePendingEnterpriseSso,
  takePendingEnterpriseSso,
} from "@/lib/auth/enterprise-sso";

const SSO_BTN_CLASS =
  "!bg-white !text-zinc-900 border border-slate-200/90 shadow-sm hover:!bg-slate-50 h-[56px] sm:h-[60px] rounded-[20px] text-[17px] font-medium whitespace-nowrap flex items-center justify-center dark:!bg-[#1C1C1E] dark:!text-white dark:border-white/10 dark:hover:!bg-[#26262a]";

function ShieldGlyph() {
  return (
    <svg className="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 5 6v5.5c0 4.2 2.8 7.9 7 9.5 4.2-1.6 7-5.3 7-9.5V6l-7-3Z" />
      <path d="m9 12 2.2 2.2L15.5 10" strokeLinecap="round" />
    </svg>
  );
}

function SsoIcon() {
  return <ShieldGlyph />;
}

const GENERIC_FAILURE = "Single sign-on could not be completed. Try again.";

function loginHref(resume: string): string {
  return resume ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(resume)}` : ROUTES.LOGIN;
}

function failureMessage(error: unknown): string {
  return error instanceof EnterpriseSsoRequestError ? error.message : GENERIC_FAILURE;
}

/**
 * "Continue with SSO": work email -> org discovery -> WorkOS -> back here.
 *
 * Web only in v1. The return trip lands on `/login` (the redirect URI), where
 * this component completes the Firebase sign-in; AuthStep's existing-session
 * routing then takes over, so post-auth routing matches Google and Apple.
 */
export function EnterpriseSsoSection({
  redirectPath,
  disabled = false,
}: {
  redirectPath: string;
  disabled?: boolean;
}) {
  const enabled = isEnterpriseSsoEnabled() && isWeb();
  const { beginPostAuthSettlement, completePostAuthSettlement } = useAuth();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callbackHandledRef = useRef(false);

  // Back first closes the email form, then reaches the login route's parent.
  const closeForm = useCallback(() => {
    if (!open) return false;
    if (!busy) setOpen(false);
    return true;
  }, [open, busy]);
  useBackLayer(ROUTES.LOGIN, enabled && open ? 1 : 0, closeForm);

  useEffect(() => {
    if (!enabled || callbackHandledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (!hasEnterpriseSsoCallbackParams(params)) return;
    callbackHandledRef.current = true;

    const decision = decideEnterpriseSsoCallback(params, takePendingEnterpriseSso());
    // The code and state are single-use: never leave them in the address bar.
    // Let Next copy its internal history state. Passing __NA from the current
    // entry bypasses useSearchParams updates and loses AuthStep's destination.
    window.history.replaceState(
      null,
      "",
      loginHref(decision.kind === "none" ? "" : decision.resume),
    );
    if (decision.kind !== "exchange") {
      trackEvent("auth_failed", {
        action: "enterprise_sso",
        result: "error",
        error_class: decision.kind === "failed" ? decision.reason : "none",
      });
      morphyToast.error("This sign-in attempt expired. Start again.");
      return;
    }

    setBusy(true);
    void (async () => {
      try {
        const exchanged = await ApiService.exchangeEnterpriseSso({
          code: decision.code,
          state: decision.state,
        });
        const authResult = await AuthService.signInWithCustomToken(exchanged.custom_token);
        const settlementId = beginPostAuthSettlement(authResult.user);
        try {
          const idToken = authResult.idToken || (await authResult.user.getIdToken());
          trackEvent("auth_succeeded", { action: "enterprise_sso", result: "success" });
          void ApiService.notifyFirstWelcome({ idToken });
          // The sign-in screen states "By continuing you agree"; record it.
          void LegalAcceptanceService.recordSignInAcceptance(authResult.user);
        } finally {
          completePostAuthSettlement(settlementId);
        }
      } catch (failure) {
        trackEvent("auth_failed", {
          action: "enterprise_sso",
          result: "error",
          error_class:
            failure instanceof EnterpriseSsoRequestError ? failure.code : "auth_failed",
        });
        morphyToast.error(failureMessage(failure));
        setBusy(false);
      }
    })();
  }, [enabled, beginPostAuthSettlement, completePostAuthSettlement]);

  const submit = useCallback(async () => {
    if (busy) return;
    if (!looksLikeWorkEmail(email)) {
      setError("Enter your work email address.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const started = await ApiService.startEnterpriseSso(email);
      const target = new URL(started.authorization_url);
      if (target.protocol !== "https:") throw new Error("Unexpected sign-in address.");
      if (
        !savePendingEnterpriseSso({
          state: started.state,
          resume: redirectPath,
          startedAt: Date.now(),
        })
      ) {
        setError("This browser blocked storage needed for a secure sign-in.");
        setBusy(false);
        return;
      }
      trackEvent("auth_started", { action: "enterprise_sso" });
      window.location.assign(target.toString());
    } catch (failure) {
      setError(
        failure instanceof EnterpriseSsoRequestError ? failure.message : GENERIC_FAILURE,
      );
      setBusy(false);
    }
  }, [busy, email, redirectPath]);

  if (!enabled) return null;

  return (
    <div className="space-y-3" data-auth-enterprise-sso>
      {open ? (
        <form
          className="space-y-3"
          noValidate
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="enterprise-sso-email" className="sr-only">
            Work email
          </label>
          <input
            id="enterprise-sso-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            className="h-[56px] w-full rounded-[20px] border border-slate-200/90 bg-white px-4 text-[17px] text-zinc-900 outline-none transition-colors focus:border-[#387BF5] disabled:opacity-60 dark:border-white/10 dark:bg-[#1C1C1E] dark:text-white"
          />
          {error ? (
            <p role="alert" className="text-center text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
          <AuthProviderButton
            label={busy ? "Opening single sign-on…" : "Continue"}
            icon={<SsoIcon />}
            onClick={() => void submit()}
            disabled={busy}
            className={cn(SSO_BTN_CLASS, lightStyles.providerButton)}
          />
          <button
            type="button"
            onClick={closeForm}
            disabled={busy}
            className="w-full text-center text-sm font-semibold text-[#387BF5] transition-opacity hover:opacity-75 disabled:opacity-40"
          >
            Use another sign-in option
          </button>
        </form>
      ) : (
        <AuthProviderButton
          label={busy ? "Signing you in…" : "Continue with SSO"}
          icon={<SsoIcon />}
          onClick={() => setOpen(true)}
          disabled={disabled || busy}
          className={cn(SSO_BTN_CLASS, lightStyles.providerButton)}
        />
      )}
    </div>
  );
}
