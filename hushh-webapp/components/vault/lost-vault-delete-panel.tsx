"use client";

import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { User } from "firebase/auth";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import { AppleIcon, GoogleIcon } from "@/lib/morphy-ux/social-icons";
import { Button } from "@/lib/morphy-ux/morphy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CountryPicker } from "@/components/auth/country-picker";
import { useAuth } from "@/hooks/use-auth";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { getAuthSessionLandingNotice } from "@/lib/auth/session-invalidation";
import {
  DELETION_PHONE_COUNTRIES,
  useLostVaultDelete,
  type DeletionProvider,
} from "./use-lost-vault-delete";

export function LostVaultDeletePanel({
  user,
  onBack,
}: {
  user: User;
  onBack: () => void;
}) {
  const { resolveVerifiedPhoneNumber } = useAuth();
  // A new owner or anonymous interlude receives entirely new in-memory proofs.
  return (
    <LostVaultDeleteJourney
      key={`${user.uid}:${getAuthSessionGeneration()}`}
      user={user}
      onBack={onBack}
      resolvePhone={resolveVerifiedPhoneNumber}
    />
  );
}

function LostVaultDeleteJourney({
  user,
  onBack,
  resolvePhone,
}: {
  user: User;
  onBack: () => void;
  resolvePhone: () => Promise<string | null>;
}) {
  const flow = useLostVaultDelete(user, resolvePhone);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState("");
  const providers =
    flow.options?.providers.filter(
      (provider): provider is DeletionProvider =>
        provider === "google.com" || provider === "apple.com",
    ) ?? [];
  const native = Capacitor.isNativePlatform();
  const title =
    flow.stage === "review"
      ? "Verify it’s you"
      : flow.stage === "phone"
        ? "Verify your phone"
        : "Delete account";
  const terminalCode =
    flow.stage === "retained"
      ? "account_deletion_identity_retained"
      : flow.stage === "pending"
        ? "account_deletion_finishing"
        : flow.stage === "uncertain"
          ? "account_deletion_uncertain"
          : null;
  const terminalNotice = terminalCode
    ? getAuthSessionLandingNotice(terminalCode)
    : null;

  return (
    <div
      data-testid="lost-vault-delete-panel"
      className="max-h-[var(--vault-available-height,min(640px,calc(90svh-3rem-var(--kb-height,0px))))] overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] pt-1 [scrollbar-width:none] sm:px-7 [&::-webkit-scrollbar]:hidden"
    >
      <div className="mx-auto w-full max-w-[25rem] space-y-5">
        <div className="space-y-2 text-center">
          <h2 className="type-title-2 font-semibold text-[color:var(--app-label)]">
            {title}
          </h2>
          {flow.stage === "review" && (
            <p className="type-footnote text-[color:var(--app-secondary-label)]">
              Sign in again, then confirm deletion.
            </p>
          )}
        </div>
        {flow.stage === "review" && (
          <p className="type-footnote text-[color:var(--app-secondary-label)]">
            Account deletion is permanent. Remove One’s bank access in bank
            settings. Required records may remain.
          </p>
        )}
        {flow.error && (
          <p role="alert" className="type-footnote text-destructive">
            {flow.error}
          </p>
        )}

        {flow.loading ? (
          <p
            role="status"
            className="type-footnote text-center text-[color:var(--app-secondary-label)]"
          >
            Checking your options…
          </p>
        ) : flow.stage === "review" ? (
          <div className="space-y-3">
            {!flow.options ? (
              <Button
                variant="none"
                effect="fill"
                fullWidth
                onClick={flow.retryOptions}
              >
                Try again
              </Button>
            ) : providers.some(
                (provider) => provider === "google.com" || !native,
              ) ? (
              providers.map((provider) => (
                <AuthProviderButton
                  key={provider}
                  label={`Continue with ${provider === "google.com" ? "Google" : "Apple"}`}
                  icon={
                    provider === "google.com" ? (
                      <GoogleIcon className="size-6" />
                    ) : (
                      <AppleIcon className="size-6" />
                    )
                  }
                  className="min-h-12 rounded-full border-[color:var(--app-accent-border)] bg-transparent dark:bg-transparent [backdrop-filter:none]"
                  disabled={flow.busy || (provider === "apple.com" && native)}
                  onClick={() => void flow.verifyProvider(provider)}
                />
              ))
            ) : (
              <p className="type-footnote text-[color:var(--app-secondary-label)]">
                {native && providers.length > 0
                  ? "Use One on the web, or ask support to verify your request."
                  : "Contact support to verify your deletion request."}
              </p>
            )}
          </div>
        ) : flow.stage === "phone" ? (
          <div className="space-y-3">
            <p className="type-footnote text-[color:var(--app-secondary-label)]">
              Enter the mobile number already linked to this account
              {flow.options?.phone_hint ? ` (${flow.options.phone_hint})` : ""}.
            </p>
            {native ? (
              <p className="type-footnote text-[color:var(--app-secondary-label)]">
                This phone check is unavailable in this app. Use One on the web
                or contact support.
              </p>
            ) : (
              <>
                <div className="flex items-end gap-3">
                  <div className="min-w-[5.5rem] shrink-0 space-y-2">
                    <Label className="type-footnote">Country code</Label>
                    <CountryPicker
                      open={countryOpen}
                      onOpenChange={(open) => {
                        setCountryOpen(open);
                        if (open) setCountryQuery("");
                      }}
                      query={countryQuery}
                      onQueryChange={setCountryQuery}
                      options={DELETION_PHONE_COUNTRIES.filter((option) =>
                        `${option.label} ${option.value} ${option.dialCode}`
                          .toLowerCase()
                          .includes(countryQuery.toLowerCase()),
                      )}
                      selected={flow.selectedCountry}
                      onSelect={(value) => {
                        flow.editNumber(flow.number, value);
                        setCountryOpen(false);
                      }}
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <Label htmlFor="lost-vault-delete-phone">
                      Mobile number
                    </Label>
                    <Input
                      id="lost-vault-delete-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel-national"
                      value={flow.number}
                      onChange={(event) => flow.editNumber(event.target.value)}
                    />
                  </div>
                </div>
                <div id="lost-vault-delete-recaptcha" />
                <Button
                  variant="none"
                  effect="fill"
                  fullWidth
                  className="min-h-11 rounded-full border border-[color:var(--app-accent-border)]"
                  disabled={flow.busy || !flow.number || flow.resendSeconds > 0}
                  onClick={() => void flow.sendCode()}
                >
                  {flow.busy
                    ? "Please wait…"
                    : flow.resendSeconds > 0
                      ? `Send another code in ${flow.resendSeconds}s`
                      : flow.verificationId
                        ? "Send another code"
                        : "Send code"}
                </Button>
                {flow.verificationId && (
                  <>
                    <Label htmlFor="lost-vault-delete-code">
                      Verification code
                    </Label>
                    <Input
                      id="lost-vault-delete-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={flow.code}
                      onChange={(event) =>
                        flow.setCode(event.target.value.replace(/\D/g, ""))
                      }
                    />
                    <Button
                      variant="none"
                      effect="fill"
                      fullWidth
                      className="min-h-11 rounded-full"
                      disabled={flow.busy || flow.code.length !== 6}
                      onClick={() => void flow.verifyCode()}
                    >
                      Verify code
                    </Button>
                  </>
                )}
                {flow.error && (
                  <button
                    type="button"
                    disabled={flow.busy}
                    className="min-h-11 text-[color:var(--app-accent-deep)]"
                    onClick={flow.restartVerification}
                  >
                    Verify account again
                  </button>
                )}
              </>
            )}
          </div>
        ) : flow.stage === "confirm" ? (
          <div className="space-y-4">
            <label className="flex min-h-11 items-start gap-3 type-footnote text-[color:var(--app-label)]">
              <input
                type="checkbox"
                checked={flow.acknowledged}
                onChange={(event) => flow.setAcknowledged(event.target.checked)}
                className="mt-1"
              />
              <span>I understand this can’t be undone.</span>
            </label>
            <Button
              variant="none"
              effect="fill"
              fullWidth
              className="min-h-12 rounded-full !bg-[color:var(--app-destructive)] !text-white"
              disabled={flow.busy || !flow.acknowledged}
              onClick={() => void flow.deleteAccount()}
            >
              Permanently delete account
            </Button>
            {flow.options?.phone_available && (
              <button
                type="button"
                className="min-h-11 text-[color:var(--app-accent-deep)]"
                onClick={flow.changePhone}
              >
                Change number
              </button>
            )}
          </div>
        ) : flow.stage === "deleting" ? (
          <p
            role="status"
            className="type-footnote text-center text-[color:var(--app-secondary-label)]"
          >
            Deleting your account…
          </p>
        ) : flow.stage === "ready" ? (
          <div className="space-y-3 text-center">
            <p
              role="status"
              className="type-footnote text-[color:var(--app-secondary-label)]"
            >
              Your old account is deleted. Your new account will start empty.
            </p>
            <a
              href="/login"
              className="inline-flex min-h-11 items-center font-semibold text-[color:var(--app-accent-deep)] underline-offset-2 hover:underline"
            >
              Create a new account
            </a>
          </div>
        ) : terminalNotice ? (
          <p
            role="status"
            className="type-footnote text-center text-[color:var(--app-secondary-label)]"
          >
            {terminalNotice.message}
          </p>
        ) : null}

        {(["review", "phone", "confirm"] as const).some(
          (stage) => stage === flow.stage,
        ) && (
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 type-footnote">
            <button
              type="button"
              onClick={() => {
                flow.cancel();
                onBack();
              }}
              className="min-h-11 text-[color:var(--app-accent-deep)] underline-offset-2 hover:underline"
            >
              Back to unlock
            </button>
            <a
              href="/delete-account"
              className="inline-flex min-h-11 items-center text-[color:var(--app-accent-deep)] underline-offset-2 hover:underline"
            >
              Get help
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
