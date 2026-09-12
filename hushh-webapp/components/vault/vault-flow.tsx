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
  Eye,
  EyeOff,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  VaultAuthSessionNotReadyError,
  VaultService,
} from "@/lib/services/vault-service";
import { downloadTextFile } from "@/lib/utils/native-download";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { User } from "firebase/auth";

import { useVault } from "@/lib/vault/vault-context";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Icon } from "@/lib/morphy-ux/ui";
import { useHostname } from "@/lib/hooks/use-hostname";
import type { GeneratedVaultKeyMode } from "@/lib/services/vault-bootstrap-service";
import { VaultBootstrapService } from "@/lib/services/vault-bootstrap-service";
import { VaultMethodService, type VaultMethod } from "@/lib/services/vault-method-service";
import { VaultMethodPromptLocalService } from "@/lib/services/vault-method-prompt-local-service";
import { resolvePasskeyRpId } from "@/lib/vault/passkey-rp";
import { checkPrfSupport } from "@/lib/vault/prf-auth";
import { copyToClipboard } from "@/lib/utils/clipboard";
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
type VaultUnlockAttempt = { controller: AbortController; userId: string; requestId: string; generatedMode?: GeneratedVaultKeyMode };

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
  /** Hard gates own the automatic passkey ceremony when surfaces overlap. */
  isHardGate?: boolean;
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
  "min-h-11 h-auto whitespace-normal rounded-full border border-[color:var(--app-accent-border)] px-3 py-2 text-[13px] leading-snug font-medium sm:text-[14px] !bg-[color:var(--app-accent-tint)] !text-[color:var(--app-accent-deep)] hover:!bg-[color:var(--app-accent-surface-strong)]";

// A passkey cancellation is a normal user decision, not an application
// failure. Keep it in the credential surface so the user can choose a
// fallback without a disappearing toast or an automatic second ceremony.
//
// A bare "cancel" or "cancelled" substring is too broad — it matches
// aborted fetches, cancelled analytics, and other non-WebAuthn noise.
// Require at least one WebAuthn-specific context word alongside the
// cancellation signal so we only silence real passkey dismissals.
const WEBAUTHN_CANCEL_CONTEXT = [
  "passkey",
  "authentication",
  "credential",
  "webauthn",
  "webauth",
  "user",
  "operation",
  "request",
  "prompt",
  "securitykey",
  "security key",
];
function isWebAuthnCancellationError(value: unknown): boolean {
  const error = value as { name?: unknown; message?: unknown; code?: unknown } | null;
  const name = typeof error?.name === "string" ? error.name.toLowerCase() : "";
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  const message =
    typeof value === "string"
      ? value.toLowerCase()
      : typeof error?.message === "string"
        ? error.message.toLowerCase()
        : "";

  // AbortError / NotAllowedError from navigator.credentials.get are the
  // two most reliable signals — they are DOMException names, not strings.
  if (name === "aborterror" || name === "notallowederror") return true;

  // Structured AbortSignal cancellation codes used by some frameworks.
  if (code.includes("cancel") || code.includes("abort")) return true;

  // For substring matches, require a WebAuthn context word near the cancel
  // term so we don't misclassify unrelated cancellations. Match both
  // British "cancelled" and American "canceled" spellings.
  const hasCancel = (text: string): boolean =>
    /cancell?ed?/i.test(text) || /timed out or was not allowed/i.test(text);

  if (hasCancel(message)) {
    return WEBAUTHN_CANCEL_CONTEXT.some((ctx) => message.includes(ctx));
  }

  // A few platform-specific cancellation strings that carry their own context.
  const explicitCancelPhrases = [
    "passkey request cancelled",
    "passkey request canceled",
    "passkey authentication cancelled",
    "passkey authentication canceled",
    "user cancelled",
    "user canceled",
    "cancelled by user",
    "canceled by user",
  ];
  return explicitCancelPhrases.some((phrase) => message.includes(phrase));
}

function isDuplicateWebAuthnError(value: unknown): boolean {
  const error = value as { name?: unknown; message?: unknown } | null;
  const name = typeof error?.name === "string" ? error.name : "";
  const message = typeof error?.message === "string" ? error.message : "";
  return (
    name === "WebAuthnCeremonyInProgressError" ||
    message.toLowerCase().includes("already in progress")
  );
}

const GENERATED_UNLOCK_CANCELLED_EVENT = "vault-generated-unlock-cancelled";

type GeneratedUnlockClaim = {
  owner: symbol;
  userId: string;
  mode: GeneratedVaultKeyMode;
};

type GeneratedUnlockAttemptSource = "automatic" | "user";

function isGeneratedVaultKeyMode(
  value: string,
): value is GeneratedVaultKeyMode {
  return (
    value === "generated_default_native_biometric" ||
    value === "generated_default_web_prf" ||
    value === "generated_default_native_passkey_prf"
  );
}

// A locked session can briefly have more than one mounted VaultFlow while a
// route gate takes ownership. The browser and the native Credential Manager
// must see one page-wide ceremony. A settled attempt must also outlive a UI
// handoff: browser focus can briefly unmount the flow for session verification,
// but that must not turn a cancellation or provider failure into permission to
// show another passkey prompt.
let activeGeneratedUnlockClaim: GeneratedUnlockClaim | null = null;
let cancelledGeneratedUnlock: Omit<GeneratedUnlockClaim, "owner"> | null = null;

