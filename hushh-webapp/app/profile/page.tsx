"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bug,
  Cloud,
  Code2,
  Fingerprint,
  Folder,
  KeyRound,
  LifeBuoy,
  Loader2,
  LogOut,
  Mail,
  MessageSquare,
  Monitor,
  RefreshCw,
  SendHorizontal,
  Trash2,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { KaiPreferencesSheet } from "@/components/kai/onboarding/KaiPreferencesSheet";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { ThemeToggle } from "@/components/theme-toggle";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { resolveAppEnvironment } from "@/lib/app-env";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";
import { resolveDeleteAccountAuth } from "@/lib/flows/delete-account";
import { ROUTES } from "@/lib/navigation/routes";
import {
  resolveGmailConnectionPresentation,
  resolveGmailStatusSummary,
  sanitizeGmailUserMessage,
} from "@/lib/profile/mail-flow";
import { usePersonaState } from "@/lib/persona/persona-context";
import { Icon } from "@/lib/morphy-ux/ui";
import { Button } from "@/lib/morphy-ux/morphy";
import {
  AccountService,
  type AccountDeletionTarget,
} from "@/lib/services/account-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { RiaService } from "@/lib/services/ria-service";
import {
  SupportService,
  type SupportMessageKind,
} from "@/lib/services/support-service";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import { VaultService } from "@/lib/services/vault-service";
import {
  VaultMethodService,
  type VaultCapabilityMatrix,
  type VaultMethod,
} from "@/lib/services/vault-method-service";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/voice/voice-surface-metadata";
import {
  PersonalKnowledgeModelService,
  type DomainSummary,
} from "@/lib/services/personal-knowledge-model-service";
import { useVault } from "@/lib/vault/vault-context";
import { resolveVaultAvailabilityState } from "@/lib/vault/vault-access-policy";

type ProfileTab = "account" | "preferences" | "privacy";
type ProfilePanel = "security" | "support" | "consents" | "gmail";

const SUPPORT_KIND_COPY: Record<
  SupportMessageKind,
  { title: string; description: string; subject: string }
> = {
  bug_report: {
    title: "Report a bug",
    description: "Tell us what broke, what you expected, and anything we should look at.",
    subject: "Bug report",
  },
  support_request: {
    title: "Contact support",
    description: "Ask for help with your account, portfolio flows, or something unclear in the app.",
    subject: "Support request",
  },
  developer_reachout: {
    title: "Reach the developer",
    description: "Share product feedback, implementation notes, or a direct engineering question.",
    subject: "Developer feedback",
  },
};

function normalizeProfileTab(value: string | null): ProfileTab {
  if (value === "preferences" || value === "privacy") {
    return value;
  }
  return "account";
}

function normalizeProfilePanel(value: string | null): ProfilePanel | null {
  if (
    value === "security" ||
    value === "support" ||
    value === "consents" ||
    value === "gmail"
  ) {
    return value;
  }
  return null;
}

function getProvider(user: ReturnType<typeof useAuth>["user"]) {
  if (!user?.providerData || user.providerData.length === 0) {
    return { name: "Unknown", id: "unknown" };
  }

  const providerId = user.providerData[0]?.providerId;
  switch (providerId) {
    case "google.com":
      return { name: "Google", id: "google" };
    case "apple.com":
      return { name: "Apple", id: "apple" };
    case "password":
      return { name: "Email/Password", id: "password" };
    default:
      return { name: providerId || "Unknown", id: providerId || "unknown" };
  }
}

function ProviderIcon({ providerId }: { providerId: string }) {
  if (providerId === "google") {
    return (
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        />
        <path
          fill="currentColor"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="currentColor"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          fill="currentColor"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    );
  }

  if (providerId === "apple") {
    return (
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M17.05 20.28c-.98.95-2.05.88-3.08.38-1.07-.52-2.07-.51-3.2 0-1.01.43-2.1.49-2.98-.38C5.22 17.63 2.7 12 5.45 8.04c1.47-2.09 3.8-2.31 5.33-1.18 1.1.75 3.3.73 4.45-.04 2.1-1.31 3.55-.95 4.5 1.14-.15.08.2.14 0 .2-2.63 1.34-3.35 6.03.95 7.84-.46 1.4-1.25 2.89-2.26 4.4l-.07.08-.05-.2zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.17 2.22-1.8 4.19-3.74 4.25z" />
      </svg>
    );
  }

  return <Icon icon={User} size="xs" className="shrink-0" />;
}

function readableMethod(method: VaultMethod | null): string {
  if (method === "generated_default_native_biometric") return "Device biometric";
  if (method === "generated_default_native_passkey_prf") return "Passkey";
  if (method === "generated_default_web_prf") return "Passkey";
  if (method === "passphrase") return "Passphrase";
  return "Unknown";
}

function readableQuickMethod(method: VaultMethod | null): string {
  if (method === "generated_default_native_biometric") return "device biometric";
  if (method === "generated_default_native_passkey_prf") return "passkey";
  if (method === "generated_default_web_prf") return "passkey";
  return "quick unlock";
}

function formatMethodList(methods: VaultMethod[]): string {
  return methods.map((method) => readableMethod(method)).join(", ");
}

function tabForPanel(panel: ProfilePanel | null, fallback: ProfileTab): ProfileTab {
  if (panel === "support" || panel === "gmail") return "account";
  if (panel === "security" || panel === "consents") return "privacy";
  return fallback;
}

