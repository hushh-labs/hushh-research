"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReadonlyURLSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bug,
  Cloud,
  Code2,
  ExternalLink,
  Fingerprint,
  Folder,
  KeyRound,
  LifeBuoy,
  Loader2,
  LogOut,
  Mail,
  Monitor,
  RefreshCw,
  SendHorizontal,
  ShieldCheck,
  Trash2,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";

import {
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceInset,
  SurfaceStack,
} from "@/components/app-ui/surfaces";
import {
  PkmAccessManagerPanel,
  PkmAccessConnectionDetailPanel,
  PkmDataManagerPanel,
  PkmDomainDetailPanel,
  ProfileStateNotice,
} from "@/components/profile/pkm-data-manager";
import { ProfileStackNavigator, type ProfileStackEntry } from "@/components/profile/profile-stack-navigator";
import { ProfileKaiPreferencesPanel } from "@/components/profile/profile-kai-preferences-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import { resolveDeveloperRuntime } from "@/lib/developers/runtime";
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
  ConsentCenterService,
  type ConsentCenterResponse,
} from "@/lib/services/consent-center-service";
import {
  SupportService,
  type SupportMessageKind,
} from "@/lib/services/support-service";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  buildPkmAccessConnections,
  buildPkmDomainPresentation,
  buildPkmDomainPermissionPresentation,
  buildPkmDomainUpgradePresentation,
  buildPkmProfileSummaryPresentation,
} from "@/lib/profile/pkm-profile-presentation";
import {
  buildPkmSectionPreviewPresentation,
  type PkmSectionPreviewPresentation,
} from "@/lib/profile/pkm-section-preview";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
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
  type PersonalKnowledgeModelMetadata,
  PkmScopeExposureError,
  type PkmUpgradeDomainState,
} from "@/lib/services/personal-knowledge-model-service";
import {
  PKM_UPGRADE_COMPLETED_EVENT,
  type PkmUpgradeCompletedEventDetail,
} from "@/lib/services/pkm-upgrade-orchestrator";
import { useVault } from "@/lib/vault/vault-context";
import { resolveVaultAvailabilityState } from "@/lib/vault/vault-access-policy";
import { useConsentActions } from "@/lib/consent";

type ProfilePanel =
  | "my-data"
  | "access"
  | "preferences"
  | "security"
  | "support"
  | "gmail";

type ProfileDetail =
  | `domain:${string}`
  | `connection:${string}`
  | "kai-preferences"
  | "device"
  | "vault"
  | "session"
  | "danger"
  | "gmail-connection"
  | "gmail-actions"
  | "support-routing"
  | `support-compose:${SupportMessageKind}`;

type ProfileRouteState = {
  panel: ProfilePanel | null;
  detail: ProfileDetail | null;
};

function cloneManifest(manifest: DomainManifest | null): DomainManifest | null {
  if (!manifest) return null;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(manifest) as DomainManifest;
    } catch {
      // Fall through to JSON clone.
    }
  }
  return JSON.parse(JSON.stringify(manifest)) as DomainManifest;
}

function applyManifestExposureChange(
  manifest: DomainManifest | null | undefined,
  target: { scopeHandle?: string | null; topLevelScopePath: string },
  exposureEnabled: boolean
): DomainManifest | null | undefined {
  if (!manifest) return manifest;
  const nextManifest = cloneManifest(manifest);
  if (!nextManifest) return nextManifest;

  let updated = false;
  if (Array.isArray(nextManifest.scope_registry)) {
    nextManifest.scope_registry = nextManifest.scope_registry.map((entry) => {
      const projection =
        entry.summary_projection && typeof entry.summary_projection === "object"
          ? entry.summary_projection
          : {};
      const matchesHandle =
        target.scopeHandle && entry.scope_handle === target.scopeHandle;
      const matchesPath =
        String(projection.top_level_scope_path || "").trim() === target.topLevelScopePath;
      if (!matchesHandle && !matchesPath) {
        return entry;
      }
      updated = true;
      return {
        ...entry,
        exposure_enabled: exposureEnabled,
      };
    });
  }

  if (!updated && Array.isArray(nextManifest.top_level_scope_paths)) {
    updated = nextManifest.top_level_scope_paths.includes(target.topLevelScopePath);
  }

  return updated ? nextManifest : manifest;
}

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

function normalizeProfilePanel(value: string | null): ProfilePanel | null {
  if (
    value === "my-data" ||
    value === "access" ||
    value === "preferences" ||
    value === "security" ||
    value === "support" ||
    value === "gmail"
  ) {
    return value;
  }
  return null;
}

function normalizeProfileDetail(panel: ProfilePanel | null, value: string | null): ProfileDetail | null {
  const detail = String(value || "").trim();
  if (!panel || !detail) return null;

  if (panel === "my-data" && detail.startsWith("domain:")) {
    return detail as ProfileDetail;
  }
  if (panel === "access" && detail.startsWith("connection:")) {
    return detail as ProfileDetail;
  }
  if (
    panel === "preferences" &&
    (detail === "kai-preferences" || detail === "device")
  ) {
    return detail;
  }
  if (panel === "security" && (detail === "vault" || detail === "session" || detail === "danger")) {
    return detail;
  }
  if (panel === "gmail" && (detail === "gmail-connection" || detail === "gmail-actions")) {
    return detail;
  }
  if (panel === "support" && (detail === "support-routing" || detail.startsWith("support-compose:"))) {
    return detail as ProfileDetail;
  }

  return null;
}

function buildProfileHref(params: { panel?: ProfilePanel | null; detail?: ProfileDetail | null }) {
  const next = new URLSearchParams();
  if (params.panel) {
    next.set("panel", params.panel);
  }
  if (params.panel && params.detail) {
    next.set("detail", params.detail);
  }
  const query = next.toString();
  return query ? `${ROUTES.PROFILE}?${query}` : ROUTES.PROFILE;
}

function formatProfileInventoryBadge(
  summary: ReturnType<typeof buildPkmProfileSummaryPresentation> | null,
  params: { loading: boolean; ready: boolean; failed: boolean }
) {
  if (!params.ready) {
    if (params.failed) return "Unavailable";
    return params.loading ? "Loading" : "Checking";
  }
  const itemCount = summary?.totalAttributes ?? 0;
  const sourceCount = summary?.totalSourceCount ?? 0;
  return `${itemCount} items · ${sourceCount} sources`;
}