function isGeneratedUnlockCancelled(
  userId: string,
  mode: GeneratedVaultKeyMode,
): boolean {
  return (
    cancelledGeneratedUnlock?.userId === userId &&
    cancelledGeneratedUnlock.mode === mode
  );
}

function clearGeneratedUnlockCancellation(
  userId: string,
  mode: GeneratedVaultKeyMode,
): void {
  if (isGeneratedUnlockCancelled(userId, mode)) {
    cancelledGeneratedUnlock = null;
  }
}

function claimGeneratedUnlock(
  owner: symbol,
  userId: string,
  mode: GeneratedVaultKeyMode,
  source: GeneratedUnlockAttemptSource,
): "claimed" | "busy" | "cancelled" {
  if (source === "automatic" && isGeneratedUnlockCancelled(userId, mode)) {
    return "cancelled";
  }
  if (source === "user") {
    clearGeneratedUnlockCancellation(userId, mode);
  }
  if (
    activeGeneratedUnlockClaim &&
    activeGeneratedUnlockClaim.owner !== owner
  ) {
    return "busy";
  }
  activeGeneratedUnlockClaim = { owner, userId, mode };
  return "claimed";
}

function markGeneratedUnlockCancelled(
  owner: symbol,
  userId: string,
  mode: GeneratedVaultKeyMode,
): void {
  if (activeGeneratedUnlockClaim?.owner !== owner) return;
  cancelledGeneratedUnlock = { userId, mode };
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(GENERATED_UNLOCK_CANCELLED_EVENT, {
        detail: { userId, mode },
      }),
    );
  }
}

