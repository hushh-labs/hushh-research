"use client";

import {
  type FormEvent,
  useState,
  useEffect,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import { Capacitor } from "@capacitor/core";
import { Button, Card } from "@/lib/morphy-ux/morphy";
import {
  Lock,
  Loader2,
  AlertCircle,
  Key,
  Check,
  Copy,
  Download,
  Fingerprint,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { VaultService } from "@/lib/services/vault-service";
import { downloadTextFile } from "@/lib/utils/native-download";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { User } from "firebase/auth";

import { useVault } from "@/lib/vault/vault-context";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Icon } from "@/lib/morphy-ux/ui";
import { useHostname } from "@/lib/hooks/use-hostname";
import type { GeneratedVaultKeyMode } from "@/lib/services/vault-bootstrap-service";
import { VaultMethodService, type VaultMethod } from "@/lib/services/vault-method-service";
import { VaultMethodPromptLocalService } from "@/lib/services/vault-method-prompt-local-service";
import { resolvePasskeyRpId } from "@/lib/vault/passkey-rp";
import { checkPrfSupport } from "@/lib/vault/prf-auth";
import { copyToClipboard } from "@/lib/utils/clipboard";
import { reloadWindow } from "@/lib/utils/browser-navigation";
import {
  toInvestorLoading,
  toInvestorMessage,
  toInvestorVaultUnlockError,
} from "@/lib/copy/investor-language";
import {
  getNativeTestConfig,
  getNativeUiTestVaultPassphrase,
  isNativeUiTestSession,
  preferPassphraseUnlockForAutomation,
  shouldSkipGeneratedVaultUnlockForAutomation,
  useNativeTestConfig,
} from "@/lib/testing/native-test";

type VaultStep =
  | "checking"
  | "setup_required"
  | "create"
  | "unlock"
  | "recovery"
  | "method";
type VaultMode = "passphrase" | GeneratedVaultKeyMode;

interface VaultFlowProps {
  user: User;
  onSuccess: (meta?: { mode: VaultMode }) => void;
  // Callback to inform parent about current step (e.g. to hide headers)
  onStepChange?: (step: VaultStep) => void;
  /**
   * The generated recovery key is a one-time disclosure. Its owner dialog must
   * not dismiss until the user explicitly confirms that they saved it.
   */
  onRecoveryKeyDisclosureChange?: (active: boolean) => void;
  enableGeneratedDefault?: boolean;
  /**
   * Setup routes may open an existing vault but must never create one before
   * the root "Finish setup" boundary. The post-setup invitation keeps the
   * canonical creation path.
   */
  allowVaultCreation?: boolean;
  /**
   * When provided, renders a subtle "Sign out" escape on the unlock / recovery
   * steps. Passed only by the HARD vault gate (VaultLockGuard) so a user who
   * forgot their vault password is not trapped with no way out of the app.
   */
  onSignOut?: () => void | Promise<void>;
}

const VAULT_ALTERNATIVE_BUTTON_CLASS =
  "h-11 rounded-full border border-[color:var(--app-accent-border)] px-3 text-[13px] font-medium sm:text-[14px] !bg-[color:var(--app-accent-tint)] !text-[color:var(--app-accent-deep)] hover:!bg-[color:var(--app-accent-surface-strong)]";

function VaultFlowHeader({
  icon,
  title,
  description,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  hint?: string | null;
}) {
  return (
    <div data-vault-flow-header className="text-center">
      <div
        data-vault-flow-icon
        className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)]"
      >
        <Icon
          icon={icon}
          size={24}
          className="text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-deep)]"
        />
      </div>
      <div
        role="heading"
        aria-level={2}
        className="text-[26px] font-extrabold leading-tight tracking-[-0.6px] text-foreground"
      >
        {title}
      </div>
      <p className="mt-1 type-subhead text-muted-foreground">{description}</p>
      {hint ? (
        <p className="mx-auto mt-3 max-w-[19rem] text-balance rounded-[14px] bg-[color:var(--app-accent-tint)] px-3.5 py-2.5 type-footnote text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function VaultFlow({
  user,
  onSuccess,
  onStepChange,
  onRecoveryKeyDisclosureChange,
  enableGeneratedDefault = false,
  allowVaultCreation = true,
  onSignOut,
}: VaultFlowProps) {
  const [step, setStep] = useState<VaultStep>("checking");
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string>("");
  const [recoveryKeyInput, setRecoveryKeyInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [vaultMode, setVaultMode] = useState<VaultMode>("passphrase");
  const [unlockHint, setUnlockHint] = useState<string | null>(null);
  const [availableGeneratedMethod, setAvailableGeneratedMethod] =
    useState<GeneratedVaultKeyMode | null>(null);
  const [unlockWithPassphraseFallback, setUnlockWithPassphraseFallback] =
    useState(() => shouldSkipGeneratedVaultUnlockForAutomation());
  const [pendingUnlockKey, setPendingUnlockKey] = useState<string | null>(null);
  const [recommendedQuickMethod, setRecommendedQuickMethod] =
    useState<VaultMethod | null>(null);
  // Decision about whether a usable platform authenticator exists for the web
  // passkey (PRF) path. It starts "unknown" and resolves asynchronously via
  // PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(). We use
  // a tri-state instead of a bare boolean so the auto-prompt can WAIT for the
  // determination rather than racing it: firing navigator.credentials.get()
  // before we know availability is exactly what strands the VS Code integrated
  // browser (or any browser without Touch ID / Windows Hello / a synced
  // passkey), because that call then hangs for its full 2 minute timeout while
  // the passphrase/recovery fallback buttons are disabled. Real biometric users
  // resolve to "available" quickly and keep the seamless auto-prompt.
  const [webPrfDecision, setWebPrfDecision] = useState<
    "unknown" | "available" | "unavailable"
  >("unknown");
  const autoGeneratedPromptedRef = useRef(false);
  const signOutRequestedRef = useRef(false);
  // React state updates after an event. These guards make the underlying vault
  // operation idempotent when Enter and a pointer action land in the same turn.
  const createPassphraseAttemptRef = useRef(false);
  const recoveryContinueAttemptRef = useRef(false);
  const nativeTestConfig = useNativeTestConfig();
  const shouldPreferPassphraseUnlock =
    preferPassphraseUnlockForAutomation(nativeTestConfig);
  const skipGeneratedUnlockForAutomation =
    shouldSkipGeneratedVaultUnlockForAutomation();
  const hostname = useHostname();
  const currentRpId = resolvePasskeyRpId({
    isNative: Capacitor.isNativePlatform(),
    hostname: hostname,
  });

  const { unlockVault } = useVault();

  // Notify parent of step changes
  useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);

  const recoveryKeyDisclosureActive =
    step === "recovery" && Boolean(recoveryKey);
  useLayoutEffect(() => {
    onRecoveryKeyDisclosureChange?.(recoveryKeyDisclosureActive);

    return () => {
      if (recoveryKeyDisclosureActive) {
        onRecoveryKeyDisclosureChange?.(false);
      }
    };
  }, [onRecoveryKeyDisclosureChange, recoveryKeyDisclosureActive]);

  const isGeneratedVaultMode =
    vaultMode === "generated_default_native_biometric" ||
    vaultMode === "generated_default_web_prf" ||
    vaultMode === "generated_default_native_passkey_prf";
  const hasActiveGeneratedWrapper =
    isGeneratedVaultMode && availableGeneratedMethod === vaultMode;
  const shouldShowPassphraseUnlock =
    !hasActiveGeneratedWrapper || unlockWithPassphraseFallback;
  const createPassphraseTooShort =
    step === "create" && passphrase.length > 0 && passphrase.length < 8;
  const createPassphraseMismatch =
    step === "create" &&
    confirmPassphrase.length > 0 &&
    passphrase !== confirmPassphrase;
  const createPassphraseHelperText = createPassphraseTooShort
    ? "Minimum 8 characters required."
    : createPassphraseMismatch
      ? "Passphrases do not match."
      : null;
  const canCreatePassphrase =
    !isUnlocking &&
    passphrase.length >= 8 &&
    passphrase === confirmPassphrase;

  const generatedUnlockLabel =
    vaultMode === "generated_default_web_prf" ||
    vaultMode === "generated_default_native_passkey_prf"
      ? "Passkey"
      : vaultMode === "generated_default_native_biometric"
        ? "Device security"
        : "Secure unlock";
  const compactGeneratedUnlockLabel = "Passkey";
  // The web passkey (PRF) path requires a usable platform authenticator. When
  // the browser cannot provide one, the passkey method is unsupported here, so
  // we hide every passkey re-attempt affordance and never invite the user back
  // into a WebAuthn call that can only hang. Native passkey/biometric modes are
  // not affected because they manage their own availability.
  const webPasskeyUnsupported =
    !Capacitor.isNativePlatform() &&
    vaultMode === "generated_default_web_prf" &&
    webPrfDecision === "unavailable";
  const hasGeneratedUnlockAlternative = Boolean(availableGeneratedMethod);
  const showVaultKeyAlternative =
    hasActiveGeneratedWrapper && !unlockWithPassphraseFallback;
  const showPasskeyAlternative =
    !hasActiveGeneratedWrapper &&
    hasGeneratedUnlockAlternative &&
    !unlockWithPassphraseFallback &&
    !webPasskeyUnsupported;
  const showRecoveryAlternative = true;
  const showUnlockOtherMethods =
    showVaultKeyAlternative || showPasskeyAlternative || showRecoveryAlternative;
  const unlockAlternativeCount = [
    showVaultKeyAlternative,
    !webPasskeyUnsupported &&
      ((hasActiveGeneratedWrapper && unlockWithPassphraseFallback) ||
        showPasskeyAlternative),
    showRecoveryAlternative,
  ].filter(Boolean).length;
  const generatedUnlockError =
    hasActiveGeneratedWrapper && !unlockWithPassphraseFallback && error
      ? error
      : null;

  const finalizeUnlock = useCallback(async (decryptedKey: string): Promise<boolean> => {
    if (signOutRequestedRef.current) {
      return false;
    }
    try {
      const { token, expiresAt } = await VaultService.getOrIssueVaultOwnerToken(user.uid);
      if (signOutRequestedRef.current) {
        return false;
      }
      VaultService.setVaultCheckCache(user.uid, true);
      unlockVault(decryptedKey, token, expiresAt);
      onSuccess({ mode: vaultMode });
      return true;
    } catch (tokenError) {
      console.error("Failed to issue VAULT_OWNER token:", tokenError);
      toast.error("Vault opened, but we could not complete access setup. Please try again.");
      return false;
    }
  }, [onSuccess, unlockVault, user.uid, vaultMode]);

  const handleConfirmSignOut = useCallback(async () => {
    if (!onSignOut || isSigningOut || signOutRequestedRef.current) {
      return;
    }
    signOutRequestedRef.current = true;
    setIsSigningOut(true);
    setIsUnlocking(false);
    try {
      await onSignOut();
    } catch (signOutError) {
      signOutRequestedRef.current = false;
      console.error("Vault sign-out escape failed:", signOutError);
      const message = "We could not sign out. Please try again.";
      setError(message);
      toast.error(message);
    } finally {
      setIsSigningOut(false);
    }
  }, [isSigningOut, onSignOut]);

  // Initial Vault Status Check
  useEffect(() => {
    const checkStatus = async () => {
      try {
        // Start the vault-state read in parallel with the existence check so a
        // cold backend pays a single round-trip latency instead of two
        // sequential cold calls (which made the first unlock feel slow). The
        // state read is only awaited on the has-vault branch; if no vault
        // exists we ignore it (and swallow its rejection to avoid an unhandled
        // promise warning).
        const vaultStatePromise = VaultService.getVaultState(user.uid);
        vaultStatePromise.catch(() => undefined);

        const hasVault = await VaultService.checkVault(user.uid);
        if (!hasVault) {
          if (!allowVaultCreation) {
            setStep("setup_required");
            return;
          }
          setVaultMode("passphrase");
          setUnlockWithPassphraseFallback(false);
          setUnlockHint(null);
          // Fresh vault creation is part of the same canonical credential
          // surface as unlock. Do not insert a second education screen here:
          // it adds height above the native keyboard and makes callers such as
          // Connections look like a different vault implementation.
          setStep("create");
          return;
        }

        try {
          setUnlockHint(null);
          const vaultData = await vaultStatePromise;
          const preferPassphraseForAutomation =
            shouldSkipGeneratedVaultUnlockForAutomation();
          const primaryWrapper = VaultService.getPrimaryWrapper(vaultData);
          const quickMethodCandidates: VaultMethod[] = Capacitor.isNativePlatform()
            ? [
                "generated_default_native_passkey_prf",
                "generated_default_native_biometric",
              ]
            : ["generated_default_web_prf"];
          const quickMethod =
            quickMethodCandidates
              .map((method) => VaultService.getWrapperByMethod(vaultData, method))
              .find((wrapper) => !!wrapper) ?? null;
          const nextQuickMethod = (quickMethod?.method as GeneratedVaultKeyMode | undefined) ?? null;
          setAvailableGeneratedMethod(nextQuickMethod);
          const primaryPrefersQuickMethod =
            vaultData.primaryMethod === "generated_default_native_biometric" ||
            vaultData.primaryMethod === "generated_default_web_prf" ||
            vaultData.primaryMethod === "generated_default_native_passkey_prf";

          if (primaryPrefersQuickMethod && !nextQuickMethod) {
            setVaultMode("passphrase");
            setUnlockWithPassphraseFallback(true);
            setUnlockHint(
              toInvestorMessage("VAULT_PASSKEY_ENROLL_REQUIRED")
            );
          } else if (
            preferPassphraseForAutomation &&
            VaultService.getWrapperByMethod(vaultData, "passphrase")
          ) {
            setVaultMode("passphrase");
            setUnlockWithPassphraseFallback(true);
          } else if (primaryPrefersQuickMethod && nextQuickMethod) {
            setVaultMode(nextQuickMethod);
            setUnlockWithPassphraseFallback(preferPassphraseForAutomation);
          } else if (
            primaryWrapper.method === "generated_default_native_biometric" ||
            primaryWrapper.method === "generated_default_web_prf" ||
            primaryWrapper.method === "generated_default_native_passkey_prf"
          ) {
            setVaultMode(primaryWrapper.method);
            setUnlockWithPassphraseFallback(preferPassphraseForAutomation);
          } else {
            setVaultMode(vaultData.primaryMethod);
            setUnlockWithPassphraseFallback(false);
          }
        } catch (metadataError) {
          console.warn("Vault mode detection failed, defaulting to passphrase:", metadataError);
          setVaultMode("passphrase");
          setAvailableGeneratedMethod(null);
          setUnlockWithPassphraseFallback(false);
          setUnlockHint(null);
        }
        setStep("unlock");
      } catch (err) {
        console.error("Vault status check failed:", err);
        const errorCode =
          typeof (err as { code?: unknown } | null | undefined)?.code === "string"
            ? (err as { code: string }).code
            : null;
        const errorHint =
          typeof (err as { hint?: unknown } | null | undefined)?.hint === "string"
            ? (err as { hint: string }).hint
            : null;
        if (errorCode === "DATABASE_UNAVAILABLE") {
          setError(errorHint || toInvestorMessage("LOCAL_BACKEND_UNAVAILABLE"));
        } else {
          setError(toInvestorMessage("VAULT_STATUS_UNAVAILABLE"));
        }
      }
    };
    checkStatus();
  }, [allowVaultCreation, nativeTestConfig.vaultPassphrase, shouldPreferPassphraseUnlock, user.uid]);

  useLayoutEffect(() => {
    if (step !== "unlock") {
      return;
    }
    const testPassphrase = getNativeUiTestVaultPassphrase();
    if (!testPassphrase || !shouldSkipGeneratedVaultUnlockForAutomation()) {
      return;
    }
    setUnlockWithPassphraseFallback(true);
    setPassphrase(testPassphrase);
  }, [step, nativeTestConfig.vaultPassphrase]);

  const handleCreatePassphrase = async () => {
    if (isUnlocking || createPassphraseAttemptRef.current) {
      return;
    }
    if (passphrase.length < 8) {
      toast.error("Use at least 8 characters.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      toast.error("Passphrases do not match.");
      return;
    }

    createPassphraseAttemptRef.current = true;
    setIsUnlocking(true);
    try {
      setError(null);
      // 1. Generate encrypted vault data
      const vaultData = await VaultService.createVault(passphrase);
      const vaultKeyHash = await VaultService.hashVaultKey(vaultData.vaultKeyHex);

      // 2. Save multi-wrapper vault state (mandatory passphrase wrapper)
      await VaultService.setupVaultState(user.uid, {
        vaultKeyHash,
        primaryMethod: "passphrase",
        recoveryEncryptedVaultKey: vaultData.recoveryEncryptedVaultKey,
        recoverySalt: vaultData.recoverySalt,
        recoveryIv: vaultData.recoveryIv,
        wrappers: [
          {
            method: "passphrase",
            encryptedVaultKey: vaultData.encryptedVaultKey,
            salt: vaultData.salt,
            iv: vaultData.iv,
          },
        ],
      });

      // 3. Verify state persisted correctly before moving ahead.
      const persistedState = await VaultService.getVaultState(user.uid);
      await VaultService.assertVaultKeyMatchesState(
        persistedState,
        vaultData.vaultKeyHex
      );
      if (!VaultService.getWrapperByMethod(persistedState, "passphrase")) {
        throw new Error("Vault setup verification failed: passphrase wrapper missing.");
      }

      setVaultMode("passphrase");
      VaultService.setVaultCheckCache(user.uid, true);
      setRecoveryKey(vaultData.recoveryKey);
      setStep("recovery"); // Show recovery key dialog
    } catch (err: any) {
      console.error("Create vault error:", err);
      toast.error(err.message || "We could not create your Vault. Please try again.");
    } finally {
      createPassphraseAttemptRef.current = false;
      setIsUnlocking(false);
    }
  };

  const handleCreatePassphraseSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreatePassphrase) {
      return;
    }
    void handleCreatePassphrase();
  };

  const handleUnlockPassphraseWith = useCallback(async (passphraseValue: string) => {
    setIsUnlocking(true);
    try {
      setError(null);
      const vaultData = await VaultService.getVaultState(user.uid);
      const decryptedKey = await VaultService.unlockWithMethod({
        state: vaultData,
        method: "passphrase",
        secretMaterial: passphraseValue,
      });

      if (decryptedKey) {
        if (enableGeneratedDefault) {
          const capability = await VaultMethodService.getCapabilityMatrix();
          if (capability.recommendedMethod !== "passphrase") {
            const hasRecommendedWrapper =
              VaultService.getWrapperByMethod(vaultData, capability.recommendedMethod) !== null;
            const promptState = await VaultMethodPromptLocalService.load(user.uid);
            const dismissedForRecommendedMethod =
              promptState?.dismissed_for_method === capability.recommendedMethod &&
              promptState?.dismissed_for_rp_id === currentRpId;

            if (!hasRecommendedWrapper && !dismissedForRecommendedMethod) {
              setPendingUnlockKey(decryptedKey);
              setRecommendedQuickMethod(capability.recommendedMethod);
              setStep("method");
              return;
            }
          }
        }
        await finalizeUnlock(decryptedKey);
      } else {
        const message = "That passphrase did not match. Please try again.";
        setError(message);
        toast.error(message);
      }
    } catch (err: any) {
      console.error("Unlock error:", err);
      const message = toInvestorVaultUnlockError(err);
      setError(message);
      toast.error(message);
    } finally {
      setIsUnlocking(false);
    }
  }, [currentRpId, enableGeneratedDefault, finalizeUnlock, user.uid]);

  const handleUnlockPassphrase = useCallback(async () => {
    const passphraseToUse = passphrase;
    return handleUnlockPassphraseWith(passphraseToUse);
  }, [handleUnlockPassphraseWith, passphrase]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const bridge = window.__HUSHH_NATIVE_TEST__;
    if (!bridge?.enabled) {
      return;
    }

    const liveConfig = getNativeTestConfig();
    const testPassphrase = liveConfig.vaultPassphrase?.trim();
    if (!testPassphrase || step !== "unlock" || !isNativeUiTestSession(liveConfig)) {
      return;
    }

    bridge.triggerVaultUnlock = () => {
      if (isUnlocking) {
        return;
      }
      setUnlockWithPassphraseFallback(true);
      setPassphrase(testPassphrase);
      void handleUnlockPassphraseWith(testPassphrase);
    };

    if (shouldPreferPassphraseUnlock) {
      setUnlockWithPassphraseFallback(true);
      setPassphrase(testPassphrase);
      void handleUnlockPassphraseWith(testPassphrase);
    }

    return () => {
      if (window.__HUSHH_NATIVE_TEST__) {
        window.__HUSHH_NATIVE_TEST__.triggerVaultUnlock = null;
      }
    };
  }, [handleUnlockPassphraseWith, isUnlocking, shouldPreferPassphraseUnlock, step]);

  useEffect(() => {
    if (step !== "method" || !isNativeUiTestSession() || !pendingUnlockKey) {
      return;
    }
    void (async () => {
      if (recommendedQuickMethod) {
        try {
          await VaultMethodPromptLocalService.dismiss(
            user.uid,
            recommendedQuickMethod,
            currentRpId
          );
        } catch (dismissError) {
          console.warn("[VaultFlow] UITest quick-unlock dismissal failed:", dismissError);
        }
      }
      await finalizeUnlock(pendingUnlockKey);
    })();
  }, [
    currentRpId,
    finalizeUnlock,
    pendingUnlockKey,
    recommendedQuickMethod,
    step,
    user.uid,
  ]);

  const handleUnlockGeneratedDefault = useCallback(async () => {
    setIsUnlocking(true);
    try {
      setError(null);
      if (
        Capacitor.isNativePlatform() &&
        vaultMode === "generated_default_web_prf"
      ) {
        throw new Error(
          toInvestorMessage("VAULT_PASSKEY_ENROLL_REQUIRED")
        );
      }
      const vaultData = await VaultService.getVaultState(user.uid);
      const generatedWrapper = VaultService.getWrapperByMethod(vaultData, vaultMode, {
        wrapperId:
          vaultData.primaryMethod === vaultMode
            ? vaultData.primaryWrapperId
            : undefined,
      });
      if (!generatedWrapper) {
        throw new Error("Quick unlock is not enabled on this device yet.");
      }
      const decryptedKey = await VaultService.unlockGeneratedDefaultVault({
        userId: user.uid,
        encryptedVaultKey: generatedWrapper.encryptedVaultKey,
        salt: generatedWrapper.salt,
        iv: generatedWrapper.iv,
        keyMode: generatedWrapper.method,
        authMethod: generatedWrapper.method,
        passkeyCredentialId: generatedWrapper.passkeyCredentialId,
        passkeyPrfSalt: generatedWrapper.passkeyPrfSalt,
      });

      if (!decryptedKey) {
        throw new Error("Quick unlock is not ready. Use your passphrase.");
      }

      await VaultService.assertVaultKeyMatchesState(vaultData, decryptedKey);
      await finalizeUnlock(decryptedKey);
      setIsUnlocking(false);
    } catch (err: any) {
      // A pending WebAuthn ceremony that was superseded by a newer attempt
      // rejects with an AbortError. That is expected and not a user-facing
      // failure: the newer attempt owns the unlocking state, so we bail out
      // quietly without surfacing an error or resetting isUnlocking (which the
      // active request still owns).
      if (err?.name === "AbortError") {
        console.debug(
          "Generated vault unlock superseded by a newer attempt; ignoring AbortError."
        );
        return;
      }
      console.error("Generated vault unlock failed:", err);
      const message = toInvestorVaultUnlockError(err);
      setError(message);
      toast.error(message);
      setIsUnlocking(false);
    }
  }, [finalizeUnlock, user.uid, vaultMode]);

  const handleRecoveryKeySubmit = async () => {
    setIsUnlocking(true);
    try {
      setError(null);
      const vaultData = await VaultService.getVaultState(user.uid);
      const decryptedKey = await VaultService.unlockVaultWithRecoveryKey(
        recoveryKeyInput,
        vaultData.recoveryEncryptedVaultKey,
        vaultData.recoverySalt,
        vaultData.recoveryIv
      );

      if (decryptedKey) {
        await VaultService.assertVaultKeyMatchesState(vaultData, decryptedKey);
        await finalizeUnlock(decryptedKey);
      } else {
        const message = "That recovery key did not match. Please try again.";
        setError(message);
        toast.error(message);
      }
    } catch (err: unknown) {
      console.error("Recovery key unlock failed:", err);
      const message = toInvestorVaultUnlockError(err);
      setError(message);
      toast.error(message);
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleCopyRecoveryKey = async () => {
    const copiedToClipboard = await copyToClipboard(recoveryKey);
    if (!copiedToClipboard) {
      toast.error("Could not copy the recovery key on this device.");
      return;
    }

    setCopied(true);
    toast.success("Recovery key copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRecoveryKeyContinue = async () => {
    if (isUnlocking || recoveryContinueAttemptRef.current) {
      return;
    }
    recoveryContinueAttemptRef.current = true;
    setIsUnlocking(true);
    try {
      // Auto-unlock now that unique key is saved
      const vaultData = await VaultService.getVaultState(user.uid);
      const passphraseWrapper = VaultService.getWrapperByMethod(
        vaultData,
        "passphrase"
      );
      let decryptedKey: string | null = null;

      if (passphraseWrapper && passphrase) {
        decryptedKey = await VaultService.unlockWithMethod({
          state: vaultData,
          method: "passphrase",
          secretMaterial: passphrase,
        });
      }

      if (!decryptedKey) {
        throw new Error("Auto-unlock returned empty vault key.");
      }

      // Post-create optional method upsell: keep a single active KEK, but allow
      // immediate switch to quick unlock before entering the app.
      if (vaultMode === "passphrase" && enableGeneratedDefault) {
        const capability = await VaultMethodService.getCapabilityMatrix();
        if (capability.recommendedMethod !== "passphrase") {
          const promptState = await VaultMethodPromptLocalService.load(user.uid);
          const dismissedForRecommendedMethod =
            promptState?.dismissed_for_method === capability.recommendedMethod &&
            promptState?.dismissed_for_rp_id === currentRpId;
          if (!dismissedForRecommendedMethod) {
            setPendingUnlockKey(decryptedKey);
            setRecommendedQuickMethod(capability.recommendedMethod);
            setStep("method");
            return;
          }
        }
      }

      const finalized = await finalizeUnlock(decryptedKey);
      if (!finalized) return;
    } catch (err) {
      console.error("Auto-unlock after creation failed", err);
      // If auto-unlock fails, send user to unlock screen to try manually.
      toast.error(
        vaultMode === "passphrase"
          ? "Quick unlock was not available. Enter your passphrase."
          : "Quick unlock was not available. Try passphrase or recovery key."
      );
      setStep("unlock");
      return;
    } finally {
      recoveryContinueAttemptRef.current = false;
      setIsUnlocking(false);
    }
  };

  // For the web passkey path, detect up front whether a platform authenticator
  // is actually usable. The auto-prompt below waits on this result, so we never
  // fire a navigator.credentials.get() that can only hang and then reject.
  // Native platforms manage their own biometric availability and are left as
  // "available" so their existing auto-prompt behaviour is untouched.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      setWebPrfDecision("available");
      return;
    }
    if (vaultMode !== "generated_default_web_prf") {
      // Non web-PRF modes do not gate on platform authenticator availability.
      setWebPrfDecision("available");
      return;
    }
    let cancelled = false;
    setWebPrfDecision("unknown");
    void (async () => {
      let available = false;
      try {
        available = await checkPrfSupport();
      } catch {
        available = false;
      }
      if (!cancelled) {
        setWebPrfDecision(available ? "available" : "unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultMode]);

  // The web passkey auto-prompt is suppressed both while the availability
  // decision is still pending ("unknown") and when it resolves to
  // "unavailable". This is what closes the race: we never auto-fire the hanging
  // WebAuthn call before we know an authenticator exists.
  const webPrfAutoPromptBlocked =
    vaultMode === "generated_default_web_prf" &&
    !Capacitor.isNativePlatform() &&
    webPrfDecision !== "available";

  // When the browser has no usable platform authenticator, the passkey path is
  // simply not supported here, so do not offer or attempt it at all. Default
  // straight to the passphrase (vault key) method. WebAuthn support is required
  // for the passkey unlock; without it we must never fire navigator.credentials
  // .get(), which would only hang and then reject.
  useEffect(() => {
    if (
      webPrfDecision === "unavailable" &&
      vaultMode === "generated_default_web_prf" &&
      !Capacitor.isNativePlatform()
    ) {
      setUnlockWithPassphraseFallback(true);
    }
  }, [webPrfDecision, vaultMode]);

  useEffect(() => {
    if (
      step !== "unlock" ||
      !hasActiveGeneratedWrapper ||
      skipGeneratedUnlockForAutomation ||
      unlockWithPassphraseFallback ||
      webPrfAutoPromptBlocked
    ) {
      autoGeneratedPromptedRef.current = false;
      return;
    }
    // Never start a second ceremony while one is already running. Without this,
    // a re-render that clears autoGeneratedPromptedRef can re-fire the prompt
    // and the browser rejects it with "A request is already pending."
    if (isUnlocking) return;
    if (autoGeneratedPromptedRef.current) return;
    autoGeneratedPromptedRef.current = true;
    void handleUnlockGeneratedDefault();
  }, [
    handleUnlockGeneratedDefault,
    hasActiveGeneratedWrapper,
    isUnlocking,
    skipGeneratedUnlockForAutomation,
    step,
    unlockWithPassphraseFallback,
    webPrfAutoPromptBlocked,
  ]);

  // Last-resort escape for a user who can't unlock (forgot the vault key AND
  // recovery key). Only rendered on the HARD gate (VaultLockGuard passes
  // onSignOut); it sits below the unlock methods so it's a deliberate last
  // choice.
  const signOutEscape = onSignOut ? (
    <div className="pt-2 flex justify-center">
      <button
        type="button"
        onPointerUp={(event) => {
          event.preventDefault();
          void handleConfirmSignOut();
        }}
        onClick={(event) => {
          event.preventDefault();
          void handleConfirmSignOut();
        }}
        disabled={isSigningOut}
        className="mx-auto flex min-h-11 items-center justify-center gap-1 rounded-full px-3 type-footnote disabled:opacity-50"
      >
        {isSigningOut ? (
          <span className="text-muted-foreground font-semibold">Signing out...</span>
        ) : (
          <>
            <span className="text-muted-foreground">Can&apos;t get in?</span>
            <span className="font-semibold text-[color:var(--app-accent-deep)] underline-offset-2 hover:underline dark:text-[color:var(--app-accent-deep)]">
              Sign out
            </span>
          </>
        )}
      </button>
    </div>
  ) : null;

  if (step === "checking") {
    if (error) {
      return (
        <Card variant="none" effect="fill">
          <div className="p-6 py-8 text-center">
            <div className="space-y-4">
              <div className="text-destructive mb-2">
                <Icon icon={AlertCircle} size={32} className="mx-auto" />
              </div>
              <p className="text-muted-foreground">{error}</p>
              <Button
                onClick={reloadWindow}
                variant="none"
                className="border border-input bg-background hover:bg-accent hover:text-accent-foreground"
              >
                Try again
              </Button>
            </div>
          </div>
        </Card>
      );
    }

    return <HushhLoader label={toInvestorLoading("VAULT")} />;
  }

  return (
    <>
      <div
        data-vault-flow-content
        data-vault-flow-step={step}
        className="max-h-[min(640px,calc(90svh-3rem))] space-y-4 overflow-y-auto px-5 pb-[max(calc(1.25rem+env(safe-area-inset-bottom,0px)),calc(1.25rem+var(--kb-height,0px)))] pt-1 [scrollbar-width:none] sm:px-7 [&::-webkit-scrollbar]:hidden"
      >
          {step === "setup_required" && (
            <div className="mx-auto max-w-[21rem] space-y-4 text-center">
              <VaultFlowHeader
                icon={Lock}
                title="Finish setup first"
                description="Your private vault is the final step after setup."
              />
              <p className="type-footnote leading-snug text-muted-foreground">
                Finish this setup journey, then create your vault from the final security step.
              </p>
            </div>
          )}
          {/* Create Passphrase */}
          {step === "create" && (
            <form
              className="mx-auto max-w-[21rem] space-y-3"
              onSubmit={handleCreatePassphraseSubmit}
            >
              <VaultFlowHeader
                icon={Lock}
                title="Create your private vault"
                description="End-to-end encryption starts here."
              />
              <div className="space-y-1.5">
                <Label htmlFor="passphrase" className="type-footnote font-medium text-muted-foreground">
                  Passphrase
                </Label>
                <div
                  className={cn(
                    "flex h-14 items-center gap-3 rounded-2xl border-[1.5px] bg-black/[0.02] px-4 transition-[border-color,box-shadow] dark:bg-white/[0.04]",
                    "focus-within:border-[color:var(--app-accent)] focus-within:ring-4 focus-within:ring-[color:var(--app-accent-ring)]",
                    passphrase
                      ? "border-[color:var(--app-accent)]"
                      : "border-black/10 dark:border-white/15",
                  )}
                >
                  <Icon icon={Key} size={18} className="shrink-0 text-foreground/50" />
                  <input
                    id="passphrase"
                    type="password"
                    placeholder="Create passphrase"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoFocus
                    autoComplete="new-password"
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-foreground/35"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm" className="type-footnote font-medium text-muted-foreground">
                  Confirm passphrase
                </Label>
                <div
                  className={cn(
                    "flex h-14 items-center gap-3 rounded-2xl border-[1.5px] bg-black/[0.02] px-4 transition-[border-color,box-shadow] dark:bg-white/[0.04]",
                    "focus-within:border-[color:var(--app-accent)] focus-within:ring-4 focus-within:ring-[color:var(--app-accent-ring)]",
                    confirmPassphrase
                      ? "border-[color:var(--app-accent)]"
                      : "border-black/10 dark:border-white/15",
                  )}
                >
                  <Icon icon={Key} size={18} className="shrink-0 text-foreground/50" />
                  <input
                    id="confirm"
                    type="password"
                    placeholder="Confirm passphrase"
                    value={confirmPassphrase}
                    onChange={(e) => setConfirmPassphrase(e.target.value)}
                    autoComplete="new-password"
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-foreground/35"
                  />
                </div>
                {createPassphraseHelperText && (
                  <p className="text-xs font-medium text-destructive" role="status">
                    {createPassphraseHelperText}
                  </p>
                )}
              </div>
              <p className="text-center type-footnote leading-snug text-muted-foreground">
                At least 8 characters. Only you know it.
              </p>
              <Button
                variant="none"
                effect="fill"
                size="default"
                fullWidth
                className="mt-1 h-12 rounded-full type-headline border-0 !bg-[var(--app-accent)] !text-[var(--app-accent-fg)] transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:!bg-[var(--app-accent-hover)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:!bg-black/[0.08] disabled:!text-black/30 disabled:!shadow-none dark:disabled:!bg-white/10 dark:disabled:!text-white/30"
                type="submit"
                disabled={!canCreatePassphrase}
              >
                {isUnlocking ? (
                  <>
                    <Icon icon={Loader2} size="md" className="mr-2 animate-spin" /> Creating vault...
                  </>
                ) : (
                  "Create private vault"
                )}
              </Button>
            </form>
          )}

          {/* Unlock Passphrase */}
          {step === "unlock" && (
            <div className="space-y-2.5">
              <VaultFlowHeader
                icon={isGeneratedVaultMode ? Fingerprint : Lock}
                title="Open your private vault"
                description={
                  isGeneratedVaultMode
                    ? "Confirm with your device."
                    : "Enter your passphrase."
                }
                hint={unlockHint}
              />
              {error ? (
                <Alert
                  role="alert"
                  className="rounded-[18px] border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-tint)] px-3.5 py-3 text-left"
                >
                  <Icon
                    icon={AlertCircle}
                    size="sm"
                    className="mt-0.5 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-deep)]"
                  />
                  <AlertDescription className="type-footnote leading-snug text-foreground">
                    {error}
                  </AlertDescription>
                </Alert>
              ) : null}
              {shouldShowPassphraseUnlock && (
                <div className="space-y-1.5">
                  <Label
                    htmlFor="unlock-passphrase"
                    className="type-footnote font-medium text-muted-foreground"
                  >
                    Passphrase
                  </Label>
                  <div
                    className={cn(
                      "flex h-14 items-center gap-3 rounded-2xl border-[1.5px] bg-black/[0.02] px-4 transition-[border-color,box-shadow] dark:bg-white/[0.04]",
                      "focus-within:border-[color:var(--app-accent)] focus-within:ring-4 focus-within:ring-[color:var(--app-accent-ring)]",
                      passphrase
                        ? "border-[color:var(--app-accent)]"
                        : "border-black/10 dark:border-white/15",
                    )}
                  >
                    <Icon icon={Key} size={18} className="shrink-0 text-foreground/50" />
                    <input
                      id="unlock-passphrase"
                      type="password"
                      placeholder="Enter passphrase"
                      aria-label="Vault passphrase"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && handleUnlockPassphrase()
                      }
                      autoFocus
                      autoComplete="current-password"
                      className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-foreground/35"
                    />
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2 pt-1">
                {shouldShowPassphraseUnlock && (
                  <Button
                    variant="none"
                    effect="fill"
                    size="default"
                    fullWidth
                    className="h-12 rounded-full type-headline border-0 !bg-[var(--app-accent)] !text-[var(--app-accent-fg)] transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:!bg-[var(--app-accent-hover)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:!bg-black/[0.08] disabled:!text-black/30 disabled:!shadow-none dark:disabled:!bg-white/10 dark:disabled:!text-white/30"
                    onClick={() => void handleUnlockPassphrase()}
                    disabled={isUnlocking || !passphrase}
                  >
                    {isUnlocking ? (
                      <>
                        <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" /> Unlocking...
                      </>
                    ) : (
                      "Unlock"
                    )}
                  </Button>
                )}

                {hasActiveGeneratedWrapper && !unlockWithPassphraseFallback && !generatedUnlockError && (
                  // This branch only renders while the passkey path is viable
                  // (supported and available, or still being checked). When the
                  // browser has no authenticator we force the passphrase
                  // fallback above, so this never strands the user in a hanging
                  // WebAuthn prompt.
                  <div className="flex min-h-10 items-center justify-center rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground sm:text-sm">
                    {isUnlocking ? (
                      <span className="inline-flex items-center">
                        <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" />
                        Prompting {generatedUnlockLabel.toLowerCase()}...
                      </span>
                    ) : webPrfAutoPromptBlocked ? (
                      // Decision still pending: show a brief checking state
                      // rather than claiming we are already prompting.
                      <span className="inline-flex items-center">
                        <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" />
                        Checking your device...
                      </span>
                    ) : (
                      `Ready for ${generatedUnlockLabel.toLowerCase()} confirmation.`
                    )}
                  </div>
                )}

                {hasActiveGeneratedWrapper && !unlockWithPassphraseFallback && error && (
                  <Button
                    variant="none"
                    effect="fade"
                    size="default"
                    fullWidth
                    className="h-10 text-sm sm:h-11"
                    onClick={() => void handleUnlockGeneratedDefault()}
                    disabled={isUnlocking}
                  >
                    Try passkey again
                  </Button>
                )}

                {showUnlockOtherMethods ? (
                  <div className="space-y-1.5 pt-1">
                    <p className="type-footnote font-medium text-muted-foreground">Use another method</p>
                    <div
                      className={cn(
                        "grid gap-2",
                        unlockAlternativeCount === 1 ? "grid-cols-1" : "grid-cols-2",
                      )}
                    >
                      {showVaultKeyAlternative ? (
                        <Button
                          variant="none"
                          effect="fade"
                          size="default"
                          fullWidth
                          className={VAULT_ALTERNATIVE_BUTTON_CLASS}
                          data-testid="vault-use-passphrase-instead"
                          onClick={() => {
                            setError(null);
                            setUnlockWithPassphraseFallback(true);
                          }}
                          disabled={isUnlocking}
                        >
                          Passphrase
                        </Button>
                      ) : null}
                      {!webPasskeyUnsupported &&
                      ((hasActiveGeneratedWrapper && unlockWithPassphraseFallback) ||
                        showPasskeyAlternative) ? (
                        <Button
                          variant="none"
                          effect="fade"
                          size="default"
                          fullWidth
                          className={VAULT_ALTERNATIVE_BUTTON_CLASS}
                          onClick={() => {
                            setError(null);
                            setPassphrase("");
                            setUnlockWithPassphraseFallback(false);
                            if (!hasActiveGeneratedWrapper && availableGeneratedMethod) {
                              setVaultMode(availableGeneratedMethod);
                            }
                          }}
                          disabled={isUnlocking}
                        >
                          {compactGeneratedUnlockLabel}
                        </Button>
                      ) : null}
                      {showRecoveryAlternative ? (
                        <Button
                          variant="none"
                          effect="fade"
                          size="default"
                          fullWidth
                          className={VAULT_ALTERNATIVE_BUTTON_CLASS}
                          onClick={() => {
                            setError(null);
                            setStep("recovery");
                          }}
                          disabled={isUnlocking}
                        >
                          Recovery key
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              {signOutEscape}
            </div>
          )}

          {/* Recovery Key Input */}
          {step === "recovery" && !recoveryKey && (
            <div className="space-y-2.5">
              <VaultFlowHeader
                icon={Key}
                title="Enter recovery key"
                description="Use this if your passphrase is unavailable."
              />
              <div className="space-y-1.5">
                <Label htmlFor="recovery-key" className="text-xs font-medium sm:text-sm">Recovery Key</Label>
                <Input
                  id="recovery-key"
                  placeholder="HRK-XXXX-XXXX-XXXX-XXXX"
                  value={recoveryKeyInput}
                  onChange={(e) =>
                    setRecoveryKeyInput(e.target.value.toUpperCase())
                  }
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  className="h-12 rounded-[14px] px-4 font-mono text-[16px]"
                />
              </div>
              <div className="flex flex-col gap-2 pt-2">
                <Button
                  variant="none"
                  effect="fill"
                  size="default"
                  fullWidth
                  className="h-12 rounded-full type-headline border-0 !bg-[var(--app-accent)] !text-[var(--app-accent-fg)] transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:!bg-[var(--app-accent-hover)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:!bg-black/[0.08] disabled:!text-black/30 disabled:!shadow-none dark:disabled:!bg-white/10 dark:disabled:!text-white/30"
                  onClick={handleRecoveryKeySubmit}
                  disabled={isUnlocking || !recoveryKeyInput}
                >
                  {isUnlocking ? (
                    <>
                      <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" /> Unlocking...
                    </>
                  ) : (
                    "Unlock"
                  )}
                </Button>
                <div className="space-y-1.5">
                  <p className="type-footnote font-medium text-muted-foreground">Use another method</p>
                  <div
                    className={cn(
                      "grid gap-2",
                      availableGeneratedMethod && !webPasskeyUnsupported
                        ? "grid-cols-2"
                        : "grid-cols-1",
                    )}
                  >
                    <Button
                      variant="none"
                      effect="fade"
                      size="default"
                      fullWidth
                      className={VAULT_ALTERNATIVE_BUTTON_CLASS}
                      onClick={() => {
                        setError(null);
                        setUnlockWithPassphraseFallback(true);
                        setStep("unlock");
                      }}
                      disabled={isUnlocking}
                    >
                      Passphrase
                    </Button>
                    {availableGeneratedMethod && !webPasskeyUnsupported ? (
                      <Button
                        variant="none"
                        effect="fade"
                        size="default"
                        fullWidth
                        className={VAULT_ALTERNATIVE_BUTTON_CLASS}
                        onClick={() => {
                          setError(null);
                          setPassphrase("");
                          setVaultMode(availableGeneratedMethod);
                          setUnlockWithPassphraseFallback(false);
                          setStep("unlock");
                        }}
                        disabled={isUnlocking}
                      >
                        {compactGeneratedUnlockLabel}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
              {signOutEscape}
            </div>
          )}

          {step === "method" && (
            <div className="space-y-3">
              <VaultFlowHeader
                icon={
                  recommendedQuickMethod === "generated_default_web_prf" ||
                  recommendedQuickMethod ===
                    "generated_default_native_passkey_prf"
                    ? Key
                    : Fingerprint
                }
                title="Enable quicker unlock?"
                description={`You can keep passphrase unlock, or enable ${
                  recommendedQuickMethod === "generated_default_web_prf" ||
                  recommendedQuickMethod ===
                    "generated_default_native_passkey_prf"
                    ? "passkey"
                    : "device biometric"
                } and still retain passphrase and recovery-key backup.`}
              />

              <div className="flex flex-col gap-3 pt-2">
                <Button
                  variant="gradient"
                  effect="glass"
                  size="default"
                  fullWidth
                  className="h-12 rounded-full text-[16px] font-medium"
                  disabled={isUnlocking || !pendingUnlockKey || !recommendedQuickMethod}
                  onClick={async () => {
                    if (!pendingUnlockKey || !recommendedQuickMethod) return;
                    setIsUnlocking(true);
                    try {
                      const result = await VaultMethodService.switchMethod({
                        userId: user.uid,
                        currentVaultKey: pendingUnlockKey,
                        displayName: user.displayName || user.email || "Hussh User",
                        targetMethod: recommendedQuickMethod,
                      });
                      setVaultMode(result.method);
                      const finalized = await finalizeUnlock(pendingUnlockKey);
                      if (!finalized) return;
                      toast.success(
                        result.method === "generated_default_web_prf" ||
                        result.method === "generated_default_native_passkey_prf"
                          ? "Passkey unlock enabled."
                          : "Biometric unlock enabled."
                      );
                    } catch (err: any) {
                      console.error("Quick unlock enable failed:", err);
                      toast.error(
                        err?.message || "Couldn't enable quick unlock right now."
                      );
                    } finally {
                      setIsUnlocking(false);
                    }
                  }}
                >
                  {isUnlocking ? (
                    <>
                      <Icon icon={Loader2} size="md" className="mr-2 animate-spin" />
                      Enabling...
                    </>
                  ) : (
                    `Enable ${
                      recommendedQuickMethod === "generated_default_web_prf" ||
                      recommendedQuickMethod === "generated_default_native_passkey_prf"
                        ? "Passkey"
                        : "Biometric"
                    }`
                  )}
                </Button>

                <Button
                  variant="none"
                  effect="fade"
                  size="default"
                  fullWidth
                  className="h-11 whitespace-normal rounded-full px-4 text-center text-[15px] font-medium leading-snug sm:h-12"
                  disabled={isUnlocking || !pendingUnlockKey}
                  onClick={async () => {
                    if (!pendingUnlockKey) return;
                    if (recommendedQuickMethod) {
                      try {
                        await VaultMethodPromptLocalService.dismiss(
                          user.uid,
                          recommendedQuickMethod,
                          currentRpId
                        );
                      } catch (dismissError) {
                        console.warn(
                          "[VaultFlow] Failed to persist quick-unlock dismissal:",
                          dismissError
                        );
                      }
                    }
                    await finalizeUnlock(pendingUnlockKey);
                  }}
                >
                  Not now
                </Button>
              </div>
            </div>
          )}

          {/* Recovery Key Confirmation (New User) */}
          {step === "recovery" && recoveryKey ? (
            <div
              data-vault-recovery-key
              className="mx-auto max-w-[21rem] space-y-4"
            >
              <VaultFlowHeader
                icon={Key}
                title="Save your recovery key"
                description="Keep it somewhere only you can reach."
              />

              <Alert className="rounded-[18px] border-orange-500/30 bg-orange-500/10">
                <Icon icon={AlertCircle} size="sm" className="text-orange-500" />
                <AlertDescription className="text-[13.5px] leading-[1.4] text-orange-700 dark:text-orange-300">
                  Save this now. It cannot be shown again.
                </AlertDescription>
              </Alert>

              <div className="rounded-[18px] border border-dashed border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-tint)] p-4">
                <code className="break-all font-mono text-[15px] font-medium leading-[1.5] tracking-normal">
                  {recoveryKey}
                </code>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="none"
                  effect="fade"
                  size="default"
                  fullWidth
                  className={VAULT_ALTERNATIVE_BUTTON_CLASS}
                  onClick={handleCopyRecoveryKey}
                >
                  {copied ? (
                    <>
                      <Icon
                        icon={Check}
                        size="sm"
                        className="mr-2 text-green-500"
                      />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Icon icon={Copy} size="sm" className="mr-2" />
                      Copy
                    </>
                  )}
                </Button>
                <Button
                  variant="none"
                  effect="fade"
                  size="default"
                  fullWidth
                  className={VAULT_ALTERNATIVE_BUTTON_CLASS}
                  onClick={async () => {
                    const content = `Hussh Recovery Key\n\n${recoveryKey}\n\nStore this file securely. This is the ONLY way to recover your vault if you lose your vault credentials.`;
                    await downloadTextFile(content, "hushh-recovery-key.txt");
                  }}
                >
                  <Icon icon={Download} size="sm" className="mr-2" />
                  Download
                </Button>
              </div>

              <Button
                variant="none"
                effect="fill"
                size="default"
                fullWidth
                className="h-12 rounded-full type-headline border-0 !bg-[var(--app-accent)] !text-[var(--app-accent-fg)] transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:!bg-[var(--app-accent-hover)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:!bg-black/[0.08] disabled:!text-black/30 disabled:!shadow-none dark:disabled:!bg-white/10 dark:disabled:!text-white/30"
                onClick={handleRecoveryKeyContinue}
                disabled={isUnlocking}
              >
                {isUnlocking
                  ? "Opening vault..."
                  : "I’ve saved my recovery key"}
              </Button>
            </div>
          ) : null}
      </div>
    </>
  );
}