function formatProfileAccessBadge(params: {
  activeGrantCount: number;
  loading: boolean;
  ready: boolean;
  failed: boolean;
}) {
  if (!params.ready) {
    if (params.failed) return "Unavailable";
    return params.loading ? "Loading" : "Checking";
  }
  return `${params.activeGrantCount} active`;
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

function resolveProfileRouteState(searchParams: ReadonlyURLSearchParams): ProfileRouteState {
  let panel = normalizeProfilePanel(searchParams.get("panel"));

  if (!panel) {
    const tab = searchParams.get("tab");
    if (tab === "my-data") panel = "my-data";
    else if (tab === "access" || tab === "privacy") panel = "access";
    else if (tab === "preferences") panel = "preferences";
    else if (tab === "security") panel = "security";
  }

  return {
    panel,
    detail: normalizeProfileDetail(panel, searchParams.get("detail")),
  };
}

function profileRouteRequiresUnlockedVault(
  panel: ProfilePanel | null,
  detail: ProfileDetail | null
): boolean {
  if (panel === "my-data" || panel === "access" || panel === "gmail") {
    return true;
  }
  if (panel === "security") {
    return true;
  }
  return panel === "preferences" && detail === "kai-preferences";
}

function ProfilePageContent() {
  const canShowPkmAgentLab = resolveDeveloperRuntime().environment === "local";
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
  const [pendingProfileTarget, setPendingProfileTarget] = useState<{
    panel: ProfilePanel;
    detail: ProfileDetail | null;
    mode: "push" | "replace";
  } | null>(null);
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [pkmMetadata, setPkmMetadata] = useState<PersonalKnowledgeModelMetadata | null>(null);
  const [loadingPkmMetadata, setLoadingPkmMetadata] = useState(true);
  const [pkmError, setPkmError] = useState<string | null>(null);
  const [domainManifests, setDomainManifests] = useState<Record<string, DomainManifest | null | undefined>>({});
  const [loadingDomainManifests, setLoadingDomainManifests] = useState<Record<string, boolean>>({});
  const [domainManifestErrors, setDomainManifestErrors] = useState<Record<string, string | null>>({});
  const [pendingPermissionToggles, setPendingPermissionToggles] = useState<Record<string, boolean>>({});
  const [domainPreview, setDomainPreview] = useState<{
    open: boolean;
    permissionKey: string | null;
    title: string;
    description: string;
    presentation: PkmSectionPreviewPresentation | null;
    loading: boolean;
    error: string | null;
  }>({
    open: false,
    permissionKey: null,
    title: "",
    description: "",
    presentation: null,
    loading: false,
    error: null,
  });
  const [consentCenter, setConsentCenter] = useState<ConsentCenterResponse | null>(null);
  const [loadingConsentCenter, setLoadingConsentCenter] = useState(true);
  const [consentCenterError, setConsentCenterError] = useState<string | null>(null);
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
  const [marketplaceOptIn, setMarketplaceOptIn] = useState(false);
  const [loadingMarketplaceOptIn, setLoadingMarketplaceOptIn] = useState(true);
  const [savingMarketplaceOptIn, setSavingMarketplaceOptIn] = useState(false);
  const [supportKind, setSupportKind] =
    useState<SupportMessageKind>("support_request");
  const [supportSubject, setSupportSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [sendingSupportMessage, setSendingSupportMessage] = useState(false);
  const [gmailActionBusy, setGmailActionBusy] = useState<
    "connect" | "disconnect" | "sync" | null
  >(null);
  const vaultUnlockCompletingRef = useRef(false);

  const profileRouteState = resolveProfileRouteState(searchParams);
  const activePanel = profileRouteState.panel;
  const activeDetail = profileRouteState.detail;
  const shouldRequestVaultUnlock = searchParams.get("unlock_vault") === "1";

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
  const routeBlockedByVault =
    hasVault === true &&
    vaultAccess.needsUnlock &&
    profileRouteRequiresUnlockedVault(activePanel, activeDetail);
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
  const upgradeStatesByDomain = useMemo<Record<string, PkmUpgradeDomainState>>(
    () =>
      Object.fromEntries(
        (pkmMetadata?.upgradableDomains || []).map((entry) => [entry.domain, entry])
      ),
    [pkmMetadata?.upgradableDomains]
  );

  const domainPresentations = useMemo(
    () =>
      (pkmMetadata?.domains || []).map((domain) =>
        buildPkmDomainPresentation({
          domain,
          activeGrants: consentCenter?.active_grants || [],
          manifest: domainManifests[domain.key],
          upgradeState: upgradeStatesByDomain[domain.key] || null,
        })
      ),
    [consentCenter?.active_grants, domainManifests, pkmMetadata?.domains, upgradeStatesByDomain]
  );

  const pkmMetadataReady = pkmMetadata !== null;
  const consentCenterReady = consentCenter !== null;
  const pkmMetadataFailed = Boolean(pkmError) && !pkmMetadataReady;
  const consentCenterFailed = Boolean(consentCenterError) && !consentCenterReady;

  const profileSummary = useMemo(
    () =>
      buildPkmProfileSummaryPresentation({
        metadata: pkmMetadata,
        domains: domainPresentations,
        activeGrants: consentCenter?.active_grants || [],
        pendingRequestCount: pendingConsents,
        metadataResolved: pkmMetadataReady,
        sharingResolved: consentCenterReady,
      }),
    [
      consentCenter?.active_grants,
      consentCenterReady,
      domainPresentations,
      pendingConsents,
      pkmMetadata,
      pkmMetadataReady,
    ]
  );

  const accessConnections = useMemo(
    () => buildPkmAccessConnections(domainPresentations),
    [domainPresentations]
  );

  const selectedDomain = useMemo(() => {
    if (activePanel !== "my-data" || !activeDetail?.startsWith("domain:")) return null;
    const domainKey = activeDetail.slice("domain:".length);
    return domainPresentations.find((domain) => domain.key === domainKey) || null;
  }, [activeDetail, activePanel, domainPresentations]);

  const selectedDomainMetadata = useMemo(() => {
    if (!selectedDomain) return null;
    return (pkmMetadata?.domains || []).find((domain) => domain.key === selectedDomain.key) || null;
  }, [pkmMetadata?.domains, selectedDomain]);

  const selectedDomainManifest = selectedDomain ? domainManifests[selectedDomain.key] ?? null : null;
  const selectedDomainUpgrade = useMemo(() => {
    if (!selectedDomain || !selectedDomainMetadata) return null;
    if (vaultAccess.needsUnlock && hasVault) {
      return {
        status: "updating" as const,
        label: "Unlock required",
        description:
          "This domain stays readable while locked. Unlock the vault to manage section-level sharing controls.",
        canManagePermissions: false,
      };
    }
    return buildPkmDomainUpgradePresentation({
      domain: selectedDomainMetadata,
      manifest: selectedDomainManifest,
      upgradeState: upgradeStatesByDomain[selectedDomain.key] || null,
    });
  }, [
    hasVault,
    selectedDomain,
    selectedDomainManifest,
    selectedDomainMetadata,
    upgradeStatesByDomain,
    vaultAccess.needsUnlock,
  ]);

  const selectedDomainPermissions = useMemo(() => {
    if (!selectedDomain || !selectedDomainMetadata) return [];
    return buildPkmDomainPermissionPresentation({
      domain: selectedDomainMetadata,
      manifest: selectedDomainManifest,
      activeGrants: consentCenter?.active_grants || [],
      upgradeState: upgradeStatesByDomain[selectedDomain.key] || null,
    });
  }, [
    consentCenter?.active_grants,
    selectedDomain,
    selectedDomainManifest,
    selectedDomainMetadata,
    upgradeStatesByDomain,
  ]);

  useEffect(() => {
    setDomainPreview((current) => {
      if (!current.open && current.permissionKey === null) {
        return current;
      }
      return {
        open: false,
        permissionKey: null,
        title: "",
        description: "",
        presentation: null,
        loading: false,
        error: null,
      };
    });
  }, [selectedDomain?.key]);

  const selectedConnection = useMemo(() => {
    if (activePanel !== "access" || !activeDetail?.startsWith("connection:")) return null;
    const connectionId = activeDetail.slice("connection:".length);
    return accessConnections.find((connection) => connection.id === connectionId) || null;
  }, [accessConnections, activeDetail, activePanel]);

  const updateProfileView = useMemo(
    () =>
      (
        next: {
          panel?: ProfilePanel | null;
          detail?: ProfileDetail | null;
        },
        mode: "push" | "replace" = "push"
      ) => {
        const href = buildProfileHref({
          panel: typeof next.panel === "undefined" ? activePanel : next.panel,
          detail: typeof next.detail === "undefined" ? activeDetail : next.detail,
        });
        if (mode === "push") {
          router.push(href, { scroll: false });
        } else {
          router.replace(href, { scroll: false });
        }
      },
    [activeDetail, activePanel, router]
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

  const refreshPkmMetadata = useCallback(
    async (force = false) => {
      if (!user?.uid) return;
      const metadata = await PersonalKnowledgeModelService.getMetadata(
        user.uid,
        force,
        vaultOwnerToken ?? undefined
      );
      setPkmMetadata(metadata);
      setPkmError(null);
      return metadata;
    },
    [user?.uid, vaultOwnerToken]
  );

  const refreshDomainManifest = useCallback(
    async (domainKey: string, force = false) => {
      if (!user?.uid || !vaultOwnerToken) return null;
      setLoadingDomainManifests((current) => ({ ...current, [domainKey]: true }));
      try {
        const manifest = await PersonalKnowledgeModelService.getDomainManifest(
          user.uid,
          domainKey,
          vaultOwnerToken,
          force
        );
        setDomainManifests((current) => ({ ...current, [domainKey]: manifest }));
        setDomainManifestErrors((current) => ({ ...current, [domainKey]: null }));
        return manifest;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Couldn't load sharing controls for this domain.";
        setDomainManifestErrors((current) => ({ ...current, [domainKey]: message }));
        return null;
      } finally {
        setLoadingDomainManifests((current) => ({ ...current, [domainKey]: false }));
      }
    },
    [user?.uid, vaultOwnerToken]
  );

  const refreshVisibleDomainManifests = useCallback(
    async (force = false) => {
      if (!user?.uid || !vaultOwnerToken) return;
      const domainKeys = (pkmMetadata?.domains || []).map((domain) => domain.key);
      if (domainKeys.length === 0) return;
      await Promise.all(domainKeys.map((domainKey) => refreshDomainManifest(domainKey, force)));
    },
    [pkmMetadata?.domains, refreshDomainManifest, user?.uid, vaultOwnerToken]
  );

  useEffect(() => {
    if (!user?.uid) return;

    const handleUpgradeCompleted = (event: Event) => {
      const detail = (event as CustomEvent<PkmUpgradeCompletedEventDetail>).detail;
      if (detail?.userId !== user.uid) {
        return;
      }

      void (async () => {
        setLoadingPkmMetadata(true);
        try {
          const nextMetadata = await refreshPkmMetadata(true);
          if (vaultOwnerToken && !vaultAccess.needsVaultCreation && !vaultAccess.needsUnlock) {
            const domainKeys = (nextMetadata?.domains || []).map((domain) => domain.key);
            await Promise.all(domainKeys.map((domainKey) => refreshDomainManifest(domainKey, true)));
          }
        } catch (error) {
          console.warn("[ProfilePage] Failed to refresh PKM after upgrade completion.", error);
        } finally {
          setLoadingPkmMetadata(false);
        }
      })();
    };

    window.addEventListener(PKM_UPGRADE_COMPLETED_EVENT, handleUpgradeCompleted);
    return () => {
      window.removeEventListener(PKM_UPGRADE_COMPLETED_EVENT, handleUpgradeCompleted);
    };
  }, [
    refreshPkmMetadata,
    refreshDomainManifest,
    user?.uid,
    vaultAccess.needsUnlock,
    vaultAccess.needsVaultCreation,
    vaultOwnerToken,
  ]);

  const refreshConsentCenter = useCallback(
    async (force = false) => {
      if (!user?.uid) return;
      const idToken = await user.getIdToken();
      const nextCenter = await ConsentCenterService.getCenter({
        idToken,
        userId: user.uid,
        actor: "investor",
        view: "active",
        force,
      });
      setConsentCenter(nextCenter);
      setConsentCenterError(null);
    },
    [user]
  );

  const { handleRevoke } = useConsentActions({
    userId: user?.uid ?? null,
    onActionComplete: () => {
      void refreshConsentCenter(true);
    },
  });

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      if (authLoading) return;

      if (!initialized) {
        registerSteps(1);
        setInitialized(true);
      }

      if (!user?.uid || hasVault === null) return;

      try {
        setLoadingPkmMetadata(true);
        setLoadingConsentCenter(true);

        const idToken = await user.getIdToken();
        const [metadata, center] = await Promise.all([
          PersonalKnowledgeModelService.getMetadata(
            user.uid,
            false,
            vaultOwnerToken ?? undefined
          ),
          ConsentCenterService.getCenter({
            idToken,
            userId: user.uid,
            actor: "investor",
            view: "active",
            force: false,
          }),
        ]);
        if (cancelled) return;
        setPkmMetadata(metadata);
        setConsentCenter(center);
        setPkmError(null);
        setConsentCenterError(null);
        completeStep();
      } catch (error) {
        console.error("Failed to load profile manager data:", error);
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : "Failed to load profile knowledge view.";
          setPkmError(message);
          setConsentCenterError(message);
          completeStep();
        }
      } finally {
        if (!cancelled) {
          setLoadingPkmMetadata(false);
          setLoadingConsentCenter(false);
        }
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
    user,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (
      activePanel !== "my-data" ||
      authLoading ||
      !user?.uid ||
      !vaultOwnerToken ||
      vaultAccess.needsVaultCreation ||
      vaultAccess.needsUnlock
    ) {
      return;
    }
    void refreshVisibleDomainManifests(false);
  }, [
    activePanel,
    authLoading,
    refreshVisibleDomainManifests,
    user?.uid,
    vaultAccess.needsUnlock,
    vaultAccess.needsVaultCreation,
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

  function openSupportComposer(kind: SupportMessageKind) {
    setSupportKind(kind);
    setSupportSubject(SUPPORT_KIND_COPY[kind].subject);
    setSupportMessage("");
    updateProfileView(
      {
        panel: "support",
        detail: `support-compose:${kind}`,
      },
      "push"
    );
  }

  function requestVaultUnlock(reason: "profile_data" | "delete_account" = "profile_data") {
    setVaultUnlockReason(reason);
    setShowVaultUnlock(true);
  }

  function openVaultBackedPanel(panel: Extract<ProfilePanel, "my-data" | "access" | "gmail" | "security">) {
    if (vaultAccess.needsVaultCreation) {
      router.push(ROUTES.KAI_IMPORT);
      return;
    }
    if (hasVault && vaultAccess.needsUnlock) {
      setPendingProfileTarget({ panel, detail: null, mode: "push" });
      requestVaultUnlock("profile_data");
      return;
    }
    updateProfileView({ panel, detail: null }, "push");
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
      updateProfileView({ panel: "support", detail: null }, "replace");
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

  const handleVaultUnlockOpenChange = (open: boolean) => {
    setShowVaultUnlock(open);
    if (open) {
      vaultUnlockCompletingRef.current = false;
      return;
    }
    if (
      !open &&
      vaultUnlockReason === "profile_data" &&
      !vaultUnlockCompletingRef.current
    ) {
      setPendingProfileTarget(null);
    }
  };

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

  const marketplaceStatusText =
    loadingMarketplaceOptIn
      ? "Checking visibility…"
      : marketplaceOptIn
        ? "Discoverable to RIAs"
        : "Hidden from marketplace search";

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
  const gmailSettingsDescription = gmailPresentation.description;
  const gmailLastSyncText = gmailPresentation.latestSyncText;
  const profileManagerLoading = loadingPkmMetadata || loadingConsentCenter;
  const activeGrantCount = consentCenter?.active_grants.length || 0;
  const myDataRootBadge = formatProfileInventoryBadge(profileSummary, {
    loading: loadingPkmMetadata,
    ready: pkmMetadataReady,
    failed: pkmMetadataFailed,
  });
  const accessRootBadge = formatProfileAccessBadge({
    activeGrantCount,
    loading: loadingConsentCenter,
    ready: consentCenterReady,
    failed: consentCenterFailed,
  });
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();
  const supportComposeKind =
    activePanel === "support" && activeDetail?.startsWith("support-compose:")
      ? (activeDetail.slice("support-compose:".length) as SupportMessageKind)
      : null;
  const securitySummaryText =
    vaultAccess.needsVaultCreation
      ? "Vault not created yet"
      : loadingVaultMethod
        ? "Loading methods…"
        : vaultAccess.needsUnlock
          ? "Locked"
          : readableMethod(displayedUnlockMethod);
  const profileVoiceSurfaceMetadata = useMemo(() => {
    const controls = [
      {
        id: "profile_my_data",
        label: "Personal Knowledge Model",
        purpose: "opens your saved domains, source summaries, and sharing controls.",
        actionId: "nav.profile_my_data",
        role: "card",
        voiceAliases: ["personal knowledge model", "my data", "pkm"],
      },
      {
        id: "profile_access",
        label: "Access & sharing",
        purpose: "opens consent-backed access and sharing controls.",
        actionId: "nav.profile_access",
        role: "card",
        voiceAliases: ["access", "sharing", "consent access"],
      },
      {
        id: "profile_gmail",
        label: "Gmail receipts",
        purpose: "opens Gmail receipt sync and receipt-memory management.",
        actionId: "nav.profile_gmail",
        role: "card",
        voiceAliases: ["gmail receipts", "receipts"],
      },
      {
        id: "profile_support",
        label: "Support & feedback",
        purpose: "opens support routing and compose flows.",
        actionId: "nav.profile_support",
        role: "card",
        voiceAliases: ["support", "feedback"],
      },
      {
        id: "profile_sign_out",
        label: "Sign out",
        purpose: "ends this session on the current device.",
        actionId: "profile.sign_out",
        role: "button",
        voiceAliases: ["sign out", "log out"],
      },
      {
        id: "profile_delete_account",
        label: "Delete account",
        purpose: "opens destructive account deletion controls.",
        actionId: "profile.delete_account",
        role: "button",
        voiceAliases: ["delete account", "remove account"],
      },
      ...(canShowPkmAgentLab
        ? [
            {
              id: "profile_pkm_agent_lab",
              label: "PKM Agent Lab",
              purpose: "opens the developer-facing PKM workspace.",
              actionId: "nav.profile_pkm_agent_lab",
              role: "card",
              voiceAliases: ["pkm agent lab", "memory lab"],
            },
          ]
        : []),
    ];
    const activeControl =
      controls.find((control) => control.id === activeVoiceControlId) ||
      controls.find((control) => control.id === lastVoiceControlId) ||
      null;
    const visibleModules = activePanel
      ? [
          activePanel === "my-data"
            ? "Personal Knowledge Model"
            : activePanel === "access"
              ? "Access & sharing"
              : activePanel === "preferences"
                ? "Preferences"
                : activePanel === "security"
                  ? "Security"
                  : activePanel === "gmail"
                    ? "Gmail receipts"
                    : "Support & feedback",
          ...(activeDetail ? [activeDetail] : []),
        ]
      : [
          "Personal Knowledge Model",
          "Access & sharing",
          "Preferences",
          "Security",
          "Support & feedback",
          "Gmail receipts",
          ...(canShowPkmAgentLab ? ["PKM Agent Lab"] : []),
        ];
    const availableActions =
      activePanel === "gmail"
        ? [
            gmailPresentation.isConnected
              ? "Sync Gmail receipts"
              : gmailPresentation.state === "needs_reauthentication"
                ? "Reconnect Gmail"
                : "Connect Gmail",
            "Open receipts",
            ...(gmailPresentation.isConnected ? ["Disconnect Gmail"] : []),
          ]
        : activePanel === "support"
          ? ["Report a bug", "Get support", "Reach developer"]
          : activePanel === "security"
            ? [
                vaultAccess.needsVaultCreation ? "Create your vault" : "Unlock vault",
                "Change passphrase",
                "Delete account",
              ]
            : [
                "Open Personal Knowledge Model",
                "Open Access & sharing",
                "Open Gmail receipts",
                "Open Support",
              ];

    return {
      surfaceDefinition: {
        screenId: activePanel ? `profile_${activePanel}` : "profile_home",
        title: activePanel
          ? activePanel === "my-data"
            ? "Personal Knowledge Model"
            : activePanel === "access"
              ? "Access & sharing"
              : activePanel === "preferences"
                ? "Preferences"
                : activePanel === "security"
                  ? "Security"
                  : activePanel === "gmail"
                    ? "Gmail receipts"
                    : "Support & feedback"
          : "Profile",
        purpose:
          "This surface manages profile data, access, preferences, Gmail receipts, support, and vault security.",
        sections: [
          {
            id: "my-data",
            title: "Personal Knowledge Model",
            purpose: "Saved domains, source summaries, and sharing controls.",
          },
          { id: "access", title: "Access & sharing", purpose: "Consent-backed access and sharing." },
          { id: "preferences", title: "Preferences", purpose: "Shell and Kai preferences." },
          { id: "security", title: "Security", purpose: "Vault and destructive account actions." },
          { id: "gmail", title: "Gmail receipts", purpose: "Receipt sync and Gmail connector state." },
          { id: "support", title: "Support & feedback", purpose: "Support routing and compose flows." },
        ],
        actions: availableActions.map((action) => ({
          id: action.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
          label: action,
          purpose: `${action} from Profile.`,
        })),
        controls,
        concepts: [
          {
            id: "personal_data",
            label: "Personal Data",
            explanation:
              "Your personal data is encrypted before storage. Kai uses it as your durable memory layer.",
            aliases: ["personal data", "pkm", "personal knowledge model"],
          },
          {
            id: "gmail_receipts",
            label: "Gmail receipts",
            explanation:
              "Gmail receipts connects receipt sync and feeds receipt-memory imports into your personal data.",
            aliases: ["gmail receipts", "receipt sync"],
          },
        ],
        activeControlId: activeVoiceControlId,
        lastInteractedControlId: lastVoiceControlId,
      },
      activeSection: activePanel || "profile",
      activeTab: activePanel || "profile",
      visibleModules,
      focusedWidget: activeControl?.label || (activeDetail ?? activePanel ?? "Profile"),
      modalState: passphraseDialogOpen
        ? "passphrase_dialog"
        : showVaultUnlock
          ? "vault_unlock"
          : supportComposeKind
            ? "support_compose"
            : activeDetail
              ? `${activePanel}_${activeDetail}`
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
        profile_panel: activePanel,
        profile_detail: activeDetail,
        total_attributes: profileSummary.totalAttributes,
        domain_count: profileSummary.totalDomains,
        pending_consents: pendingConsents,
        gmail_connected: gmailPresentation.isConnected,
        gmail_state: gmailPresentation.state,
        gmail_status_label: gmailStatusLabel,
        gmail_status_title: gmailStatusSummary.title,
        gmail_last_sync_text: gmailLastSyncText,
        google_email: gmail.status?.google_email || null,
        pkm_agent_lab_available: canShowPkmAgentLab,
        marketplace_opt_in: marketplaceOptIn,
        security_summary: securitySummaryText,
      },
    };
  }, [
    activeDetail,
    activePanel,
    activeVoiceControlId,
    canShowPkmAgentLab,
    gmailActionsBusy,
    gmailLastSyncText,
    gmailPresentation.isConnected,
    gmailPresentation.state,
    gmailStatusLabel,
    gmailStatusSummary.title,
    gmail.status?.google_email,
    lastVoiceControlId,
    marketplaceOptIn,
    passphraseDialogOpen,
    pendingConsents,
    profileSummary.totalAttributes,
    profileSummary.totalDomains,
    savingMarketplaceOptIn,
    securitySummaryText,
    sendingSupportMessage,
    showVaultUnlock,
    supportComposeKind,
    switchingVaultMethod,
    vaultAccess.needsVaultCreation,
  ]);
  usePublishVoiceSurfaceMetadata(profileVoiceSurfaceMetadata);

  useEffect(() => {
    if (!shouldRequestVaultUnlock || authLoading || hasVault === null) {
      return;
    }

    if (hasVault) {
      requestVaultUnlock("profile_data");
    } else {
      toast.error("Create your vault first before unlocking secure profile data.");
    }

    router.replace(buildProfileHref({ panel: activePanel, detail: activeDetail }), { scroll: false });
  }, [activeDetail, activePanel, authLoading, hasVault, router, shouldRequestVaultUnlock]);

  useEffect(() => {
    if (authLoading || !user?.uid || !hasVault || !vaultAccess.needsUnlock) {
      return;
    }
    if (!profileRouteRequiresUnlockedVault(activePanel, activeDetail)) {
      return;
    }
    if (activePanel) {
      setPendingProfileTarget({
        panel: activePanel,
        detail: activeDetail ?? null,
        mode: "replace",
      });
      router.replace(buildProfileHref({ panel: null, detail: null }), { scroll: false });
    }
    requestVaultUnlock("profile_data");
  }, [activeDetail, activePanel, authLoading, hasVault, router, user?.uid, vaultAccess.needsUnlock]);

  if (authLoading || !user) {
    return null;
  }

  const openKaiPreferences = () => {
    if (vaultAccess.needsVaultCreation) {
      router.push(ROUTES.KAI_IMPORT);
      return;
    }
    if (!vaultAccess.canMutateSecureData) {
      setPendingProfileTarget({
        panel: "preferences",
        detail: "kai-preferences",
        mode: "push",
      });
      requestVaultUnlock("profile_data");
      return;
    }
    updateProfileView(
      {
        panel: "preferences",
        detail: "kai-preferences",
      },
      "push"
    );
  };

  const popProfileStack = () => {
    if (activeDetail) {
      updateProfileView({ panel: activePanel, detail: null }, "replace");
      return;
    }
    updateProfileView({ panel: null, detail: null }, "replace");
  };
  const openMyDataPanel = () => openVaultBackedPanel("my-data");
  const openAccessPanel = () => openVaultBackedPanel("access");
  const openGmailPanel = () => openVaultBackedPanel("gmail");
  const openPreferencesPanel = () => updateProfileView({ panel: "preferences", detail: null }, "push");
  const openSecurityPanel = () => openVaultBackedPanel("security");

  const handlePreviewDomainPermission = async (
    domainKey: string,
    permission: {
      key: string;
      label: string;
      description: string;
      topLevelScopePath: string;
    }
  ) => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return;
    }

    setDomainPreview({
      open: true,
      permissionKey: permission.key,
      title: permission.label,
      description:
        permission.description ||
        `Saved values from your ${selectedDomain?.title?.toLowerCase() || domainKey} domain.`,
      presentation: null,
      loading: true,
      error: null,
    });

    try {
      const data = await PersonalKnowledgeModelService.loadDomainData({
        userId: user.uid,
        domain: domainKey,
        vaultKey,
        vaultOwnerToken,
        segmentIds: [permission.topLevelScopePath],
      });
      setDomainPreview((current) => ({
        ...current,
        open: true,
        permissionKey: permission.key,
        title: permission.label,
        description:
          permission.description ||
          `Saved values from your ${selectedDomain?.title?.toLowerCase() || domainKey} domain.`,
        presentation: buildPkmSectionPreviewPresentation({
          domain: domainKey,
          domainTitle: selectedDomain?.title || domainKey,
          permissionLabel: permission.label,
          permissionDescription: permission.description,
          topLevelScopePath: permission.topLevelScopePath,
          value: data,
        }),
        loading: false,
        error: null,
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't load saved values for this section.";
      setDomainPreview((current) => ({
        ...current,
        open: true,
        permissionKey: permission.key,
        title: permission.label,
        description:
          permission.description ||
          `Saved values from your ${selectedDomain?.title?.toLowerCase() || domainKey} domain.`,
        presentation: null,
        loading: false,
        error: message,
      }));
    }
  };

  const handleToggleDomainPermission = async (
    domainKey: string,
    permission: {
      key: string;
      scopeHandle: string | null;
      topLevelScopePath: string;
      exposureEnabled: boolean;
    },
    nextValue: boolean
  ) => {
    if (!user?.uid || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return;
    }

    const permissionKey = permission.key;
    const previousManifest = cloneManifest(domainManifests[domainKey] ?? null);
    if (!previousManifest) {
      toast.error("This domain is still preparing sharing controls.");
      return;
    }

    const optimisticManifest = applyManifestExposureChange(
      previousManifest,
      {
        scopeHandle: permission.scopeHandle,
        topLevelScopePath: permission.topLevelScopePath,
      },
      nextValue
    );

    setPendingPermissionToggles((current) => ({ ...current, [permissionKey]: true }));
    setDomainManifests((current) => ({ ...current, [domainKey]: optimisticManifest ?? previousManifest }));
    setDomainManifestErrors((current) => ({ ...current, [domainKey]: null }));

    try {
      const result = await PersonalKnowledgeModelService.updateScopeExposure({
        userId: user.uid,
        domain: domainKey,
        expectedManifestVersion: previousManifest.manifest_version,
        vaultOwnerToken,
        changes: [
          {
            scopeHandle: permission.scopeHandle || undefined,
            topLevelScopePath: permission.topLevelScopePath,
            exposureEnabled: nextValue,
          },
        ],
      });

      setDomainManifests((current) => ({
        ...current,
        [domainKey]: result.manifest ?? optimisticManifest ?? previousManifest,
      }));
      await Promise.all([refreshConsentCenter(true), refreshPkmMetadata(true)]);
      toast.success(
        nextValue ? "Sharing section is available for future approvals." : "Sharing section is now hidden."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't update sharing right now.";
      setDomainManifests((current) => ({ ...current, [domainKey]: previousManifest }));

      if (error instanceof PkmScopeExposureError && error.status === 409) {
        await Promise.all([
          refreshDomainManifest(domainKey, true),
          refreshConsentCenter(true),
          refreshPkmMetadata(true),
        ]);
        toast.error("Sharing changed elsewhere. The latest version has been reloaded.");
      } else {
        void refreshDomainManifest(domainKey, true);
        toast.error(message || "Couldn't update sharing right now.");
      }
    } finally {
      setPendingPermissionToggles((current) => {
        const next = { ...current };
        delete next[permissionKey];
        return next;
      });
    }
  };

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

  const myDataContent = (
    <PkmDataManagerPanel
      signedIn={Boolean(user)}
      loading={profileManagerLoading}
      metadataReady={pkmMetadataReady}
      metadataError={pkmError}
      sharingReady={consentCenterReady}
      sharingError={consentCenterError}
      needsVaultCreation={vaultAccess.needsVaultCreation}
      needsUnlock={vaultAccess.needsUnlock}
      summary={profileSummary}
      domains={domainPresentations}
      manifestsByDomain={domainManifests}
      loadingManifestsByDomain={loadingDomainManifests}
      manifestErrorsByDomain={domainManifestErrors}
      upgradeStatesByDomain={upgradeStatesByDomain}
      onOpenSharing={() => updateProfileView({ panel: "access", detail: null }, "push")}
      onOpenImport={() => router.push(ROUTES.KAI_IMPORT)}
      onRefresh={() => {
        void refreshPkmMetadata(true);
        void refreshConsentCenter(true);
        void refreshVisibleDomainManifests(true);
      }}
      onOpenDomain={(domain) =>
        updateProfileView(
          {
            panel: "my-data",
            detail: `domain:${domain.key}`,
          },
          "push"
        )
      }
    />
  );

  const accessContent = (
    <div className="space-y-4 sm:space-y-5">
      <PkmAccessManagerPanel
        signedIn={Boolean(user)}
        loading={profileManagerLoading}
        sharingReady={consentCenterReady}
        sharingError={consentCenterError}
        summary={profileSummary}
        domains={domainPresentations}
        onOpenConnection={(connection) =>
          updateProfileView(
            {
              panel: "access",
              detail: `connection:${connection.id}`,
            },
            "push"
          )
        }
        onRevokeAccess={async (scope) => {
          await handleRevoke(scope);
        }}
      />

      <SettingsGroup>
        <SettingsRow
          icon={ExternalLink}
          title="Consent center"
          description="Open the full sharing workspace."
          trailing={<Badge variant="secondary">Manage</Badge>}
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
            />
          }
        />
      </SettingsGroup>
    </div>
  );

  const preferencesContent = (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">Appearance</Badge>
        <Badge variant="secondary">
          {canEditKaiPreferences ? "Secure preferences ready" : "Unlock required"}
        </Badge>
        <Badge variant="secondary">Device controls soon</Badge>
      </div>
      <SettingsGroup>
        <SettingsRow
          icon={Monitor}
          title="Appearance"
          description="Light, dark, or system."
          trailing={<ThemeToggle className="w-full min-w-0 sm:w-[228px]" />}
          stackTrailingOnMobile
        />
        <SettingsRow
          icon={RefreshCw}
          title="Kai preferences"
          description={
            vaultAccess.canMutateSecureData
              ? "Risk profile and horizon."
              : "Unlock to edit secure Kai preferences."
          }
          trailing={canEditKaiPreferences ? <Badge variant="secondary">Ready</Badge> : null}
          chevron
          stackTrailingOnMobile
          onClick={openKaiPreferences}
        />
        <SettingsRow
          icon={Cloud}
          title="On-device first"
          description="Device-first controls."
          trailing={<Badge variant="secondary">Coming soon</Badge>}
          chevron
          stackTrailingOnMobile
          onClick={() => updateProfileView({ panel: "preferences", detail: "device" }, "push")}
        />
      </SettingsGroup>
    </div>
  );

  const securityContent = (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">
          {vaultAccess.hasVault ? (vaultAccess.needsUnlock ? "Vault locked" : "Vault unlocked") : "No vault"}
        </Badge>
        {displayedUnlockMethod ? (
          <Badge variant="secondary">{readableMethod(displayedUnlockMethod)}</Badge>
        ) : null}
      </div>
      <SettingsGroup>
        <SettingsRow
          icon={Fingerprint}
          title="Vault methods"
          description="Passphrase, passkey, and unlock method."
          chevron
          onClick={() => updateProfileView({ panel: "security", detail: "vault" }, "push")}
        />
        <SettingsRow
          icon={Trash2}
          title="Danger zone"
          description="Delete Investor, RIA, or the full account."
          chevron
          tone="destructive"
          onClick={() => updateProfileView({ panel: "security", detail: "danger" }, "push")}
        />
      </SettingsGroup>
    </div>
  );

  const supportContent = (
    <div className="space-y-4 sm:space-y-5">
      <SettingsGroup>
        {supportActions.map((action) => (
          <SettingsRow
            key={action.kind}
            icon={action.icon}
            title={action.label}
            description={action.description}
            chevron
            onClick={() => openSupportComposer(action.kind)}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Routing">
        <SettingsRow
          icon={SendHorizontal}
          title="Support routing"
          description="Reply address and routing."
          chevron
          onClick={() => updateProfileView({ panel: "support", detail: "support-routing" }, "push")}
        />
      </SettingsGroup>
    </div>
  );

  const gmailContent = (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{gmailStatusLabel}</Badge>
        {gmailLastSyncText && gmailLastSyncText !== "Not synced yet" ? (
          <Badge variant="secondary">{gmailLastSyncText}</Badge>
        ) : null}
      </div>
      <SettingsGroup>
        <SettingsRow
          icon={Mail}
          title="Connection"
          description={gmailSettingsDescription}
          trailing={<Badge variant="secondary">{gmailStatusLabel}</Badge>}
          chevron
          stackTrailingOnMobile
          onClick={() => updateProfileView({ panel: "gmail", detail: "gmail-connection" }, "push")}
        />
        <SettingsRow
          icon={RefreshCw}
          title="Actions"
          description="Connect, sync, receipts, or disconnect."
          chevron
          onClick={() => updateProfileView({ panel: "gmail", detail: "gmail-actions" }, "push")}
        />
      </SettingsGroup>
    </div>
  );

  const vaultMethodsContent = (
    <div className="space-y-4 sm:space-y-5">
      <SettingsGroup title="Vault">
        {vaultAccess.needsVaultCreation ? (
          <SettingsRow
            icon={Folder}
            title="Create your vault"
            description="Start from import to enable passphrase or passkey unlock for this account."
            chevron
            onClick={() => {
              router.push(ROUTES.KAI_IMPORT);
            }}
          />
        ) : null}

        {vaultAccess.hasVault && loadingVaultMethod ? (
          <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Icon icon={Loader2} size="sm" className="animate-spin" />
            Loading vault methods...
          </SurfaceInset>
        ) : null}

        {vaultAccess.hasVault && !loadingVaultMethod ? (
          <>
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
                  {displayedUnlockMethod === "passphrase" ? "Passphrase unlock" : "Quick unlock"}
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
          </>
        ) : null}
      </SettingsGroup>
    </div>
  );

  const gmailConnectionContent = (
    <div className="space-y-4 sm:space-y-5">
      <SettingsGroup title="Connection">
        <SettingsRow
          icon={Mail}
          title="Status"
          description={gmailSettingsDescription}
          trailing={<Badge variant="secondary">{gmailStatusLabel}</Badge>}
          stackTrailingOnMobile
        />
        <SettingsRow
          icon={SendHorizontal}
          title="Inbox"
          description={
            gmail.status?.google_email
              ? gmail.status.google_email
              : gmail.loadingStatus
                ? "Resolving connected inbox..."
                : "No Gmail inbox connected yet."
          }
        />
        <SettingsRow
          icon={RefreshCw}
          title="Latest sync"
          description={gmailLastSyncText}
          trailing={
            gmail.syncRun?.status || gmailPresentation.latestSyncBadge ? (
              <Badge variant="secondary">
                {gmail.syncRun?.status || gmailPresentation.latestSyncBadge}
              </Badge>
            ) : undefined
          }
          stackTrailingOnMobile
        />
      </SettingsGroup>
      {gmail.statusError ? (
        <SurfaceInset className="px-3.5 py-3.5 text-sm text-destructive sm:px-4 sm:py-4">
          {gmail.statusError}
        </SurfaceInset>
      ) : null}
    </div>
  );

  const gmailActionsContent = (
    <SettingsGroup title="Actions">
      {gmailPresentation.isConnected ? (
        <SettingsRow
          icon={RefreshCw}
          title="Sync now"
          description="Fetch new receipt emails and refresh extracted records."
          disabled={gmailActionsBusy || !gmailPresentation.isConnected}
          chevron
          onClick={() => void handleSyncGmailNow()}
        />
      ) : (
        <SettingsRow
          icon={Mail}
          title={
            gmailPresentation.state === "needs_reauthentication"
              ? "Reconnect Gmail"
              : "Connect Gmail"
          }
          description="Authorize Gmail read-only access for receipt sync."
          disabled={gmailActionsBusy || gmail.status?.configured === false}
          chevron
          onClick={() => void handleConnectGmail()}
        />
      )}

      <SettingsRow
        icon={RefreshCw}
        title="Refresh status"
        description="Re-check your Gmail connection, sync status, and inbox details."
        disabled={gmailActionsBusy}
        chevron
        onClick={() => void gmail.refreshStatus({ force: true })}
      />

      <SettingsRow
        icon={Folder}
        title="Open receipts"
        description="Review synced receipts, merchants, and extracted totals."
        chevron
        onClick={() => router.push(ROUTES.PROFILE_RECEIPTS)}
      />

      {gmailPresentation.isConnected ? (
        <SettingsRow
          icon={Trash2}
          title="Disconnect Gmail"
          description="Stop future syncs. Existing synced receipts remain available."
          tone="destructive"
          disabled={gmailActionsBusy}
          chevron
          onClick={() => void handleDisconnectGmail()}
        />
      ) : null}
    </SettingsGroup>
  );

  const supportRoutingContent = (
    <SettingsGroup title="Routing">
      <SettingsRow
        icon={SendHorizontal}
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
  );

  const supportComposeContent = supportComposeKind ? (
    <SurfaceCard>
      <SurfaceCardHeader>
        <SurfaceCardTitle>{SUPPORT_KIND_COPY[supportComposeKind].title}</SurfaceCardTitle>
        <SurfaceCardDescription>
          {SUPPORT_KIND_COPY[supportComposeKind].description}
        </SurfaceCardDescription>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-3">
        <Input
          value={supportSubject}
          onChange={(event) => setSupportSubject(event.target.value)}
          placeholder="Subject"
        />
        <Textarea
          value={supportMessage}
          onChange={(event) => setSupportMessage(event.target.value)}
          placeholder="Tell us what happened and what you expected."
          className="min-h-[180px]"
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="none"
            effect="fade"
            size="default"
            className="w-full sm:w-auto"
            onClick={() => popProfileStack()}
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
        </div>
      </SurfaceCardContent>
    </SurfaceCard>
  ) : null;

  const profileStackEntries: ProfileStackEntry[] = [];

  if (!routeBlockedByVault && activePanel === "my-data") {
    profileStackEntries.push({
      key: "panel:my-data",
      title: "Personal Knowledge Model",
      description: "Browse domains, counts, and sharing controls.",
      content: myDataContent,
    });
    if (selectedDomain) {
      profileStackEntries.push({
        key: `detail:domain:${selectedDomain.key}`,
        title: selectedDomain.title,
        description: "Review sections and sharing controls.",
        content: (
          <PkmDomainDetailPanel
            domain={selectedDomain}
            permissions={selectedDomainPermissions}
            upgrade={
              selectedDomainUpgrade || {
                status: "missing_manifest",
                label: "Updating structure",
                description:
                  "Sharing controls will appear here once this domain manifest is ready.",
                canManagePermissions: false,
              }
            }
            manifestLoading={Boolean(selectedDomain && loadingDomainManifests[selectedDomain.key])}
            manifestError={selectedDomain ? domainManifestErrors[selectedDomain.key] : null}
            pendingPermissionKeys={selectedDomainPermissions
              .filter((permission) => pendingPermissionToggles[permission.key])
              .map((permission) => permission.key)}
            previewOpen={domainPreview.open}
            previewTitle={domainPreview.title}
            previewDescription={domainPreview.description}
            previewPresentation={domainPreview.presentation}
            previewLoading={domainPreview.loading}
            previewError={domainPreview.error}
            onPreviewOpenChange={(open) =>
              setDomainPreview((current) => ({
                ...current,
                open,
              }))
            }
            onPreviewPermission={(permission) =>
              void handlePreviewDomainPermission(selectedDomain.key, permission)
            }
            onTogglePermission={(permission, nextValue) =>
              void handleToggleDomainPermission(selectedDomain.key, permission, nextValue)
            }
          />
        ),
      });
    }
  } else if (!routeBlockedByVault && activePanel === "access") {
    profileStackEntries.push({
      key: "panel:access",
      title: "Access & sharing",
      description: "Review who can read what and manage live grants.",
      content: accessContent,
    });
    if (selectedConnection) {
      profileStackEntries.push({
        key: `detail:connection:${selectedConnection.id}`,
        title: selectedConnection.requesterLabel,
        description: "Inspect exact scopes and revoke access inline.",
        content: (
          <PkmAccessConnectionDetailPanel
            connection={selectedConnection}
              onRevokeAccess={async (scope) => {
                await handleRevoke(scope);
              }}
          />
        ),
      });
    }
  } else if (!routeBlockedByVault && activePanel === "preferences") {
    profileStackEntries.push({
      key: "panel:preferences",
      title: "Preferences",
      description: "Appearance, Kai settings, and device behavior.",
      content: preferencesContent,
    });
    if (activeDetail === "kai-preferences") {
      profileStackEntries.push({
        key: "detail:kai-preferences",
        title: "Kai preferences",
        description: "Secure personal settings for Kai.",
        content: (
          <ProfileKaiPreferencesPanel
            userId={user.uid}
            vaultKey={vaultKey}
            vaultOwnerToken={vaultOwnerToken}
            canEdit={canEditKaiPreferences}
            onRequestUnlock={() => requestVaultUnlock("profile_data")}
          />
        ),
      });
    } else if (activeDetail === "device") {
      profileStackEntries.push({
        key: "detail:device",
        title: "On-device first",
        description: "Local-device controls and upcoming options.",
        content: (
          <SettingsGroup title="Device">
            <SettingsRow
              icon={Cloud}
              title="Bring your own key"
              description="Planned."
              trailing={<Badge variant="secondary">Coming soon</Badge>}
              stackTrailingOnMobile
            />
          </SettingsGroup>
        ),
      });
    }
  } else if (!routeBlockedByVault && activePanel === "security") {
    profileStackEntries.push({
      key: "panel:security",
      title: "Security",
      description: "Vault methods, session controls, and account deletion.",
      content: securityContent,
    });
    if (activeDetail === "vault") {
      profileStackEntries.push({
        key: "detail:vault",
        title: "Vault methods",
        description: "Review unlock method and secure defaults.",
        content: vaultMethodsContent,
      });
    } else if (activeDetail === "session") {
      profileStackEntries.push({
        key: "detail:session",
        title: "Session",
        description: "Manage the current session on this device.",
        content: (
          <SettingsGroup title="Session">
            <SettingsRow
              icon={LogOut}
              title="Sign out"
              description="End this session on the current device."
              onClick={() => void handleSignOut()}
              chevron
            />
          </SettingsGroup>
        ),
      });
    } else if (activeDetail === "danger") {
      profileStackEntries.push({
        key: "detail:danger",
        title: "Danger zone",
        description: "Delete persona or account data.",
        content: (
          <SettingsGroup title="Danger zone">
            <SettingsRow
              icon={Trash2}
              title={deleteButtonLabel}
              description={deleteRowDescription}
              tone="destructive"
              onClick={() => void handleDeleteClick()}
              chevron
            />
          </SettingsGroup>
        ),
      });
    }
  } else if (!routeBlockedByVault && activePanel === "gmail") {
    profileStackEntries.push({
      key: "panel:gmail",
      title: "Gmail receipts",
      description: "Connection state, sync health, and receipt actions.",
      content: gmailContent,
    });
    if (activeDetail === "gmail-connection") {
      profileStackEntries.push({
        key: "detail:gmail-connection",
        title: "Connection",
        description: "Current inbox, status, and latest sync.",
        content: gmailConnectionContent,
      });
    } else if (activeDetail === "gmail-actions") {
      profileStackEntries.push({
        key: "detail:gmail-actions",
        title: "Actions",
        description: "Connect, sync, open receipts, or disconnect.",
        content: gmailActionsContent,
      });
    }
  } else if (!routeBlockedByVault && activePanel === "support") {
    profileStackEntries.push({
      key: "panel:support",
      title: "Support & feedback",
      description: "Get help, report bugs, or send product feedback.",
      content: supportContent,
    });
    if (activeDetail === "support-routing") {
      profileStackEntries.push({
        key: "detail:support-routing",
        title: "Support routing",
        description: "Where support messages are routed and replied.",
        content: supportRoutingContent,
      });
    } else if (supportComposeKind && supportComposeContent) {
      profileStackEntries.push({
        key: `detail:support-compose:${supportComposeKind}`,
        title: SUPPORT_KIND_COPY[supportComposeKind].title,
        description: "Write and send a concise support message.",
        content: supportComposeContent,
      });
    }
  }

  const profileRootContent = (
    <>
      <AppPageHeaderRegion
        className="pt-[calc(var(--page-top-start)+6.25rem)] sm:pt-[calc(var(--page-top-start)+6.9rem)]"
      >
        <header
          className="flex w-full min-w-0 flex-col items-center gap-2.5 px-4 text-center sm:px-6"
          data-slot="page-header"
          data-page-primary="true"
        >
          <Avatar className="h-14 w-14 shrink-0 ring-4 ring-primary/18 sm:h-16 sm:w-16">
            <AvatarImage
              src={user.photoURL || undefined}
              alt={user.displayName || "Profile"}
            />
            <AvatarFallback className="bg-muted text-base font-semibold text-muted-foreground sm:text-lg">
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
          <div className="min-w-0 max-w-full space-y-1.5">
            <h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground [overflow-wrap:anywhere] sm:text-[2rem]">
              {user.displayName || "User"}
            </h1>
            <div
              className="inline-flex max-w-full items-center justify-center gap-2 text-sm text-muted-foreground"
              title={provider.name}
            >
              <ProviderIcon providerId={provider.id} />
              <span className="[overflow-wrap:anywhere]">
                {user.email || "Not available"}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <Badge variant="secondary">{myDataRootBadge}</Badge>
              <Badge variant="secondary">{accessRootBadge}</Badge>
              <Badge variant="secondary">{gmailStatusLabel}</Badge>
            </div>
            {vaultAccess.needsUnlock && hasVault ? (
              <div className="pt-1.5">
                <Button
                  size="sm"
                  className="min-w-[148px]"
                  onClick={() => requestVaultUnlock("profile_data")}
                >
                  <Icon icon={KeyRound} size="sm" className="mr-2" />
                  Unlock vault
                </Button>
              </div>
            ) : null}
          </div>
        </header>
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <div className="space-y-4 sm:space-y-5">
            {pkmError ? (
              <ProfileStateNotice
                tone="warning"
                title="Data loaded partially"
                description={pkmError}
              />
            ) : null}
            {consentCenterError ? (
              <ProfileStateNotice
                tone="warning"
                title="Access loaded partially"
                description={consentCenterError}
              />
            ) : null}

            <SettingsGroup title="Data">
              <SettingsRow
                icon={Folder}
                title="Personal Knowledge Model"
                description={
                  vaultAccess.needsVaultCreation
                    ? "Create your vault first."
                    : !pkmMetadataReady && !pkmMetadataFailed
                      ? "Checking saved domains."
                      : pkmMetadataFailed
                        ? "Saved data is unavailable."
                    : vaultAccess.needsUnlock
                      ? "Unlock to review domains and sharing."
                      : "Domains, counts, and sharing."
                }
                trailing={<Badge variant="secondary">{myDataRootBadge}</Badge>}
                chevron={!vaultAccess.needsVaultCreation}
                disabled={vaultAccess.needsVaultCreation}
                stackTrailingOnMobile
                onClick={openMyDataPanel}
              />
              <SettingsRow
                icon={ShieldCheck}
                title="Access & sharing"
                description={
                  vaultAccess.needsVaultCreation
                    ? "Create your vault first."
                    : !consentCenterReady && !consentCenterFailed
                      ? "Checking current sharing state."
                      : consentCenterFailed
                        ? "Sharing is unavailable."
                    : vaultAccess.needsUnlock
                      ? "Unlock to review live access."
                      : "Who can read what."
                }
                trailing={<Badge variant="secondary">{accessRootBadge}</Badge>}
                chevron={!vaultAccess.needsVaultCreation}
                disabled={vaultAccess.needsVaultCreation}
                stackTrailingOnMobile
                onClick={openAccessPanel}
              />
              <SettingsRow
                icon={Mail}
                title="Gmail receipts"
                description={
                  vaultAccess.needsVaultCreation
                    ? "Create your vault first."
                    : vaultAccess.needsUnlock
                      ? "Unlock to review sync and receipts."
                      : "Connection, sync, and receipts."
                }
                trailing={<Badge variant="secondary">{gmailStatusLabel}</Badge>}
                chevron={!vaultAccess.needsVaultCreation}
                disabled={vaultAccess.needsVaultCreation}
                stackTrailingOnMobile
                onClick={openGmailPanel}
              />
            </SettingsGroup>

            <SettingsGroup title="Account">
              <SettingsRow
                icon={RefreshCw}
                title="Preferences"
                description="Theme, Kai, and device behavior."
                chevron
                onClick={openPreferencesPanel}
              />
              <SettingsRow
                icon={Fingerprint}
                title="Security"
                description="Vault, session, and account deletion."
                chevron
                onClick={openSecurityPanel}
              />
              <SettingsRow
                icon={LifeBuoy}
                title="Support & feedback"
                description="Help, bugs, and product feedback."
                chevron
                onClick={() => updateProfileView({ panel: "support", detail: null }, "push")}
              />
              {canShowPkmAgentLab ? (
                <SettingsRow
                  icon={Code2}
                  title="PKM Agent Lab"
                  description="Local developer workspace."
                  trailing={<Badge variant="secondary">Local</Badge>}
                  chevron
                  stackTrailingOnMobile
                  onClick={() => router.push("/profile/pkm-agent-lab")}
                />
              ) : null}
            </SettingsGroup>

            <SettingsGroup title="Session">
              <SettingsRow
                icon={LogOut}
                title="Sign out"
                description="End this session on the current device."
                tone="destructive"
                chevron
                onClick={() => void handleSignOut()}
              />
            </SettingsGroup>
          </div>
        </SurfaceStack>
      </AppPageContentRegion>
    </>
  );

  return (
    <AppPageShell
      data-testid="profile-primary"
      as="div"
      width="reading"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/profile",
        marker: "native-route-profile",
        authState: user ? "authenticated" : "pending",
        dataState: authLoading ? "loading" : "loaded",
      }}
    >
      <ProfileStackNavigator rootContent={profileRootContent} entries={profileStackEntries} />

      {hasVault === true && (
        <VaultUnlockDialog
          user={user}
          open={showVaultUnlock}
          onOpenChange={handleVaultUnlockOpenChange}
          title={unlockDialogTitle}
          description={unlockDialogDescription}
          onSuccess={() => {
            vaultUnlockCompletingRef.current = true;
            setShowVaultUnlock(false);
            if (vaultUnlockReason === "delete_account") {
              setTimeout(() => setShowDeleteConfirm(true), 300);
              setTimeout(() => {
                vaultUnlockCompletingRef.current = false;
              }, 0);
              return;
            }
            if (pendingProfileTarget) {
              updateProfileView(
                {
                  panel: pendingProfileTarget.panel,
                  detail: pendingProfileTarget.detail,
                },
                pendingProfileTarget.mode
              );
              setPendingProfileTarget(null);
            }
            setTimeout(() => {
              vaultUnlockCompletingRef.current = false;
            }, 0);
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