function releaseGeneratedUnlock(owner: symbol): void {
  if (activeGeneratedUnlockClaim?.owner !== owner) return;
  activeGeneratedUnlockClaim = null;
}

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
  isHardGate = false,
  allowVaultCreation = true,
  onSignOut,
}: VaultFlowProps) {
  const [step, setStep] = useState<VaultStep>("checking");
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRestoringSession, setIsRestoringSession] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showConfirmPassphrase, setShowConfirmPassphrase] = useState(false);
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
  const pendingUnlockOwnerRef = useRef<string | null>(null);
  const biometricEnrollmentMissingRef = useRef(false);
  const [recommendedQuickMethod, setRecommendedQuickMethod] =
    useState<VaultMethod | null>(null);
  /**
   * The quick-unlock method this device can offer a brand-new vault, probed
   * while the passphrase is still being typed.
   *
   * Creating a vault used to be three screens -- passphrase, recovery key, then
   * a whole screen asking "Enable quicker unlock?" -- and the third one asked a
   * yes/no question the first screen had room for. Probing here is what lets
   * the offer sit next to the passphrase fields: it is a capability check
   * (`isUserVerifyingPlatformAuthenticatorAvailable` and its native
   * equivalents), not an authentication, so it shows no prompt of its own.
   */
  const [createQuickUnlockMethod, setCreateQuickUnlockMethod] =
    useState<VaultMethod | null>(null);
  /**
   * Whether the new vault should get quick unlock, chosen on the create screen.
   *
   * Starts on, because the screen it replaced made "Enable" the primary button
   * and "Not now" the quiet one -- the recommendation moves with the control.
   * Nothing is registered from this alone: the choice is applied on the next
   * deliberate tap, and the operating system's own passkey prompt is still the
   * gate. Passphrase and recovery-key unlock are both retained either way.
   */
  const [createWantsQuickUnlock, setCreateWantsQuickUnlock] = useState(true);
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
  const generatedUnlockAttemptRef = useRef(false);
  const generatedUnlockCancelledRef = useRef(false);
  const flowInstanceRef = useRef(Symbol("vault-flow"));
  const signOutRequestedRef = useRef(false);
  const attemptRef = useRef<VaultUnlockAttempt | null>(null);
  const currentUserIdRef = useRef(user.uid);
  currentUserIdRef.current = user.uid;
  const [biometricLabel, setBiometricLabel] = useState("Biometrics");

  const isCurrentAttempt = useCallback((attempt: VaultUnlockAttempt) =>
    attemptRef.current === attempt && !attempt.controller.signal.aborted &&
    attempt.userId === currentUserIdRef.current && !signOutRequestedRef.current, []);

  const cancelAttempt = useCallback(() => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    if (attempt) {
      attempt.controller.abort();
      if (attempt.generatedMode) {
        markGeneratedUnlockCancelled(flowInstanceRef.current, attempt.userId, attempt.generatedMode);
      }
      void VaultBootstrapService.cancelAuthentication(attempt.requestId).catch(() => undefined);
    }
    generatedUnlockAttemptRef.current = false;
    releaseGeneratedUnlock(flowInstanceRef.current);
  }, []);

  const beginAttempt = useCallback((): VaultUnlockAttempt | null => {
    if (attemptRef.current || signOutRequestedRef.current) return null;
    const attempt = { controller: new AbortController(), userId: user.uid, requestId: crypto.randomUUID() };
    attemptRef.current = attempt;
    return attempt;
  }, [user.uid]);

  const finishAttempt = useCallback((attempt: VaultUnlockAttempt) => {
    if (!isCurrentAttempt(attempt)) return;
    attemptRef.current = null;
    setIsUnlocking(false);
  }, [isCurrentAttempt]);

  const switchUnlockMethod = useCallback(() => {
    cancelAttempt();
    autoGeneratedPromptedRef.current = true;
    generatedUnlockCancelledRef.current = true;
    setIsUnlocking(false);
    setError(null);
  }, [cancelAttempt]);

  useEffect(() => {
    signOutRequestedRef.current = false;
    setPendingUnlockKey(null);
    pendingUnlockOwnerRef.current = null;
    biometricEnrollmentMissingRef.current = false;
    setPassphrase("");
    setConfirmPassphrase("");
    setRecoveryKey("");
    setRecoveryKeyInput("");
    setStep("checking");
    autoGeneratedPromptedRef.current = false;
    return () => { cancelAttempt(); };
  }, [cancelAttempt, user.uid]);

  useEffect(() => {
    let cancelled = false;
    if (Capacitor.isNativePlatform()) {
      void VaultBootstrapService.getBiometricLabel().then((label) => {
        if (!cancelled) setBiometricLabel(label);
      });
    }
    return () => { cancelled = true; };
  }, []);
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

  const { isVaultUnlocked, unlockVault } = useVault();

  useEffect(() => {
    const handleGeneratedUnlockCancelled = (event: Event) => {
      const detail = (event as CustomEvent<{
        userId?: unknown;
        mode?: unknown;
      }>).detail;
      if (detail?.userId !== user.uid || detail.mode !== vaultMode) return;

      generatedUnlockCancelledRef.current = true;
      setUnlockWithPassphraseFallback(true);
      setError(null);
    };

    window.addEventListener(
      GENERATED_UNLOCK_CANCELLED_EVENT,
      handleGeneratedUnlockCancelled,
    );
    return () => {
      window.removeEventListener(
        GENERATED_UNLOCK_CANCELLED_EVENT,
        handleGeneratedUnlockCancelled,
      );
    };
  }, [user.uid, vaultMode]);

  // Notify parent of step changes
  useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);

  // Probe once the create screen is up, so the offer is either there when the
  // passphrase is submitted or not offered at all. A device with no platform
  // authenticator never sees the row, which is the same outcome the separate
  // screen reached by never appearing.
  useEffect(() => {
    if (step !== "create" || !enableGeneratedDefault) return;
    let cancelled = false;
    void (async () => {
      try {
        const capability = await VaultMethodService.getCapabilityMatrix();
        if (cancelled) return;
        setCreateQuickUnlockMethod(
          capability.recommendedMethod === "passphrase"
            ? null
            : capability.recommendedMethod,
        );
      } catch {
        // Unavailable is the safe answer: the vault is still created with a
        // passphrase, exactly as it is on a device that cannot do this.
        if (!cancelled) setCreateQuickUnlockMethod(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enableGeneratedDefault, step]);

  const isPasskeyQuickUnlock =
    createQuickUnlockMethod === "generated_default_web_prf" ||
    createQuickUnlockMethod === "generated_default_native_passkey_prf";
  const createQuickUnlockLabel = isPasskeyQuickUnlock ? "passkey" : biometricLabel;

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
        ? biometricLabel
        : "Secure unlock";
  const compactGeneratedUnlockLabel = availableGeneratedMethod === "generated_default_native_biometric" ? biometricLabel : "Passkey";
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
  const showPasskeyFallbackAlternative =
    !webPasskeyUnsupported &&
    !error &&
    ((hasActiveGeneratedWrapper && unlockWithPassphraseFallback) ||
      showPasskeyAlternative);
  const showRecoveryAlternative = true;
  const showUnlockOtherMethods =
    showVaultKeyAlternative ||
    showPasskeyFallbackAlternative ||
    showRecoveryAlternative;
  const unlockAlternativeCount = [
    showVaultKeyAlternative,
    showPasskeyFallbackAlternative,
    showRecoveryAlternative,
  ].filter(Boolean).length;
  const finalizeUnlock = useCallback(async (decryptedKey: string, attempt: VaultUnlockAttempt): Promise<boolean> => {
    if (!isCurrentAttempt(attempt)) {
      return false;
    }
    try {
      const { token, expiresAt } = await VaultService.getOrIssueVaultOwnerToken(user.uid);
      if (!isCurrentAttempt(attempt)) {
        return false;
      }
      VaultService.setVaultCheckCache(user.uid, true);
      if (unlockVault(decryptedKey, token, expiresAt) === false) return false;
      onSuccess({ mode: vaultMode });
      return true;
    } catch (tokenError) {
      if (!isCurrentAttempt(attempt)) return false;
      console.error("Failed to issue VAULT_OWNER token:", tokenError);
      toast.error("Vault opened, but we could not complete access setup. Please try again.");
      return false;
    }
  }, [isCurrentAttempt, onSuccess, unlockVault, user.uid, vaultMode]);

  const handleConfirmSignOut = useCallback(async () => {
    if (!onSignOut || isSigningOut || signOutRequestedRef.current) {
      return;
    }
    signOutRequestedRef.current = true;
    cancelAttempt();
    setPendingUnlockKey(null);
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
  }, [cancelAttempt, isSigningOut, onSignOut]);

  // Initial Vault Status Check
  useEffect(() => {
    let cancelled = false;
    const MAX_SESSION_RESTORE_ATTEMPTS = 3;

    const checkStatus = async (restoreAttempt = 0) => {
      try {
        setIsRestoringSession(false);
        // Start the vault-state read in parallel with the existence check so a
        // cold backend pays a single round-trip latency instead of two
        // sequential cold calls (which made the first unlock feel slow). The
        // state read is only awaited on the has-vault branch; if no vault
        // exists we ignore it (and swallow its rejection to avoid an unhandled
        // promise warning).
        const vaultStatePromise = VaultService.getVaultState(user.uid);
        vaultStatePromise.catch(() => undefined);

        const hasVault = await VaultService.checkVault(user.uid);
        if (cancelled) return;
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
          if (cancelled) return;
          const preferPassphraseForAutomation =
            shouldSkipGeneratedVaultUnlockForAutomation();
          const primaryWrapper = VaultService.getPrimaryWrapper(vaultData);
          const quickMethodCandidates: VaultMethod[] = Capacitor.isNativePlatform()
            ? [
                "generated_default_native_biometric",
                "generated_default_native_passkey_prf",
              ]
            : ["generated_default_web_prf"];
          const deviceWrapperId = Capacitor.isNativePlatform()
            ? await VaultBootstrapService.getDeviceBiometricWrapperId(user.uid).catch(() => "default")
            : "default";
          if (cancelled) return;
          const quickMethod =
            quickMethodCandidates
              .map((method) => VaultService.getWrapperByMethod(vaultData, method,
                method === "generated_default_native_biometric" ? { wrapperId: deviceWrapperId } : undefined))
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
            setUnlockWithPassphraseFallback(preferPassphraseForAutomation || isGeneratedUnlockCancelled(user.uid, nextQuickMethod));
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
          // A failed metadata read is not evidence of a passphrase Vault.
          // In particular, terminal account errors must never select unlock.
          throw metadataError;
        }
        setStep("unlock");
      } catch (err) {
        if (cancelled) return;
        // A Firebase session still restoring is not a Vault failure -- it is
        // evidence we asked before a token existed. Show a transient
        // "restoring" state and retry a bounded number of times instead of
        // surfacing a hard failure for what is, in most cases, a race that
        // resolves within a second.
        if (
          err instanceof VaultAuthSessionNotReadyError &&
          restoreAttempt < MAX_SESSION_RESTORE_ATTEMPTS
        ) {
          if (cancelled) return;
          setIsRestoringSession(true);
          setError(null);
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (cancelled) return;
          await checkStatus(restoreAttempt + 1);
          return;
        }

        console.error("Vault status check failed:", err);
        setIsRestoringSession(false);
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
    void checkStatus();
    return () => {
      cancelled = true;
    };
  }, [
    allowVaultCreation,
    checkAttempt,
    nativeTestConfig.vaultPassphrase,
    shouldPreferPassphraseUnlock,
    user.uid,
  ]);

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

    const attempt = beginAttempt();
    if (!attempt) return;
    createPassphraseAttemptRef.current = true;
    setIsUnlocking(true);
    try {
      setError(null);
      // 1. Generate encrypted vault data
      const vaultData = await VaultService.createVault(passphrase);
      const vaultKeyHash = await VaultService.hashVaultKey(vaultData.vaultKeyHex);
      if (!isCurrentAttempt(attempt)) return;

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
      if (!isCurrentAttempt(attempt)) return;

      setVaultMode("passphrase");
      VaultService.setVaultCheckCache(user.uid, true);
      setRecoveryKey(vaultData.recoveryKey);
      setStep("recovery"); // Show recovery key dialog
    } catch (err: any) {
      if (!isCurrentAttempt(attempt)) return;
      console.error("Create vault error:", err);
      toast.error(err.message || "We could not create your Vault. Please try again.");
    } finally {
      createPassphraseAttemptRef.current = false;
      finishAttempt(attempt);
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
    const attempt = beginAttempt();
    if (!attempt) return;
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
        if (!isCurrentAttempt(attempt)) return;
        if (enableGeneratedDefault) {
          try {
          const capability = await VaultMethodService.getCapabilityMatrix();
          if (capability.recommendedMethod !== "passphrase") {
            const deviceWrapperId = capability.recommendedMethod === "generated_default_native_biometric"
              ? await VaultBootstrapService.getDeviceBiometricWrapperId(user.uid).catch(() => "default")
              : undefined;
            const hasRecommendedWrapper = VaultService.getWrapperByMethod(vaultData,
              capability.recommendedMethod, deviceWrapperId ? { wrapperId: deviceWrapperId } : undefined) !== null &&
              !(capability.recommendedMethod === "generated_default_native_biometric" && biometricEnrollmentMissingRef.current);
            const promptState = await VaultMethodPromptLocalService.load(user.uid);
            const dismissedForRecommendedMethod =
              promptState?.dismissed_for_method === capability.recommendedMethod &&
              promptState?.dismissed_for_rp_id === currentRpId;
            if (!isCurrentAttempt(attempt)) return;

            if (!hasRecommendedWrapper && !dismissedForRecommendedMethod) {
              pendingUnlockOwnerRef.current = user.uid;
              setPendingUnlockKey(decryptedKey);
              setRecommendedQuickMethod(capability.recommendedMethod);
              setStep("method");
              return;
            }
          }
          } catch {
            // The verified passphrase remains authoritative when optional
            // device discovery or preference storage is unavailable.
            if (!isCurrentAttempt(attempt)) return;
          }
        }
        await finalizeUnlock(decryptedKey, attempt);
      } else {
        if (!isCurrentAttempt(attempt)) return;
        const message = "That passphrase did not match. Please try again.";
        setError(message);
        toast.error(message);
      }
    } catch (err: any) {
      if (!isCurrentAttempt(attempt)) return;
      console.error("Unlock error:", err);
      if (isWebAuthnCancellationError(err)) {
        setError(null);
        return;
      }
      const message = toInvestorVaultUnlockError(err);
      setError(message);
      toast.error(message);
    } finally {
      finishAttempt(attempt);
    }
  }, [beginAttempt, currentRpId, enableGeneratedDefault, finalizeUnlock, finishAttempt, isCurrentAttempt, user.uid]);

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
    if (step !== "method" || !isNativeUiTestSession() || !pendingUnlockKey || pendingUnlockOwnerRef.current !== user.uid) {
      return;
    }
    void (async () => {
      const attempt = beginAttempt();
      if (!attempt) return;
      try {
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
      await finalizeUnlock(pendingUnlockKey, attempt);
      } finally { finishAttempt(attempt); }
    })();
  }, [
    currentRpId,
    beginAttempt,
    finishAttempt,
    finalizeUnlock,
    pendingUnlockKey,
    recommendedQuickMethod,
    step,
    user.uid,
  ]);

  const handleUnlockGeneratedDefault = useCallback(
    async (source: GeneratedUnlockAttemptSource = "user", selectedMode: VaultMode = vaultMode) => {
      if (
        generatedUnlockAttemptRef.current ||
        !isGeneratedVaultKeyMode(selectedMode)
      ) {
        return;
      }
      const generatedMode = selectedMode;
      const claim = claimGeneratedUnlock(
        flowInstanceRef.current,
        user.uid,
        generatedMode,
        source,
      );
      if (claim === "cancelled") {
        generatedUnlockCancelledRef.current = true;
        setUnlockWithPassphraseFallback(true);
        setError(null);
        return;
      }
      if (claim === "busy") {
        return;
      }
      const attempt = beginAttempt();
      if (!attempt) {
        releaseGeneratedUnlock(flowInstanceRef.current);
        return;
      }
      attempt.generatedMode = generatedMode;
      generatedUnlockAttemptRef.current = true;
      setIsUnlocking(true);
      try {
        setError(null);
        if (
          Capacitor.isNativePlatform() &&
          generatedMode === "generated_default_web_prf"
        ) {
          throw new Error(
            toInvestorMessage("VAULT_PASSKEY_ENROLL_REQUIRED")
          );
        }
        const vaultData = await VaultService.getVaultState(user.uid);
        const deviceWrapperId = generatedMode === "generated_default_native_biometric"
          ? await VaultBootstrapService.getDeviceBiometricWrapperId(user.uid)
          : undefined;
        if (!isCurrentAttempt(attempt)) return;
        const generatedWrapper = VaultService.getWrapperByMethod(vaultData, generatedMode, {
          wrapperId:
            deviceWrapperId ?? (vaultData.primaryMethod === generatedMode
              ? vaultData.primaryWrapperId
              : undefined),
        });
        if (!generatedWrapper) {
          throw new Error("Quick unlock is not enabled on this device yet.");
        }
        const decryptedKey = await VaultService.unlockGeneratedDefaultVault({
          userId: user.uid,
          wrapperId: generatedWrapper.wrapperId,
          signal: attempt.controller.signal,
          requestId: attempt.requestId,
          encryptedVaultKey: generatedWrapper.encryptedVaultKey,
          salt: generatedWrapper.salt,
          iv: generatedWrapper.iv,
          keyMode: generatedWrapper.method,
          authMethod: generatedWrapper.method,
          passkeyCredentialId: generatedWrapper.passkeyCredentialId,
          passkeyPrfSalt: generatedWrapper.passkeyPrfSalt,
          passkeyRpId: generatedWrapper.passkeyRpId,
        });

        if (!decryptedKey) {
          throw new Error("Quick unlock is not ready. Use your passphrase.");
        }

        await VaultService.assertVaultKeyMatchesState(vaultData, decryptedKey);
        if (!isCurrentAttempt(attempt)) return;
        if (!(await finalizeUnlock(decryptedKey, attempt))) {
          throw new Error("We could not complete Vault access. Please try again.");
        }
      } catch (err: any) {
        if (!isCurrentAttempt(attempt)) return;
        if (err?.code === "VAULT_DEVICE_WRAPPER_UNAVAILABLE") biometricEnrollmentMissingRef.current = true;
        // A duplicate caller is rejected before it can reach the browser. The
        // original ceremony remains active and owns the visible prompt.
        if (isDuplicateWebAuthnError(err)) {
          return;
        }
        if (isWebAuthnCancellationError(err)) {
          generatedUnlockCancelledRef.current = true;
          markGeneratedUnlockCancelled(
            flowInstanceRef.current,
            user.uid,
            generatedMode,
          );
          setUnlockWithPassphraseFallback(true);
          setError(null);
          return;
        }
        console.error("Generated vault unlock failed:", err);
        // Google Password Manager and the platform authenticator can fail
        // after opening their UI. Keep that outcome session-scoped too: a
        // focus-driven remount must not immediately reopen the same ceremony.
        // The visible Passkey action explicitly clears this block and is the
        // only way to begin another attempt.
        generatedUnlockCancelledRef.current = true;
        markGeneratedUnlockCancelled(
          flowInstanceRef.current,
          user.uid,
          generatedMode,
        );
        setUnlockWithPassphraseFallback(true);
        const message = toInvestorVaultUnlockError(err);
        setError(message);
      } finally {
        if (isCurrentAttempt(attempt)) {
          generatedUnlockAttemptRef.current = false;
          releaseGeneratedUnlock(flowInstanceRef.current);
          finishAttempt(attempt);
        }
      }
    },
    [beginAttempt, finalizeUnlock, finishAttempt, isCurrentAttempt, user.uid, vaultMode],
  );

  const handleRetryGeneratedUnlock = useCallback((selectedMode: VaultMode = vaultMode) => {
    if (attemptRef.current || !isGeneratedVaultKeyMode(selectedMode)) return;
    generatedUnlockCancelledRef.current = false;
    clearGeneratedUnlockCancellation(user.uid, selectedMode);
    setVaultMode(selectedMode);
    setError(null);
    setUnlockWithPassphraseFallback(false);
    void handleUnlockGeneratedDefault("user", selectedMode);
  }, [handleUnlockGeneratedDefault, user.uid, vaultMode]);

  const handleRecoveryKeySubmit = async () => {
    const attempt = beginAttempt();
    if (!attempt) return;
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
        await finalizeUnlock(decryptedKey, attempt);
      } else {
        if (!isCurrentAttempt(attempt)) return;
        const message = "That recovery key did not match. Please try again.";
        setError(message);
        toast.error(message);
      }
    } catch (err: unknown) {
      if (!isCurrentAttempt(attempt)) return;
      console.error("Recovery key unlock failed:", err);
      const message = toInvestorVaultUnlockError(err);
      setError(message);
      toast.error(message);
    } finally {
      finishAttempt(attempt);
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
    const attempt = beginAttempt();
    if (!attempt) return;
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
      if (!isCurrentAttempt(attempt)) return;

      // The answer was already given on the create screen, so this applies it
      // rather than asking again on a third screen.
      //
      // Applied HERE, on this tap, and not inside the create submit: registering
      // a passkey requires a recent user gesture, and creating the vault spends
      // seconds on key derivation first -- long enough for browsers to consider
      // the original tap stale and refuse the prompt. Continue is a fresh tap.
      if (vaultMode === "passphrase" && enableGeneratedDefault && createQuickUnlockMethod) {
        if (createWantsQuickUnlock) {
          try {
            const result = await VaultMethodService.switchMethod({
              userId: user.uid,
              currentVaultKey: decryptedKey,
              displayName: user.displayName || user.email || "Hussh User",
              targetMethod: createQuickUnlockMethod,
              signal: attempt.controller.signal,
              requestId: attempt.requestId,
            });
            if (!isCurrentAttempt(attempt)) return;
            setVaultMode(result.method);
            toast.success(
              result.method === "generated_default_web_prf" ||
                result.method === "generated_default_native_passkey_prf"
                ? "Passkey unlock enabled."
                : "Biometric unlock enabled."
            );
          } catch (quickUnlockError) {
            if (!isCurrentAttempt(attempt)) return;
            // A refused or unavailable authenticator must not cost the vault
            // that was just created. The passphrase wrapper is already written,
            // so the only thing lost is the shortcut.
            if (!isWebAuthnCancellationError(quickUnlockError)) {
              console.warn("Quick unlock enable failed:", quickUnlockError);
              toast.error("Couldn't turn that on. Your passphrase still works.");
            }
          }
        } else {
          try {
            await VaultMethodPromptLocalService.dismiss(
              user.uid,
              createQuickUnlockMethod,
              currentRpId
            );
          } catch (dismissError) {
            console.warn(
              "[VaultFlow] Failed to persist quick-unlock dismissal:",
              dismissError
            );
          }
        }
      }

      const finalized = await finalizeUnlock(decryptedKey, attempt);
      if (!finalized) return;
    } catch (err) {
      if (!isCurrentAttempt(attempt)) return;
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
      finishAttempt(attempt);
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
    const anotherHardGateIsActive =
      !isHardGate &&
      typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-vault-unlock-hard-gate");
    if (
      isVaultUnlocked ||
      !Capacitor.isNativePlatform() ||
      anotherHardGateIsActive ||
      step !== "unlock" ||
      !hasActiveGeneratedWrapper ||
      skipGeneratedUnlockForAutomation ||
      unlockWithPassphraseFallback ||
      webPrfAutoPromptBlocked
    ) {
      return;
    }
    // Never start a second ceremony while one is already running. Without this,
    // a re-render that clears autoGeneratedPromptedRef can re-fire the prompt
    // and the browser rejects it with "A request is already pending."
    if (isUnlocking) return;
    if (autoGeneratedPromptedRef.current) return;
    autoGeneratedPromptedRef.current = true;
    if (
      isGeneratedVaultKeyMode(vaultMode) &&
      isGeneratedUnlockCancelled(user.uid, vaultMode)
    ) {
      generatedUnlockCancelledRef.current = true;
      setUnlockWithPassphraseFallback(true);
      setError(null);
      return;
    }
    void handleUnlockGeneratedDefault("automatic");
  }, [
    handleUnlockGeneratedDefault,
    hasActiveGeneratedWrapper,
    isUnlocking,
    isVaultUnlocked,
    isHardGate,
    skipGeneratedUnlockForAutomation,
    step,
    user.uid,
    unlockWithPassphraseFallback,
    vaultMode,
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
                onClick={() => {
                  // A clean restart of the whole check, not a page reload:
                  // re-enter "checking" and re-run the effect from scratch
                  // rather than dragging a stale error/step across a retry.
                  setError(null);
                  setIsRestoringSession(false);
                  setCheckAttempt((attempt) => attempt + 1);
                }}
                variant="none"
                className="border border-input bg-background hover:bg-accent hover:text-accent-foreground"
              >
                Try again
              </Button>
              {signOutEscape}
            </div>
          </div>
        </Card>
      );
    }

    return (
      <HushhLoader
        label={
          isRestoringSession
            ? "Restoring your session…"
            : toInvestorLoading("VAULT")
        }
      />
    );
  }

  return (
    <>
      <div
        data-vault-flow-content
        data-vault-flow-step={step}
        className="max-h-[var(--vault-available-height,min(640px,calc(90svh-3rem-var(--kb-height,0px))))] space-y-4 overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] pt-1 [scrollbar-width:none] sm:px-7 [&::-webkit-scrollbar]:hidden"
      >
          {step === "setup_required" && (
            <div className="mx-auto max-w-[21rem] space-y-4 text-center">
              <VaultFlowHeader
                icon={Lock}
                title="Finish setup first"
                description="This is the last step."
              />
              <p className="type-footnote leading-snug text-muted-foreground">
                Finish setting up, then come back here.
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
                /* "Set a lock" — the phrase this product already uses for
                   this exact dialog. one-setup-hub.tsx:607 passes it as the
                   dialog's accessible title while the visible heading said
                   something else, so the screen announced one name and showed
                   another. It also stops naming the mechanism: what the person
                   is doing is locking their private place, and the passphrase
                   is merely how. The fields below still say "Passphrase",
                   which is where that word belongs. */
                title="Set a lock"
                // Carries the promise the removed "private place" invitation
                // screen used to make, on the step that actually needs it.
                description="Only you can open what you save."
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
                    type={showPassphrase ? "text" : "password"}
                    placeholder="Create passphrase"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoFocus
                    autoComplete="new-password"
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-foreground/35"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassphrase((prev) => !prev)}
                    className="shrink-0 p-1 text-foreground/50 transition-colors hover:text-foreground focus:outline-none"
                    aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                    title={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                  >
                    <Icon icon={showPassphrase ? EyeOff : Eye} size={18} />
                  </button>
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
                    type={showConfirmPassphrase ? "text" : "password"}
                    placeholder="Confirm passphrase"
                    value={confirmPassphrase}
                    onChange={(e) => setConfirmPassphrase(e.target.value)}
                    autoComplete="new-password"
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-foreground/35"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassphrase((prev) => !prev)}
                    className="shrink-0 p-1 text-foreground/50 transition-colors hover:text-foreground focus:outline-none"
                    aria-label={showConfirmPassphrase ? "Hide passphrase" : "Show passphrase"}
                    title={showConfirmPassphrase ? "Hide passphrase" : "Show passphrase"}
                  >
                    <Icon icon={showConfirmPassphrase ? EyeOff : Eye} size={18} />
                  </button>
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
              {createQuickUnlockMethod ? (
                // The whole of the screen this replaced. It asked one yes/no
                // question after the vault already existed, so the answer cost
                // a screen; asked here it costs a switch, and the vault is
                // created once with the answer already known.
                <label
                  data-vault-quick-unlock-option
                  htmlFor="vault-quick-unlock"
                  className="flex items-center gap-3 rounded-2xl border border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-tint)] px-4 py-3 text-left"
                >
                  <Icon
                    icon={isPasskeyQuickUnlock ? Key : Fingerprint}
                    size={18}
                    className="shrink-0 text-[color:var(--app-accent-deep)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block type-subhead font-medium text-foreground">
                      Also unlock with {createQuickUnlockLabel}
                    </span>
                    <span className="block type-footnote leading-snug text-muted-foreground">
                      Your passphrase and recovery key still work.
                    </span>
                  </span>
                  <Switch
                    id="vault-quick-unlock"
                    checked={createWantsQuickUnlock}
                    onCheckedChange={setCreateWantsQuickUnlock}
                    disabled={isUnlocking}
                  />
                </label>
              ) : null}
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
                    <Icon icon={Loader2} size="md" className="mr-2 animate-spin" /> Creating...
                  </>
                ) : (
                  "Create passphrase"
                )}
              </Button>
            </form>
          )}

          {/* Unlock Passphrase */}
          {step === "unlock" && (
            <div className="space-y-2.5">
              <VaultFlowHeader
                icon={isGeneratedVaultMode ? Fingerprint : Lock}
                title="Unlock One"
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
                      type={showPassphrase ? "text" : "password"}
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
                    <button
                      type="button"
                      onClick={() => setShowPassphrase((prev) => !prev)}
                      className="shrink-0 p-1 text-foreground/50 transition-colors hover:text-foreground focus:outline-none"
                      aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                      title={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                    >
                      <Icon icon={showPassphrase ? EyeOff : Eye} size={18} />
                    </button>
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

                {hasActiveGeneratedWrapper && !unlockWithPassphraseFallback && !webPasskeyUnsupported && (
                  <Button
                    variant="blue-gradient"
                    effect="fill"
                    size="lg"
                    fullWidth
                    className="min-h-12 rounded-full px-4 py-3 text-[16px] font-semibold whitespace-normal"
                    onClick={() => handleRetryGeneratedUnlock()}
                    disabled={isUnlocking || webPrfAutoPromptBlocked}
                  >
                    {isUnlocking ? (
                      <span className="inline-flex items-center">
                        <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" />
                        Unlocking with {generatedUnlockLabel}…
                      </span>
                    ) : webPrfAutoPromptBlocked ? (
                      // Decision still pending: show a brief checking state
                      // rather than claiming we are already prompting.
                      <span className="inline-flex items-center">
                        <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" />
                        Checking your device...
                      </span>
                    ) : (
                      `Unlock with ${generatedUnlockLabel}`
                    )}
                  </Button>
                )}

                {hasActiveGeneratedWrapper && error && (
                  <Button
                    variant="none"
                    effect="fade"
                    size="default"
                    fullWidth
                    className="h-10 text-sm sm:h-11"
                    onClick={() => handleRetryGeneratedUnlock()}
                    disabled={isUnlocking}
                  >
                    Unlock with {generatedUnlockLabel}
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
                            switchUnlockMethod();
                            setUnlockWithPassphraseFallback(true);
                          }}
                          disabled={isSigningOut}
                        >
                          Passphrase
                        </Button>
                      ) : null}
                      {showPasskeyFallbackAlternative ? (
                        <Button
                          variant="none"
                          effect="fade"
                          size="default"
                          fullWidth
                          className={VAULT_ALTERNATIVE_BUTTON_CLASS}
                          onClick={() => {
                            switchUnlockMethod();
                            setPassphrase("");
                            if (availableGeneratedMethod) handleRetryGeneratedUnlock(availableGeneratedMethod);
                          }}
                          disabled={isSigningOut}
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
                            switchUnlockMethod();
                            setStep("recovery");
                          }}
                          disabled={isSigningOut}
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
                        switchUnlockMethod();
                        setUnlockWithPassphraseFallback(true);
                        setStep("unlock");
                      }}
                      disabled={isSigningOut}
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
                          switchUnlockMethod();
                          setPassphrase("");
                          setStep("unlock");
                          handleRetryGeneratedUnlock(availableGeneratedMethod);
                        }}
                        disabled={isSigningOut}
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
            <div className="space-y-4">
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
                    : biometricLabel
                } and still retain passphrase and recovery-key backup.`}
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

              <div className="flex flex-col gap-3 pt-2">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="lg"
                  fullWidth
                  className="h-12 rounded-full text-[15px] font-semibold"
                  disabled={isUnlocking || !pendingUnlockKey || !recommendedQuickMethod}
                  onClick={async () => {
                    if (!pendingUnlockKey || !recommendedQuickMethod || pendingUnlockOwnerRef.current !== user.uid) return;
                    const attempt = beginAttempt();
                    if (!attempt) return;
                    setIsUnlocking(true);
                    try {
                      const result = await VaultMethodService.switchMethod({
                        userId: user.uid,
                        currentVaultKey: pendingUnlockKey,
                        displayName: user.displayName || user.email || "Hussh User",
                        targetMethod: recommendedQuickMethod,
                        signal: attempt.controller.signal,
                        requestId: attempt.requestId,
                      });
                      if (!isCurrentAttempt(attempt)) return;
                      setVaultMode(result.method);
                      const finalized = await finalizeUnlock(pendingUnlockKey, attempt);
                      if (!finalized) return;
                      toast.success(
                        result.method === "generated_default_web_prf" ||
                        result.method === "generated_default_native_passkey_prf"
                          ? "Passkey unlock enabled."
                          : "Biometric unlock enabled."
                      );
                    } catch (err: any) {
                      if (!isCurrentAttempt(attempt)) return;
                      if (isWebAuthnCancellationError(err)) {
                        setError(
                          "Quick unlock setup was cancelled. Your passphrase still works."
                        );
                      } else {
                        console.error("Quick unlock enable failed:", err);
                        toast.error(
                          err?.message || "Couldn't enable quick unlock right now."
                        );
                      }
                    } finally {
                      finishAttempt(attempt);
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
                        : biometricLabel
                    }`
                  )}
                </Button>

                <Button
                  variant="none"
                  effect="fade"
                  size="lg"
                  fullWidth
                  className="h-12 rounded-full border border-[color:var(--app-accent-border)] !bg-[color:var(--app-accent-tint)] px-4 text-center text-[15px] font-medium !text-[color:var(--app-accent-deep)] transition-colors hover:!bg-[color:var(--app-accent-surface-strong)]"
                  disabled={isSigningOut || !pendingUnlockKey}
                  onClick={async () => {
                    if (!pendingUnlockKey || pendingUnlockOwnerRef.current !== user.uid) return;
                    switchUnlockMethod();
                    const attempt = beginAttempt();
                    if (!attempt) return;
                    setIsUnlocking(true);
                    try {
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
                    await finalizeUnlock(pendingUnlockKey, attempt);
                    } finally { finishAttempt(attempt); }
                  }}
                >
                  Not now, continue with passphrase
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
                {isUnlocking ? "Opening..." : "I’ve saved my recovery key"}
              </Button>
            </div>
          ) : null}
      </div>
    </>
  );
}