function ProfilePageContent() {
  const canShowPkmAgentLab = resolveAppEnvironment() !== "production";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();

  const { user, loading: authLoading, signOut } = useAuth();
  const { personaState, refresh: refreshPersonaState } = usePersonaState();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const pendingConsents = useConsentPendingSummaryCount();
  const { registerSteps, completeStep, reset } = useStepProgress();

  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
  const [vaultUnlockReason, setVaultUnlockReason] = useState<
    "profile_data" | "delete_account"
  >("profile_data");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AccountDeletionTarget>("both");
  const [isDeleting, setIsDeleting] = useState(false);
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [totalAttributes, setTotalAttributes] = useState(0);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [vaultMethod, setVaultMethod] = useState<VaultMethod | null>(null);
  const [capabilityMatrix, setCapabilityMatrix] =
    useState<VaultCapabilityMatrix | null>(null);
  const [enrolledVaultMethods, setEnrolledVaultMethods] = useState<VaultMethod[]>([]);
  const [availableQuickMethod, setAvailableQuickMethod] =
    useState<VaultMethod | null>(null);
  const [availableQuickWrapperId, setAvailableQuickWrapperId] = useState<string | null>(null);
  const [effectiveVaultMethod, setEffectiveVaultMethod] =
    useState<VaultMethod | null>(null);
  const [loadingVaultMethod, setLoadingVaultMethod] = useState(false);
  const [switchingVaultMethod, setSwitchingVaultMethod] = useState(false);
  const [passphraseDialogOpen, setPassphraseDialogOpen] = useState(false);
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showKaiPreferencesSheet, setShowKaiPreferencesSheet] = useState(false);
  const [marketplaceOptIn, setMarketplaceOptIn] = useState(false);
  const [loadingMarketplaceOptIn, setLoadingMarketplaceOptIn] = useState(true);
  const [savingMarketplaceOptIn, setSavingMarketplaceOptIn] = useState(false);
  const [supportDialogOpen, setSupportDialogOpen] = useState(false);
  const [supportKind, setSupportKind] =
    useState<SupportMessageKind>("support_request");
  const [supportSubject, setSupportSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [sendingSupportMessage, setSendingSupportMessage] = useState(false);
  const [gmailActionBusy, setGmailActionBusy] = useState<
    "connect" | "disconnect" | "sync" | null
  >(null);

  const requestedPanel = normalizeProfilePanel(searchParams.get("panel"));
  const requestedTab = normalizeProfileTab(searchParams.get("tab"));
  const activeTab = tabForPanel(requestedPanel, requestedTab);
  const activePanel = requestedPanel;

  const provider = getProvider(user);
  const gmailRouteHref = `${pathname}?${searchParamsString}`;
  const gmail = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: Boolean(user?.uid) && !authLoading,
    idTokenProvider: user?.getIdToken ? () => user.getIdToken() : null,
    routeHref: gmailRouteHref,
    refreshKey: gmailRouteHref,
  });
  const gmailActionsBusy = gmail.refreshingStatus || gmail.syncingRun || gmailActionBusy !== null;
  const personaList = personaState?.personas ?? ["investor"];
  const hasInvestorPersona = personaList.includes("investor");
  const hasRiaPersona = personaList.includes("ria");
  const hasDualPersona = hasInvestorPersona && hasRiaPersona;
  const effectiveDeleteTarget: AccountDeletionTarget = hasDualPersona ? deleteTarget : "both";
  const vaultAccess = useMemo(
    () =>
      resolveVaultAvailabilityState({
        hasVault,
        isVaultUnlocked,
        vaultKey,
        vaultOwnerToken,
      }),
    [hasVault, isVaultUnlocked, vaultKey, vaultOwnerToken]
  );
  const gmailPresentation = useMemo(
    () =>
      resolveGmailConnectionPresentation({
        status: gmail.status,
        loading: gmail.loadingStatus,
        action: gmailActionBusy,
        errorText: gmail.statusError,
      }),
    [gmail.loadingStatus, gmail.status, gmail.statusError, gmailActionBusy]
  );

  const updateProfileView = useMemo(
    () =>
      (next: { tab?: ProfileTab; panel?: ProfilePanel | null }) => {
        const params = new URLSearchParams(searchParamsString);
        const nextTab = next.tab ?? activeTab;
        params.set("tab", nextTab);

        if (typeof next.panel === "undefined") {
          if (!params.get("panel")) {
            params.delete("panel");
          }
        } else if (next.panel) {
          params.set("panel", next.panel);
        } else {
          params.delete("panel");
        }

        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      },
    [activeTab, pathname, router, searchParamsString]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadVaultState() {
      if (authLoading) return;
      if (!user?.uid) return;
      try {
        const next = await VaultService.checkVault(user.uid);
        if (!cancelled) setHasVault(next);
      } catch (error) {
        console.warn("[ProfilePage] Failed to check vault existence:", error);
        if (!cancelled) setHasVault(false);
      }
    }

    void loadVaultState();

    return () => {
      cancelled = true;
    };
  }, [authLoading, user?.uid]);

  async function refreshVaultMethodState(targetUserId: string) {
    try {
      setLoadingVaultMethod(true);
      const [capability, currentMethod, vaultState] = await Promise.all([
        VaultMethodService.getCapabilityMatrix(),
        VaultMethodService.getCurrentMethod(targetUserId),
        VaultService.getVaultState(targetUserId),
      ]);
      const nextEnrolledMethods = Array.from(
        new Set(vaultState.wrappers.map((wrapper) => wrapper.method))
      ) as VaultMethod[];
      const nextRecommendedMethod =
        capability.recommendedMethod !== "passphrase"
          ? capability.recommendedMethod
          : null;
      const quickWrapper =
        nextRecommendedMethod !== null
          ? VaultService.getWrapperByMethod(vaultState, nextRecommendedMethod)
          : null;
      const primaryPrefersQuickMethod =
        vaultState.primaryMethod === "generated_default_native_biometric" ||
        vaultState.primaryMethod === "generated_default_web_prf" ||
        vaultState.primaryMethod === "generated_default_native_passkey_prf";
      const primaryWrapper = VaultService.getPrimaryWrapper(vaultState);
      const nextEffectiveMethod =
        primaryPrefersQuickMethod && quickWrapper
          ? quickWrapper.method
          : primaryPrefersQuickMethod && !quickWrapper
            ? "passphrase"
            : primaryWrapper.method;

      setCapabilityMatrix(capability);
      setVaultMethod(currentMethod);
      setEnrolledVaultMethods(nextEnrolledMethods);
      setAvailableQuickMethod(quickWrapper?.method ?? null);
      setAvailableQuickWrapperId(quickWrapper?.wrapperId ?? null);
      setEffectiveVaultMethod(nextEffectiveMethod);
    } catch (error) {
      console.warn("[ProfilePage] Failed to resolve vault method:", error);
      setVaultMethod(null);
      setEnrolledVaultMethods([]);
      setAvailableQuickMethod(null);
      setAvailableQuickWrapperId(null);
      setEffectiveVaultMethod(null);
    } finally {
      setLoadingVaultMethod(false);
    }
  }

  useEffect(() => {
    if (authLoading || !user?.uid) return;
    if (hasVault !== true) {
      setVaultMethod(null);
      setEnrolledVaultMethods([]);
      setAvailableQuickMethod(null);
      setAvailableQuickWrapperId(null);
      setEffectiveVaultMethod(null);
      return;
    }

    void refreshVaultMethodState(user.uid);
  }, [authLoading, hasVault, user?.uid]);

  useEffect(() => {
    if (!user) {
      setMarketplaceOptIn(false);
      setLoadingMarketplaceOptIn(false);
      return;
    }
    if (!personaState) {
      setLoadingMarketplaceOptIn(true);
      return;
    }
    setMarketplaceOptIn(Boolean(personaState.investor_marketplace_opt_in));
    setLoadingMarketplaceOptIn(false);
  }, [personaState, user]);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      if (authLoading) return;

      if (!initialized) {
        registerSteps(1);
        setInitialized(true);
      }

      if (!user?.uid) return;
      if (hasVault === null) return;

      try {
        setLoadingDomains(true);

        if (hasVault !== true) {
          if (!cancelled) {
            setDomains([]);
            setTotalAttributes(0);
            completeStep();
          }
          return;
        }

        if (!vaultAccess.canReadSecureData || !vaultOwnerToken) {
          if (!cancelled) {
            setDomains([]);
            setTotalAttributes(0);
            completeStep();
          }
          return;
        }

        const metadata = await PersonalKnowledgeModelService.getMetadata(
          user.uid,
          false,
          vaultOwnerToken || undefined
        );
        if (!cancelled) {
          setDomains(metadata.domains);
          setTotalAttributes(metadata.totalAttributes);
          completeStep();
        }
      } catch (error) {
        console.error("Failed to load PKM data:", error);
        if (!cancelled) completeStep();
      } finally {
        if (!cancelled) setLoadingDomains(false);
      }
    }

    void loadData();

    return () => {
      cancelled = true;
      reset();
    };
  }, [
    authLoading,
    completeStep,
    hasVault,
    initialized,
    registerSteps,
    reset,
    user?.uid,
    vaultAccess.canReadSecureData,
    vaultOwnerToken,
  ]);

  const handleSignOut = async () => {
    try {
      await signOut();
      router.push(ROUTES.HOME);
    } catch (error) {
      console.error("Sign out error:", error);
    }
  };

  const handleDeleteAccount = async () => {
    if (!user) return;

    setIsDeleting(true);
    try {
      const resolution = await resolveDeleteAccountAuth({
        userId: user.uid,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });

      if (resolution.kind === "needs_unlock") {
        toast.error("Please unlock your vault first to delete your account.");
        setShowDeleteConfirm(false);
        setVaultUnlockReason("delete_account");
        setShowVaultUnlock(true);
        return;
      }

      setHasVault(resolution.hasVault);

      const result = await AccountService.deleteAccount(
        resolution.token,
        effectiveDeleteTarget
      );

      CacheSyncService.onAccountDeleted(user.uid);
      await UserLocalStateService.clearForUser(user.uid);

      if (result.account_deleted) {
        setOnboardingRequiredCookie(false);
        setOnboardingFlowActiveCookie(false);
        toast.success("Account deleted successfully. Redirecting...", {
          duration: 3000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await signOut();
        return;
      }

      CacheSyncService.onPersonaStateChanged(user.uid);
      CacheSyncService.onConsentMutated(user.uid);
      await refreshPersonaState({ force: true });

      const deletedTarget = result.deleted_target ?? effectiveDeleteTarget;
      toast.success(
        deletedTarget === "ria"
          ? "RIA workspace deleted. Your investor account is still active."
          : "Investor profile deleted. Your RIA workspace is still active."
      );

      if (result.remaining_personas?.includes("ria")) {
        router.push(ROUTES.RIA_HOME);
      } else {
        router.push(ROUTES.KAI_DASHBOARD);
      }
    } catch (error) {
      console.error("Delete account error:", error);
      toast.error("Failed to delete account. Please try again.");
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleDeleteClick = async () => {
    if (!user) return;
    setDeleteTarget("both");

    let nextHasVault = hasVault;
    if (nextHasVault === null) {
      try {
        nextHasVault = await VaultService.checkVault(user.uid);
        setHasVault(nextHasVault);
      } catch (error) {
        console.warn("[ProfilePage] Failed to check vault existence:", error);
        nextHasVault = true;
      }
    }

    if (!nextHasVault) {
      setShowDeleteConfirm(true);
      return;
    }

    if (vaultAccess.canMutateSecureData) {
      setShowDeleteConfirm(true);
    } else {
      requestVaultUnlock("delete_account");
    }
  };

  const handleMarketplaceOptInToggle = async () => {
    if (!user) return;
    try {
      setSavingMarketplaceOptIn(true);
      const idToken = await user.getIdToken();
      const result = await RiaService.setInvestorMarketplaceOptIn(
        idToken,
        !marketplaceOptIn
      );
      setMarketplaceOptIn(Boolean(result.investor_marketplace_opt_in));
      CacheSyncService.onMarketplaceVisibilityChanged(user.uid);
      await refreshPersonaState({ force: true });
      toast.success(
        result.investor_marketplace_opt_in
          ? "Investor marketplace profile is now discoverable."
          : "Investor marketplace profile is now hidden."
      );
    } catch (error) {
      console.error("[ProfilePage] Failed to update marketplace opt-in:", error);
      toast.error("Couldn't update marketplace visibility.");
    } finally {
      setSavingMarketplaceOptIn(false);
    }
  };

  function openSupportDialog(kind: SupportMessageKind) {
    setSupportKind(kind);
    setSupportSubject(SUPPORT_KIND_COPY[kind].subject);
    setSupportMessage("");
    setSupportDialogOpen(true);
  }

  function requestVaultUnlock(reason: "profile_data" | "delete_account" = "profile_data") {
    setVaultUnlockReason(reason);
    setShowVaultUnlock(true);
  }

  async function submitSupportMessage() {
    if (!user) return;
    const trimmedSubject = supportSubject.trim();
    const trimmedMessage = supportMessage.trim();

    if (trimmedSubject.length < 3) {
      toast.error("Add a short subject so we can triage this quickly.");
      return;
    }
    if (trimmedMessage.length < 10) {
      toast.error("Add a bit more detail so we can help properly.");
      return;
    }

    setSendingSupportMessage(true);
    try {
      const idToken = await user.getIdToken();
      const pageUrl =
        typeof window !== "undefined" ? window.location.href : ROUTES.PROFILE;
      const result = await SupportService.submitMessage({
        idToken,
        userId: user.uid,
        kind: supportKind,
        subject: trimmedSubject,
        message: trimmedMessage,
        userEmail: user.email,
        userDisplayName: user.displayName,
        persona: personaState?.active_persona || null,
        pageUrl,
      });
      toast.success(
        result.delivery_mode === "test"
          ? `Sent in test mode to ${result.recipient}.`
          : `Sent to ${result.recipient}.`
      );
      setSupportDialogOpen(false);
      setSupportMessage("");
    } catch (error) {
      console.error("[ProfilePage] Failed to send support message:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We couldn't send your message right now."
      );
    } finally {
      setSendingSupportMessage(false);
    }
  }

  async function handleConnectGmail() {
    if (!user?.uid) return;

    try {
      setGmailActionBusy("connect");

      const idToken = await user.getIdToken();
      const redirectUri =
        typeof window !== "undefined"
          ? `${window.location.origin}${ROUTES.PROFILE_GMAIL_OAUTH_RETURN}`
          : ROUTES.PROFILE_GMAIL_OAUTH_RETURN;
      const isGoogleProvider = provider.id === "google";

      const payload = await GmailReceiptsService.startConnect({
        idToken,
        userId: user.uid,
        redirectUri,
        loginHint: isGoogleProvider ? user.email : null,
        includeGrantedScopes: isGoogleProvider,
      });

      if (!payload.configured || !payload.authorize_url) {
        throw new Error("Gmail OAuth is not configured for this environment.");
      }
      assignWindowLocation(payload.authorize_url);
    } catch (error) {
      const message = sanitizeGmailUserMessage(error, {
        fallback: "We couldn't start Gmail connection right now. Please try again in a moment.",
      });
      console.error("[ProfilePage] Failed to start Gmail OAuth:", error);
      toast.error(message);
    } finally {
      setGmailActionBusy(null);
    }
  }

  async function handleDisconnectGmail() {
    if (!user?.uid) return;
    try {
      setGmailActionBusy("disconnect");
      const next = await gmail.disconnectGmail();
      if (!next) return;
      toast.success("Gmail disconnected. Your saved receipts will stay here.");
    } catch (error) {
      const message = sanitizeGmailUserMessage(error, {
        fallback: "We couldn't disconnect Gmail right now. Please try again in a moment.",
      });
      console.error("[ProfilePage] Failed to disconnect Gmail:", error);
      toast.error(message);
    } finally {
      setGmailActionBusy(null);
    }
  }

  async function handleSyncGmailNow() {
    if (!user?.uid) return;
    try {
      setGmailActionBusy("sync");
      const payload = await gmail.syncNow();
      if (!payload?.run?.run_id) {
        toast.message("We're already syncing your receipts.");
        return;
      }
      toast.message("Syncing your receipts now.");
    } catch (error) {
      const message = sanitizeGmailUserMessage(error, {
        fallback: "We couldn't sync your receipts. Please try again in a moment.",
        authFallback: "Reconnect Gmail to continue syncing your receipts.",
      });
      console.error("[ProfilePage] Failed to start Gmail sync:", error);
      toast.error(message);
    } finally {
      setGmailActionBusy(null);
    }
  }
  async function switchToQuickMethod(targetMethod: VaultMethod) {
    if (!user?.uid) return;

    if (!vaultAccess.canMutateSecureData || !vaultKey) {
      toast.info("Unlock your vault to change security method.");
      requestVaultUnlock("profile_data");
      return;
    }

    setSwitchingVaultMethod(true);
    try {
      const result = await VaultMethodService.switchMethod({
        userId: user.uid,
        currentVaultKey: vaultKey,
        displayName: user.displayName || user.email || "Hushh User",
        targetMethod,
      });

      setVaultMethod(result.method);
      toast.success(`Vault method updated to ${readableMethod(result.method)}.`);
      await refreshVaultMethodState(user.uid);
    } catch (error) {
      console.error("[ProfilePage] Failed to switch vault method:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We could not update your unlock preference."
      );
    } finally {
      setSwitchingVaultMethod(false);
    }
  }

  async function setQuickMethodAsDefault(
    targetMethod: VaultMethod,
    wrapperId?: string | null
  ) {
    if (!user?.uid) return;

    if (!vaultAccess.canMutateSecureData || !vaultKey) {
      toast.info("Unlock your vault to change security method.");
      requestVaultUnlock("profile_data");
      return;
    }

    setSwitchingVaultMethod(true);
    try {
      await VaultService.setPrimaryVaultMethod(
        user.uid,
        targetMethod,
        wrapperId ?? "default"
      );
      setVaultMethod(targetMethod);
      toast.success(`Primary unlock updated to ${readableMethod(targetMethod)}.`);
      await refreshVaultMethodState(user.uid);
    } catch (error) {
      console.error("[ProfilePage] Failed to set quick unlock as default:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We could not update your preferred unlock method."
      );
    } finally {
      setSwitchingVaultMethod(false);
    }
  }

  async function preferPassphraseUnlock() {
    if (!user?.uid) return;

    if (!vaultAccess.canMutateSecureData || !vaultKey) {
      toast.info("Unlock your vault to change security method.");
      requestVaultUnlock("profile_data");
      return;
    }

    setSwitchingVaultMethod(true);
    try {
      await VaultService.setPrimaryVaultMethod(user.uid, "passphrase", "default");
      setVaultMethod("passphrase");
      toast.success("Primary unlock updated to passphrase.");
      await refreshVaultMethodState(user.uid);
    } catch (error) {
      console.error("[ProfilePage] Failed to prefer passphrase unlock:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We could not update your preferred unlock method."
      );
    } finally {
      setSwitchingVaultMethod(false);
    }
  }

  async function changePassphrase() {
    if (!user?.uid) return;

    if (!vaultAccess.canMutateSecureData || !vaultKey) {
      toast.info("Unlock your vault to change passphrase.");
      requestVaultUnlock("profile_data");
      return;
    }

    setSwitchingVaultMethod(true);
    try {
      const result = await VaultMethodService.changePassphrase({
        userId: user.uid,
        currentVaultKey: vaultKey,
        newPassphrase,
        keepPrimaryMethod: true,
      });
      setVaultMethod(result.primaryMethod);
      toast.success("Passphrase updated successfully.");
      await refreshVaultMethodState(user.uid);
      setPassphraseDialogOpen(false);
      setNewPassphrase("");
      setConfirmPassphrase("");
    } catch (error) {
      console.error("[ProfilePage] Failed to update passphrase:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We could not update your passphrase."
      );
    } finally {
      setSwitchingVaultMethod(false);
    }
  }

  const deleteButtonLabel =
    vaultAccess.needsUnlock
      ? hasDualPersona
        ? "Unlock to manage deletion"
        : "Unlock to delete account"
      : hasDualPersona
        ? "Delete account or persona"
        : "Delete account";
  const deleteRowDescription = hasDualPersona
    ? "Choose whether to remove Investor, RIA, or the full account."
    : "This action cannot be undone.";
  const deleteDialogTitle = hasDualPersona
    ? "Delete Investor, RIA, or everything?"
    : "Delete Account?";
  const deleteDialogDescription =
    effectiveDeleteTarget === "investor"
      ? "This removes Kai profile data, portfolio imports, investor marketplace visibility, and advisor relationships. Your RIA workspace stays."
      : effectiveDeleteTarget === "ria"
        ? "This removes your advisor profile, client requests, picks uploads, and RIA marketplace presence. Your investor account stays."
        : "This action cannot be undone. This permanently deletes your account, both personas, and encrypted vault records.";

  const unlockDialogTitle =
    vaultUnlockReason === "delete_account"
      ? "Unlock Vault to Delete Account"
      : "Unlock Vault";
  const unlockDialogDescription =
    vaultUnlockReason === "delete_account"
      ? "Unlock your vault to confirm deletion. This is permanent and removes all encrypted records."
      : "Unlock your vault to access profile settings.";

  const displayedUnlockMethod = effectiveVaultMethod ?? vaultMethod;
  const unlockMethodDiffersFromStoredDefault =
    Boolean(vaultMethod && effectiveVaultMethod && vaultMethod !== effectiveVaultMethod);
  const recommendedQuickMethod =
    capabilityMatrix?.recommendedMethod &&
    capabilityMatrix.recommendedMethod !== "passphrase"
      ? capabilityMatrix.recommendedMethod
      : null;
  const quickMethodReadyOnCurrentDevice =
    vaultMethod === "passphrase" && availableQuickMethod
      ? availableQuickMethod
      : null;
  const canEditKaiPreferences = Boolean(
    user?.uid && vaultAccess.hasVault && vaultAccess.canMutateSecureData
  );

  const kaiProfileDescription =
    loadingDomains
      ? "Loading your personalized signals."
      : vaultAccess.needsVaultCreation
        ? "Create your vault from import to start building your profile."
        : vaultAccess.needsUnlock
          ? "Open your Kai workspace now, then unlock whenever you want to reveal saved signals."
          : totalAttributes > 0
            ? `${totalAttributes} signal${totalAttributes === 1 ? "" : "s"} across ${domains.length} domain${domains.length === 1 ? "" : "s"}.`
            : "Nothing here yet. Chat with Kai or import a portfolio to personalize your profile.";

  const kaiPreferencesDescription =
    vaultAccess.needsVaultCreation
      ? "Create your vault first so Kai preferences can be saved securely."
      : vaultAccess.canMutateSecureData
        ? "Adjust risk profile and horizon settings used throughout Kai."
        : "Basic shell preferences stay available here. Unlock only when you want to edit encrypted Kai preferences.";

  const marketplaceStatusText =
    loadingMarketplaceOptIn
      ? "Checking visibility…"
      : marketplaceOptIn
        ? "Discoverable to RIAs"
        : "Hidden from marketplace search";

  const securitySummaryText =
    vaultAccess.needsVaultCreation
      ? "Vault not created yet"
      : loadingVaultMethod
        ? "Loading methods…"
        : vaultAccess.needsUnlock
          ? "Locked"
        : readableMethod(displayedUnlockMethod);

  const gmailStatusLabel = gmailPresentation.badgeLabel;
  const gmailStatusSummary = useMemo(
    () =>
      resolveGmailStatusSummary({
        status: gmail.status,
        loading: gmail.loadingStatus || gmailActionBusy === "sync",
        errorText: gmail.statusError,
      }),
    [gmail.loadingStatus, gmail.status, gmail.statusError, gmailActionBusy]
  );
  const gmailLastSyncText = gmailPresentation.latestSyncText;
  const gmailSettingsDescription = gmailPresentation.description;
  const gmailPrimaryActionLabel = gmailPresentation.isConnected
    ? gmailActionsBusy
      ? "Syncing receipts…"
      : "Sync receipts"
    : gmailPresentation.state === "needs_reauthentication"
      ? gmailActionBusy === "connect"
        ? "Reconnecting…"
        : "Reconnect Gmail"
      : gmailActionBusy === "connect"
        ? "Connecting…"
        : "Connect Gmail";
  const gmailStatusToneClassName =
    gmailStatusSummary.tone === "success"
      ? "border-emerald-500/18 bg-emerald-500/[0.05]"
      : gmailStatusSummary.tone === "error"
        ? "border-rose-500/22 bg-rose-500/[0.06]"
        : gmailStatusSummary.tone === "loading"
          ? "border-sky-500/18 bg-sky-500/[0.05]"
          : "border-border/60 bg-background/68";
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();
  const profileVoiceSurfaceMetadata = useMemo(() => {
    const visibleModules =
      activeTab === "account"
        ? ["Kai profile", "Support & feedback", "Gmail receipts", "Session", "Danger zone"]
        : activeTab === "preferences"
          ? ["Appearance", "Kai preferences", "On-device first"]
          : ["Consent center", "Marketplace visibility", "Vault security"];

    if (canShowPkmAgentLab && activeTab === "account") {
      visibleModules.splice(2, 0, "PKM Agent Lab");
    }
    if (activePanel === "support") {
      visibleModules.push("Support panel");
    }
    if (activePanel === "gmail") {
      visibleModules.push("Gmail connector panel");
    }
    if (activePanel === "security") {
      visibleModules.push("Vault security panel");
    }

    const availableActions =
      activePanel === "gmail"
        ? [
            gmailPresentation.isConnected
              ? "Sync Gmail receipts"
              : gmailPresentation.state === "needs_reauthentication"
                ? "Reconnect Gmail"
                : "Connect Gmail",
            "View receipts",
            ...(gmailPresentation.isConnected ? ["Disconnect Gmail"] : []),
          ]
        : activePanel === "support"
          ? ["Report a bug", "Contact support", "Reach the developer"]
          : activePanel === "security"
            ? [
                vaultAccess.needsVaultCreation ? "Create your vault" : "Unlock vault",
                "Change passphrase",
                "Prefer passphrase unlock",
              ]
            : activeTab === "privacy"
              ? ["Open consent center", "Open vault security"]
              : [
                  "Open Gmail",
                  "Open receipts",
                  "Open support",
                  ...(canShowPkmAgentLab ? ["Open PKM Agent Lab"] : []),
                ];
    const profileScreenId =
      activePanel === "gmail"
        ? "profile_gmail_panel"
        : activePanel === "support"
          ? "profile_support_panel"
          : activePanel === "security"
            ? "profile_security_panel"
            : activeTab === "preferences"
              ? "profile_preferences"
              : activeTab === "privacy"
                ? "profile_privacy"
                : "profile_account";
    const profileTitle =
      activePanel === "gmail"
        ? "Gmail connector"
        : activePanel === "support"
          ? "Support"
          : activePanel === "security"
            ? "Vault security"
            : "Profile";
    const profilePurpose =
      activePanel === "gmail"
        ? "This panel manages Gmail connection state and receipt sync readiness."
        : activePanel === "support"
          ? "This panel handles bug reports, support requests, and product feedback."
          : activePanel === "security"
            ? "This panel manages vault access and security settings."
            : activeTab === "privacy"
              ? "This page manages consent, privacy, and vault-related controls."
              : activeTab === "preferences"
                ? "This page manages product preferences and profile defaults."
                : "This page gives you account settings, Gmail receipts access, support, and PKM access.";
    const controls = [
      ...(canShowPkmAgentLab
        ? [
            {
              id: "pkm_agent_lab",
              label: "PKM Agent Lab",
              purpose: "opens the workspace for previewing and saving encrypted PKM captures.",
              actionId: "nav.profile_pkm_agent_lab",
              role: "card",
              voiceAliases: ["pkm agent lab", "memory lab"],
            },
          ]
        : []),
      {
        id: "gmail_receipts",
        label: "Gmail receipts",
        purpose: "opens Gmail receipt sync and receipt-memory import.",
        actionId: "nav.profile_receipts",
        role: "card",
        voiceAliases: ["gmail receipts", "receipts"],
      },
      {
        id: "support_feedback",
        label: "Support & feedback",
        purpose: "opens direct support and product feedback tools.",
        actionId: "nav.profile_support_panel",
        role: "card",
        voiceAliases: ["support", "feedback"],
      },
      {
        id: "sign_out",
        label: "Sign out",
        purpose: "ends this session on the current device.",
        role: "button",
        voiceAliases: ["sign out", "log out"],
      },
      {
        id: "delete_account",
        label: "Delete account",
        purpose: "permanently deletes your account and vault-linked records.",
        role: "button",
        voiceAliases: ["delete account", "remove account"],
      },
    ];
    const surfaceDefinition = {
      screenId: profileScreenId,
      title: profileTitle,
      purpose: profilePurpose,
      sections: [
        {
          id: "account",
          title: "Account",
          purpose: "This section covers your signed-in account and profile-level entry points.",
        },
        {
          id: "preferences",
          title: "Preferences",
          purpose: "This section manages personal preferences and profile defaults.",
        },
        {
          id: "privacy",
          title: "Privacy",
          purpose: "This section manages vault, privacy, and consent-related settings.",
        },
      ],
      actions: availableActions.map((action) => ({
        id: action.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        label: action,
        purpose: `${action} from Profile.`,
      })),
      controls,
      concepts: [
        {
          id: "pkm",
          label: "PKM",
          explanation:
            "PKM is your encrypted personal memory layer. Kai uses it to store durable user memory safely.",
          aliases: ["pkm", "personal knowledge model"],
        },
        {
          id: "gmail_receipts",
          label: "Gmail receipts",
          explanation:
            "Gmail receipts connects Gmail receipt sync and feeds receipt-memory imports into PKM.",
          aliases: ["gmail receipts", "receipt sync"],
        },
      ],
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
    };
    const activeControl =
      controls.find((control) => control.id === activeVoiceControlId) ||
      controls.find((control) => control.id === lastVoiceControlId) ||
      null;

    return {
      surfaceDefinition,
      activeSection:
        activePanel === "gmail"
          ? "Gmail connector"
          : activePanel === "support"
            ? "Support"
            : activePanel === "security"
              ? "Vault security"
              : activeTab === "account"
                ? "Account"
                : activeTab === "preferences"
                  ? "Preferences"
                  : "Privacy",
      activeTab: activeTab,
      visibleModules,
      focusedWidget:
        activeControl?.label ||
        (activePanel === "gmail"
          ? "Gmail connector panel"
          : activePanel === "support"
            ? "Support panel"
            : activePanel === "security"
              ? "Vault security panel"
              : `${activeTab} settings`),
      modalState:
        supportDialogOpen
          ? "support_dialog"
          : passphraseDialogOpen
            ? "passphrase_dialog"
            : showVaultUnlock
              ? "vault_unlock"
              : activePanel
                ? `${activePanel}_panel`
                : null,
      availableActions,
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
      busyOperations: [
        ...(gmailActionsBusy ? ["gmail_action"] : []),
        ...(sendingSupportMessage ? ["support_message"] : []),
        ...(switchingVaultMethod ? ["vault_method_update"] : []),
        ...(savingMarketplaceOptIn ? ["marketplace_visibility_update"] : []),
      ],
      screenMetadata: {
        profile_tab: activeTab,
        profile_panel: activePanel,
        total_attributes: totalAttributes,
        domain_count: domains.length,
        pending_consents: pendingConsents,
        gmail_connected: gmailPresentation.isConnected,
        gmail_state: gmailPresentation.state,
        gmail_status_label: gmailStatusLabel,
        gmail_last_sync_text: gmailLastSyncText,
        google_email: gmail.status?.google_email || null,
        pkm_agent_lab_available: canShowPkmAgentLab,
        marketplace_opt_in: marketplaceOptIn,
        security_summary: securitySummaryText,
      },
    };
  }, [
    activePanel,
    activeTab,
    activeVoiceControlId,
    canShowPkmAgentLab,
    domains.length,
    gmailActionsBusy,
    gmailPresentation.isConnected,
    gmailPresentation.state,
    gmailLastSyncText,
    gmailStatusLabel,
    gmail.status?.google_email,
    marketplaceOptIn,
    lastVoiceControlId,
    passphraseDialogOpen,
    pendingConsents,
    savingMarketplaceOptIn,
    securitySummaryText,
    sendingSupportMessage,
    showVaultUnlock,
    supportDialogOpen,
    switchingVaultMethod,
    totalAttributes,
    vaultAccess.needsVaultCreation,
  ]);
  usePublishVoiceSurfaceMetadata(profileVoiceSurfaceMetadata);

  if (authLoading || !user) {
    return null;
  }

  const openKaiProfile = () => {
    if (vaultAccess.needsVaultCreation) {
      router.push(ROUTES.KAI_IMPORT);
      return;
    }
    router.push(ROUTES.KAI_DASHBOARD);
  };

  const openKaiPreferences = () => {
    if (vaultAccess.needsVaultCreation) {
      router.push(ROUTES.KAI_IMPORT);
      return;
    }
    if (!vaultAccess.canMutateSecureData) {
      requestVaultUnlock("profile_data");
      return;
    }
    setShowKaiPreferencesSheet(true);
  };

  const closeDetailPanel = () => updateProfileView({ panel: null });

  const supportActions: Array<{
    kind: SupportMessageKind;
    icon: LucideIcon;
    label: string;
    description: string;
  }> = [
    {
      kind: "bug_report",
      icon: Bug,
      label: "Report bug",
      description: "Broken flow, confusing UI, or something off in the product.",
    },
    {
      kind: "support_request",
      icon: LifeBuoy,
      label: "Get support",
      description: "Need help with onboarding, portfolio data, or account setup.",
    },
    {
      kind: "developer_reachout",
      icon: Code2,
      label: "Reach developer",
      description: "Direct product or engineering feedback routed through support.",
    },
  ];

  return (
    <AppPageShell
      data-testid="profile-primary"
      as="div"
      width="reading"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/profile",
        marker: "native-route-profile",
        authState: user ? "authenticated" : "pending",
        dataState: authLoading ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <header className="flex flex-col items-center gap-3 text-center" data-slot="page-header" data-page-primary="true">
          <Avatar className="h-16 w-16 shrink-0 ring-4 ring-primary/18 sm:h-20 sm:w-20">
            <AvatarImage
              src={user.photoURL || undefined}
              alt={user.displayName || "Profile"}
            />
            <AvatarFallback className="bg-muted text-lg font-semibold text-muted-foreground sm:text-xl">
              {user.displayName ? (
                user.displayName
                  .split(" ")
                  .map((part) => part[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()
              ) : (
                <Icon icon={User} size={48} />
              )}
            </AvatarFallback>
          </Avatar>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {user.displayName || "User"}
            </h1>
            <div
              className="inline-flex items-center gap-2 text-sm text-muted-foreground"
              title={provider.name}
            >
              <ProviderIcon providerId={provider.id} />
              <span className="[overflow-wrap:anywhere]">
                {user.email || "Not available"}
              </span>
            </div>
          </div>
        </header>
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <SettingsSegmentedTabs
            value={activeTab}
            onValueChange={(next) =>
              updateProfileView({
                tab: normalizeProfileTab(next),
                panel: null,
              })
            }
            options={[
              { value: "account", label: "Account" },
              { value: "preferences", label: "Preferences" },
              { value: "privacy", label: "Privacy" },
            ]}
          />

          {activeTab === "account" ? (
            <div className="space-y-4 sm:space-y-5">
            <SettingsGroup
              eyebrow="Profile"
              description="Your signed-in account, Kai profile summary, and direct support access."
            >
              <SettingsRow
                icon={Folder}
                title="Kai profile"
                description={kaiProfileDescription}
                trailing={
                  !loadingDomains && totalAttributes > 0 ? (
                    <Badge variant="secondary">{totalAttributes} signals</Badge>
                  ) : loadingDomains ? (
                    <Badge variant="secondary">Loading</Badge>
                  ) : null
                }
                chevron
                stackTrailingOnMobile
                onClick={openKaiProfile}
              />
              <SettingsRow
                icon={LifeBuoy}
                title="Support & feedback"
                description="Bug reports, support, and direct product feedback."
                chevron
                voiceControlId="support_feedback"
                voiceActionId="nav.profile_support_panel"
                voicePurpose="opens direct support and product feedback tools."
                onClick={() => updateProfileView({ tab: "account", panel: "support" })}
              />
              {canShowPkmAgentLab ? (
                <SettingsRow
                  icon={Code2}
                  title="PKM Agent Lab"
                  description="Capture intent, inspect saved PKM data, and review how live encrypted storage is organized for your account."
                  chevron
                  voiceControlId="pkm_agent_lab"
                  voiceActionId="nav.profile_pkm_agent_lab"
                  voicePurpose="opens the workspace for previewing and saving encrypted PKM captures."
                  onClick={() => router.push("/profile/pkm-agent-lab")}
                />
              ) : null}
              <SettingsRow
                icon={Mail}
                title="Gmail receipts"
                description={gmailSettingsDescription}
                trailing={<Badge variant="secondary">{gmailStatusLabel}</Badge>}
                chevron
                stackTrailingOnMobile
                voiceControlId="gmail_receipts"
                voiceActionId="nav.profile_receipts"
                voicePurpose="opens Gmail receipt sync and receipt-memory import."
                onClick={() => updateProfileView({ tab: "account", panel: "gmail" })}
              />
            </SettingsGroup>

            <SettingsGroup eyebrow="Session">
              <SettingsRow
                icon={LogOut}
                title="Sign out"
                description="End this session on the current device."
                voiceControlId="sign_out"
                voicePurpose="ends this session on the current device."
                onClick={() => void handleSignOut()}
                chevron
              />
            </SettingsGroup>

            <SettingsGroup
              eyebrow="Danger zone"
              description="Deleting your account is permanent. All vault records and identity details will be erased."
            >
              <SettingsRow
                icon={Trash2}
                title={deleteButtonLabel}
                description={deleteRowDescription}
                tone="destructive"
                voiceControlId="delete_account"
                voicePurpose="permanently deletes your account and vault-linked records."
                onClick={() => void handleDeleteClick()}
                chevron
              />
            </SettingsGroup>
            </div>
          ) : null}

          {activeTab === "preferences" ? (
            <div className="space-y-4 sm:space-y-5">
            <SettingsGroup
              eyebrow="Preferences"
              description="Personalize the shell, your Kai preferences, and device sync behavior."
            >
              <SettingsRow
                icon={Monitor}
                title="Appearance"
                description="Choose light, dark, or system mode for the signed-in shell."
                trailing={<ThemeToggle className="w-full min-w-0 sm:w-[228px]" />}
                stackTrailingOnMobile
              />
              <SettingsRow
                icon={RefreshCw}
                title="Kai preferences"
                description={kaiPreferencesDescription}
                trailing={
                  canEditKaiPreferences ? (
                    <Badge variant="secondary">Ready</Badge>
                  ) : null
                }
                chevron
                stackTrailingOnMobile
                onClick={openKaiPreferences}
              />
              <SettingsRow
                icon={Cloud}
                title="On-device first"
                description="BYOK for cloud models."
                trailing={<Badge variant="secondary">Coming soon</Badge>}
                stackTrailingOnMobile
              />
            </SettingsGroup>
            </div>
          ) : null}

          {activeTab === "privacy" ? (
            <div className="space-y-4 sm:space-y-5">
            <SettingsGroup
              eyebrow="Privacy"
              description="Consent access, investor marketplace visibility, and vault security."
            >
              <SettingsRow
                icon={MessageSquare}
                title="Consent center"
                description={
                  pendingConsents > 0
                    ? `${pendingConsents} request${pendingConsents === 1 ? "" : "s"} waiting for review.`
                    : "Review current access and approve new requests."
                }
                trailing={
                  pendingConsents > 0 ? (
                    <Badge variant="secondary">{pendingConsents}</Badge>
                  ) : null
                }
                chevron
                stackTrailingOnMobile
                onClick={() => router.push(ROUTES.CONSENTS)}
              />
              <SettingsRow
                icon={RefreshCw}
                title="Marketplace visibility"
                description={marketplaceStatusText}
                trailing={
                  <Switch
                    checked={marketplaceOptIn}
                    disabled={loadingMarketplaceOptIn || savingMarketplaceOptIn}
                    aria-label="Toggle marketplace visibility"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={() => void handleMarketplaceOptInToggle()}
                  >
                  </Switch>
                }
              />
              <SettingsRow
                icon={Fingerprint}
                title="Vault security"
                description="Review passphrase, passkey, and current unlock behavior for this device."
                trailing={
                  <Badge variant="secondary" className="max-w-full">
                    {securitySummaryText}
                  </Badge>
                }
                chevron
                stackTrailingOnMobile
                onClick={() => updateProfileView({ tab: "privacy", panel: "security" })}
              />
            </SettingsGroup>
            </div>
          ) : null}
          <p className="text-center text-xs leading-5 text-muted-foreground">
          Your records are protected before storage, and only your Vault credentials can unlock them.
          </p>
        </SurfaceStack>
      </AppPageContentRegion>

      <SettingsDetailPanel
        open={activePanel === "support"}
        onOpenChange={(open) => {
          if (!open) closeDetailPanel();
        }}
        title="Support & feedback"
        description="Use support@hushh.ai for bugs, account help, or direct developer feedback."
      >
        <div className="space-y-4 sm:space-y-5">
          <SettingsGroup eyebrow="Contact">
            {supportActions.map((action) => (
              <SettingsRow
                key={action.kind}
                icon={action.icon}
                title={action.label}
                description={action.description}
                chevron
                onClick={() => openSupportDialog(action.kind)}
              />
            ))}
          </SettingsGroup>

          <SettingsGroup eyebrow="Routing">
            <SettingsRow
              icon={MessageSquare}
              title="Support inbox"
              description="Messages are routed through support@hushh.ai."
            />
            {user.email ? (
              <SettingsRow
                icon={SendHorizontal}
                title="Reply address"
                description={user.email}
              />
            ) : null}
          </SettingsGroup>
        </div>
      </SettingsDetailPanel>

      <SettingsDetailPanel
        open={activePanel === "gmail"}
        onOpenChange={(open) => {
          if (!open) closeDetailPanel();
        }}
        title="Gmail receipts connector"
        description="Connect your Gmail account to sync receipt emails into a dedicated receipts view."
      >
        <div className="space-y-4 sm:space-y-5">
          <SurfaceInset
            className={`space-y-3 border px-4 py-4 sm:px-5 sm:py-5 ${gmailStatusToneClassName}`}
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Status
                </p>
                <Badge variant="secondary">{gmailStatusLabel}</Badge>
              </div>
              <h3 className="text-base font-semibold tracking-tight text-foreground">
                {gmailStatusSummary.title}
              </h3>
              <p className="text-sm text-muted-foreground">{gmailStatusSummary.detail}</p>
              {gmailStatusSummary.helper ? (
                <p className="text-xs text-muted-foreground">{gmailStatusSummary.helper}</p>
              ) : null}
            </div>
          </SurfaceInset>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                gmailPresentation.isConnected
                  ? void handleSyncGmailNow()
                  : void handleConnectGmail()
              }
              disabled={
                gmailActionsBusy ||
                (!gmailPresentation.isConnected && gmail.status?.configured === false)
              }
              className="min-w-[156px]"
              data-voice-control-id="profile_gmail_primary_action"
              data-voice-action-id={
                gmailPresentation.isConnected ? "profile.gmail.sync_now" : "profile.gmail.connect"
              }
              data-voice-label={gmailPrimaryActionLabel}
              data-voice-purpose={
                gmailPresentation.isConnected
                  ? "starts Gmail receipt sync."
                  : "connects Gmail for receipt syncing."
              }
            >
              {gmailActionsBusy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : gmailPresentation.isConnected ? (
                <RefreshCw className="mr-2 h-4 w-4" />
              ) : (
                <Mail className="mr-2 h-4 w-4" />
              )}
              {gmailPrimaryActionLabel}
            </Button>

            <Button
              variant="none"
              effect="fade"
              onClick={() => router.push(ROUTES.PROFILE_RECEIPTS)}
              data-voice-control-id="view_gmail_receipts"
              data-voice-action-id="nav.profile_receipts"
              data-voice-label="View receipts"
              data-voice-purpose="opens the receipts view."
            >
              View receipts
            </Button>

            {gmailPresentation.isConnected ? (
              <Button
                variant="destructive"
                onClick={() => void handleDisconnectGmail()}
                disabled={gmailActionsBusy}
                data-voice-control-id="disconnect_gmail"
                data-voice-action-id="profile.gmail.disconnect"
                data-voice-label="Disconnect Gmail"
                data-voice-purpose="stops future Gmail receipt sync."
              >
                Disconnect Gmail
              </Button>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">
            We only use Gmail to find receipt emails and keep them together in one place.
          </p>
        </div>
      </SettingsDetailPanel>

      <SettingsDetailPanel
        open={activePanel === "security"}
        onOpenChange={(open) => {
          if (!open) closeDetailPanel();
        }}
        title="Vault security"
        description="Manage passphrase, passkey, and current unlock behavior without changing how your vault stays protected."
      >
        <div className="space-y-4 sm:space-y-5">
          {vaultAccess.needsVaultCreation ? (
            <SettingsGroup eyebrow="Vault required">
              <SettingsRow
                icon={Folder}
                title="Create your vault"
                description="Start from import to enable passphrase or passkey unlock for this account."
                chevron
                onClick={() => {
                  closeDetailPanel();
                  router.push(ROUTES.KAI_IMPORT);
                }}
              />
            </SettingsGroup>
          ) : null}

          {vaultAccess.hasVault && loadingVaultMethod ? (
            <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <Icon icon={Loader2} size="sm" className="animate-spin" />
              Loading vault methods...
            </SurfaceInset>
          ) : null}

          {vaultAccess.hasVault && !loadingVaultMethod ? (
            <>
              <SettingsGroup eyebrow="Current state">
                <SettingsRow
                  icon={Fingerprint}
                  title="Unlock here"
                  description={
                    unlockMethodDiffersFromStoredDefault
                      ? `This device or domain is using ${readableMethod(displayedUnlockMethod)} right now.`
                      : "This is the unlock method available in your current environment."
                  }
                  trailing={
                    <Badge variant="secondary">
                      {displayedUnlockMethod === "passphrase"
                        ? "Passphrase unlock"
                        : "Quick unlock"}
                    </Badge>
                  }
                  stackTrailingOnMobile
                />
                {vaultMethod ? (
                  <SettingsRow
                    icon={KeyRound}
                    title="Stored default"
                    description="Primary vault preference stored with your account."
                    trailing={<Badge variant="secondary">{readableMethod(vaultMethod)}</Badge>}
                    stackTrailingOnMobile
                  />
                ) : null}
                <SettingsRow
                  icon={Monitor}
                  title="Enrolled methods"
                  description={
                    enrolledVaultMethods.length > 0
                      ? formatMethodList(enrolledVaultMethods)
                      : "No quick unlock methods enrolled yet."
                  }
                />
              </SettingsGroup>

              {vaultMethod === "passphrase" && availableQuickMethod ? (
                <SurfaceInset className="px-3.5 py-3.5 text-sm leading-6 text-muted-foreground sm:px-4 sm:py-4">
                  {readableMethod(availableQuickMethod)} is already enrolled on this
                  device or domain. It is not the default unlock yet.
                </SurfaceInset>
              ) : null}

              <SettingsGroup eyebrow="Actions">
                {!vaultAccess.canMutateSecureData ? (
                  <SettingsRow
                    icon={KeyRound}
                    title="Unlock vault"
                    description="Unlock your vault to change methods or update your passphrase."
                    chevron
                    onClick={() => requestVaultUnlock("profile_data")}
                  />
                ) : null}

                {vaultMethod === "passphrase" && recommendedQuickMethod ? (
                  <SettingsRow
                    icon={KeyRound}
                    title={
                      quickMethodReadyOnCurrentDevice
                        ? `Use ${readableQuickMethod(quickMethodReadyOnCurrentDevice)} by default`
                        : `Enable ${readableQuickMethod(recommendedQuickMethod)}`
                    }
                    description={
                      quickMethodReadyOnCurrentDevice
                        ? "Switch your primary unlock to the quick method already enrolled here."
                        : "Enroll and switch to the recommended quick unlock method."
                    }
                    disabled={switchingVaultMethod}
                    chevron
                    onClick={() =>
                      quickMethodReadyOnCurrentDevice
                        ? void setQuickMethodAsDefault(
                            quickMethodReadyOnCurrentDevice,
                            availableQuickWrapperId
                          )
                        : void switchToQuickMethod(recommendedQuickMethod)
                    }
                  />
                ) : null}

                {vaultMethod && vaultMethod !== "passphrase" ? (
                  <SettingsRow
                    icon={RefreshCw}
                    title="Prefer passphrase unlock"
                    description="Make passphrase the stored default again."
                    disabled={switchingVaultMethod}
                    chevron
                    onClick={() => void preferPassphraseUnlock()}
                  />
                ) : null}

                {vaultMethod ? (
                  <SettingsRow
                    icon={RefreshCw}
                    title="Change passphrase"
                    description="Update the passphrase that protects your vault."
                    disabled={switchingVaultMethod}
                    chevron
                    onClick={() => setPassphraseDialogOpen(true)}
                  />
                ) : null}
              </SettingsGroup>
            </>
          ) : null}
        </div>
      </SettingsDetailPanel>

      {hasVault === true && (
        <VaultUnlockDialog
          user={user}
          open={showVaultUnlock}
          onOpenChange={setShowVaultUnlock}
          title={unlockDialogTitle}
          description={unlockDialogDescription}
          onSuccess={() => {
            setShowVaultUnlock(false);
            if (vaultUnlockReason === "delete_account") {
              setTimeout(() => setShowDeleteConfirm(true), 300);
              return;
            }
            toast.success("Vault unlocked.");
          }}
        />
      )}

      <Dialog open={passphraseDialogOpen} onOpenChange={setPassphraseDialogOpen}>
        <DialogContent className="w-[calc(100%-1rem)] max-h-[calc(100svh-1rem)] overflow-y-auto sm:max-w-md">
          <DialogTitle>Change passphrase</DialogTitle>
          <DialogDescription>
            Set a new passphrase for Vault unlock. Your passkey and biometric methods stay active.
          </DialogDescription>
          <div className="space-y-3 pt-2">
            <Input
              type="password"
              placeholder="New passphrase (min 8 characters)"
              value={newPassphrase}
              onChange={(event) => setNewPassphrase(event.target.value)}
            />
            <Input
              type="password"
              placeholder="Confirm passphrase"
              value={confirmPassphrase}
              onChange={(event) => setConfirmPassphrase(event.target.value)}
            />
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
              <Button
                variant="none"
                effect="fade"
                size="default"
                className="w-full sm:w-auto"
                onClick={() => setPassphraseDialogOpen(false)}
                disabled={switchingVaultMethod}
              >
                Cancel
              </Button>
              <Button
                size="default"
                className="w-full sm:w-auto"
                disabled={
                  switchingVaultMethod ||
                  newPassphrase.length < 8 ||
                  newPassphrase !== confirmPassphrase
                }
                onClick={() => void changePassphrase()}
              >
                {switchingVaultMethod ? "Saving..." : "Save new passphrase"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={supportDialogOpen} onOpenChange={setSupportDialogOpen}>
        <DialogContent className="w-[calc(100%-1rem)] max-h-[calc(100svh-1rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{SUPPORT_KIND_COPY[supportKind].title}</DialogTitle>
            <DialogDescription>
              {SUPPORT_KIND_COPY[supportKind].description}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl bg-muted/35 p-3 text-xs text-muted-foreground">
              Routed through <span className="font-medium text-foreground">support@hushh.ai</span>
              {user.email ? (
                <>
                  {" "}
                  with replies pointing back to{" "}
                  <span className="font-medium text-foreground">{user.email}</span>.
                </>
              ) : (
                "."
              )}
            </div>
            <Input
              value={supportSubject}
              onChange={(event) => setSupportSubject(event.target.value)}
              placeholder="Subject"
              maxLength={140}
            />
            <Textarea
              value={supportMessage}
              onChange={(event) => setSupportMessage(event.target.value)}
              placeholder="What happened, what you expected, and anything else we should know"
              className="min-h-[160px]"
              maxLength={8000}
            />
          </div>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="none"
              effect="fade"
              size="default"
              className="w-full sm:w-auto"
              onClick={() => setSupportDialogOpen(false)}
              disabled={sendingSupportMessage}
            >
              Cancel
            </Button>
            <Button
              size="default"
              className="w-full sm:w-auto"
              onClick={() => void submitSupportMessage()}
              disabled={sendingSupportMessage}
            >
              {sendingSupportMessage ? (
                <>
                  <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Icon icon={SendHorizontal} size="sm" className="mr-2" />
                  Send message
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent className="w-[calc(100%-1rem)] sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="app-critical-title flex items-center gap-2">
              <Icon icon={AlertTriangle} size="md" />
              {deleteDialogTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDialogDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {hasDualPersona ? (
            <div className="space-y-3">
              <SettingsSegmentedTabs
                value={deleteTarget}
                onValueChange={(value) => setDeleteTarget(value as AccountDeletionTarget)}
                options={[
                  { value: "investor", label: "Investor" },
                  { value: "ria", label: "RIA" },
                  { value: "both", label: "Both" },
                ]}
              />
              <p className="text-sm leading-6 text-muted-foreground">
                {effectiveDeleteTarget === "investor"
                  ? "Investor deletion keeps your advisor-side workspace and signs you into the RIA shell afterwards."
                  : effectiveDeleteTarget === "ria"
                    ? "RIA deletion keeps your Kai investor account and takes you back to the investor shell afterwards."
                    : "Deleting both signs you out and removes the entire account."}
              </p>
            </div>
          ) : null}
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full sm:w-auto" disabled={isDeleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              className="app-critical-action w-full opacity-90 transition-opacity hover:opacity-100 sm:w-auto"
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteAccount();
              }}
              disabled={isDeleting}
            >
              {isDeleting
                ? "Deleting..."
                : effectiveDeleteTarget === "investor"
                  ? "Yes, Delete Investor"
                  : effectiveDeleteTarget === "ria"
                    ? "Yes, Delete RIA"
                    : "Yes, Delete Everything"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canEditKaiPreferences && (
        <KaiPreferencesSheet
          open={showKaiPreferencesSheet}
          onOpenChange={setShowKaiPreferencesSheet}
          userId={user.uid}
          vaultKey={vaultKey as string}
          vaultOwnerToken={vaultOwnerToken as string}
        />
      )}
    </AppPageShell>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={null}>
      <ProfilePageContent />
    </Suspense>
  );
}
