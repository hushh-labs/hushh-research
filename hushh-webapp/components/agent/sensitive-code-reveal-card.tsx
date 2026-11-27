"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff, Loader2, Shield } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { VaultContext } from "@/lib/vault/vault-context";
import {
  EmailDeliveryError,
  EmailDeliveryService,
  type RevealedEphemeralCode,
} from "@/lib/services/email-delivery-service";
import {
  parseSensitiveCodeRevealExperience,
  type SensitiveCodeRevealExperience,
} from "@/lib/agent/sensitive-code-reveal";

export { parseSensitiveCodeRevealExperience, type SensitiveCodeRevealExperience };

export type SensitiveCodeRevealCardProps = {
  experience: SensitiveCodeRevealExperience;
  /** Optional auth callback; defaults to current Firebase user + unlocked VaultContext. */
  getAuth?: () => Promise<{
    firebaseIdToken: string;
    vaultOwnerToken: string;
  } | null>;
  onRequireVault?: () => void;
};

/**
 * In-chat single-consume OTP reveal card (US-050).
 *
 * Raw verification codes never enter LLM context, durable session history, or
 * browser storage. Pressing "Approve & show code" performs one authenticated
 * POST /api/one/email/reveal-ephemeral, shows the code ephemerally, and clears
 * it automatically after 60 seconds (or immediately on Hide / unmount).
 */
export function SensitiveCodeRevealCard(props: SensitiveCodeRevealCardProps) {
  if (props.getAuth) {
    return (
      <SensitiveCodeRevealCardInner
        experience={props.experience}
        getAuth={props.getAuth}
        onRequireVault={props.onRequireVault}
      />
    );
  }
  return (
    <ContextAuthSensitiveCodeRevealCard
      experience={props.experience}
      onRequireVault={props.onRequireVault}
    />
  );
}

function ContextAuthSensitiveCodeRevealCard({
  experience,
  onRequireVault,
}: Omit<SensitiveCodeRevealCardProps, "getAuth">) {
  const { user } = useAuth();
  const vaultOwnerToken = useContext(VaultContext)?.vaultOwnerToken ?? null;
  const resolveAuth = useCallback(async () => {
    if (!user || !vaultOwnerToken) return null;
    const firebaseIdToken = await user.getIdToken();
    if (!firebaseIdToken) return null;
    return { firebaseIdToken, vaultOwnerToken };
  }, [user, vaultOwnerToken]);
  return (
    <SensitiveCodeRevealCardInner
      experience={experience}
      getAuth={resolveAuth}
      onRequireVault={onRequireVault}
    />
  );
}

function SensitiveCodeRevealCardInner({
  experience,
  getAuth,
  onRequireVault,
}: Required<Pick<SensitiveCodeRevealCardProps, "experience" | "getAuth">> &
  Pick<SensitiveCodeRevealCardProps, "onRequireVault">) {
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState<RevealedEphemeralCode | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [cleared, setCleared] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const revealedRef = useRef(false);

  const resolveAuth = useCallback(() => getAuth(), [getAuth]);

  const hideNow = useCallback(() => {
    setRevealed(null);
    setRemainingSeconds(0);
    setCopiedCode(null);
    setCleared(true);
  }, []);

  useEffect(() => {
    if (!revealed) return;
    const interval = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          setRevealed(null);
          setCopiedCode(null);
          setCleared(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [revealed]);

  useEffect(() => {
    return () => {
      setRevealed(null);
      setCopiedCode(null);
    };
  }, []);

  const handleReveal = async () => {
    if (loading || revealedRef.current) return;
    setErrorMessage(null);
    const auth = await resolveAuth();
    if (!auth) {
      onRequireVault?.();
      setErrorMessage("Unlock your vault to view this verification code.");
      return;
    }
    setLoading(true);
    try {
      const result = await EmailDeliveryService.revealEphemeralCode({
        ...auth,
        revealRef: experience.revealRef,
      });
      revealedRef.current = true;
      setRevealed(result);
      setRemainingSeconds(result.autoClearSeconds || experience.autoClearSeconds || 60);
    } catch (cause) {
      if (cause instanceof EmailDeliveryError) {
        if (cause.code === "EPHEMERAL_CODE_EXPIRED" || cause.status === 410) {
          revealedRef.current = true;
        }
        setErrorMessage(cause.message);
      } else {
        setErrorMessage("Could not load this verification code. Ask One to check again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (code: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        setCopiedCode(code);
      }
    } catch {
      // Clipboard access can be unavailable in restricted contexts.
    }
  };

  return (
    <section
      aria-label="Protected verification code"
      data-testid="sensitive-code-reveal-card"
      className="w-full min-w-0 rounded-[16px] border border-border/70 bg-card/90 p-3.5 text-sm shadow-sm"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Shield className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-foreground">Verification code protected</p>
          <p className="truncate text-xs text-muted-foreground">
            {experience.sender}
            {experience.subject ? ` · ${experience.subject}` : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Hidden from chat history and model memory. View once in this session only.
          </p>
        </div>
      </div>

      {revealed ? (
        <div className="mt-3 space-y-2" data-testid="sensitive-code-revealed-panel">
          <div className="flex flex-wrap items-center gap-2">
            {revealed.codes.map((code) => (
              <div
                key={code}
                className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-1.5"
              >
                <span
                  data-testid="sensitive-code-reveal-value"
                  className="font-mono text-base font-semibold tracking-widest text-foreground"
                >
                  {code}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  data-testid="sensitive-code-copy-button"
                  onClick={() => void handleCopy(code)}
                >
                  {copiedCode === code ? (
                    <>
                      <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span role="status" data-testid="sensitive-code-countdown">
              Auto-hides in {remainingSeconds}s · Never saved to history
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              data-testid="sensitive-code-hide-button"
              onClick={hideNow}
            >
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              Hide now
            </Button>
          </div>
        </div>
      ) : cleared ? (
        <p
          role="status"
          data-testid="sensitive-code-cleared"
          className="mt-3 text-xs text-muted-foreground"
        >
          Code cleared from screen. Ask One to check again if you need a fresh verification code.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={loading || revealedRef.current}
            data-testid="sensitive-code-reveal-button"
            onClick={() => void handleReveal()}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {loading ? "Revealing…" : "Approve & show code"}
          </Button>
        </div>
      )}

      {errorMessage ? (
        <p role="alert" data-testid="sensitive-code-error" className="mt-2 text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}
