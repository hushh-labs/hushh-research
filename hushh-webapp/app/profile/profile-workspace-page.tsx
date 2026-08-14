"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bug,
  CodeXml,
  Code2,
  ContactRound,
  ExternalLink,
  Fingerprint,
  Folder,
  KeyRound,
  LifeBuoy,
  Loader2,
  LogOut,
  Mail,
  MapPin,
  MessageCircleQuestion,
  Monitor,
  Phone,
  Palette,
  RefreshCw,
  SendHorizontal,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  User,
  UserRound,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
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
} from "@/components/profile/pkm-data-manager";
import {
  ProfileStackNavigator,
  type ProfileStackEntry,
} from "@/components/profile/profile-stack-navigator";
import { ProfileKaiPreferencesPanel } from "@/components/profile/profile-kai-preferences-panel";
import { GeminiLogo } from "@/components/brand/gemini-logo";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { ThemeToggleLean } from "@/components/theme-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ProfileAvatarEditor } from "@/components/profile/profile-avatar-editor";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { useAuth } from "@/hooks/use-auth";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import { isPkmDeveloperHost } from "@/app/one/pkm/developer-visibility";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";
import {
  DELETE_ACCOUNT_DIALOG_DESCRIPTION,
  DELETE_ACCOUNT_DIALOG_TITLE,
  executeVerifiedAccountDeletion,
  resolveDeleteAccountAuth,
} from "@/lib/flows/delete-account";
import { ROUTES } from "@/lib/navigation/routes";
import { WALLET_CARD_COPY } from "@/components/wallet-card/wallet-card-copy";
import { isWalletCardEntryEnabled } from "@/components/wallet-card/wallet-card-entry";
import {
  buildCanonicalProfileRouteFromLegacyQuery,
  buildProfileRoute,
  resolveProfileRouteState,
  type ProfileDetail,
  type ProfilePanel,
} from "@/lib/navigation/profile-routes";
import {
  resolveGmailConnectionPresentation,
  resolveGmailStatusSummary,
  sanitizeGmailUserMessage,
} from "@/lib/profile/mail-flow";
import { usePersonaState } from "@/lib/persona/persona-context";
import { Icon } from "@/lib/morphy-ux/ui";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { AccountService } from "@/lib/services/account-service";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
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
  isConsumerVisiblePkmDomain,
} from "@/lib/profile/pkm-profile-presentation";
import {
  buildPkmSectionPreviewPresentation,
  type PkmSectionPreviewEntity,
  type PkmSectionPreviewPresentation,
} from "@/lib/profile/pkm-section-preview";
import { loadProfilePkmMetadataForVaultState } from "@/lib/profile/profile-pkm-metadata-policy";
import { applySlicePosture } from "@/lib/personal-knowledge-model/slice-publishing";
import { maskPhoneNumber } from "@/lib/services/phone-mandate-service";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import { VaultService, type VaultWrapper } from "@/lib/services/vault-service";
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
  type PkmVisibilityPosture,
  type PkmUpgradeDomainState,
} from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  PKM_UPGRADE_COMPLETED_EVENT,
  type PkmUpgradeCompletedEventDetail,
} from "@/lib/services/pkm-upgrade-orchestrator";
import { useVault } from "@/lib/vault/vault-context";
import { resolveVaultAvailabilityState } from "@/lib/vault/vault-access-policy";
import { useConsentActions } from "@/lib/consent";
import { useAccent, writeAccent, type AppAccent } from "@/lib/theme/accent";

type FinancialContextCategory =
  "general" | "portfolio" | "risk" | "kyc" | "tax" | "documents";

const PROFILE_LABELS = {
  account: "Your account",
  preferences: "Appearance & preferences",
  security: "Security & privacy",
  support: "Help & feedback",
  developerTools: "Developer tools",
  accountAccess: "Account access",
  setup: "Set up One",
} as const;

/**
 * Read once at module scope: `NEXT_PUBLIC_*` is inlined at build time, so this
 * cannot change across renders and does not belong in state or a memo.
 */
const walletCardEntryEnabled = isWalletCardEntryEnabled();

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
  visibilityPosture: PkmVisibilityPosture,
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
        String(projection.top_level_scope_path || "").trim() ===
        target.topLevelScopePath;
      if (!matchesHandle && !matchesPath) {
        return entry;
      }
      updated = true;
      return {
        ...entry,
        exposure_enabled: visibilityPosture !== "private",
        visibility_posture: visibilityPosture,
        default_projection_ready: false,
        default_projection_updated_at: null,
      };
    });
  }

  if (!updated && Array.isArray(nextManifest.top_level_scope_paths)) {
    updated = nextManifest.top_level_scope_paths.includes(
      target.topLevelScopePath,
    );
  }

  return updated ? nextManifest : manifest;
}

function buildPkmEntityDeletionCandidate(
  topLevelScopePath: string,
  entityKey: string,
): Record<string, unknown> {
  const segments = topLevelScopePath
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const root: Record<string, unknown> = {};
  let current = root;

  for (const segment of segments) {
    const next: Record<string, unknown> = {};
    current[segment] = next;
    current = next;
  }

  current.entities = {
    [entityKey]: {
      entity_id: entityKey,
      status: "deleted",
    },
  };

  return root;
}

const SUPPORT_KIND_COPY: Record<
  SupportMessageKind,
  { title: string; description: string; subject: string }
> = {
  bug_report: {
    title: "Report a bug",
    description: "Tell us what broke.",
    subject: "Bug report",
  },
  support_request: {
    title: "Contact support",
    description: "Get help with One.",
    subject: "Support request",
  },
  developer_reachout: {
    title: "Reach the developer",
    description: "Send product feedback.",
    subject: "Developer feedback",
  },
};

function normalizeProfileVaultReturnTo(value: string | null): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (normalized.startsWith(`${ROUTES.ONE_LOCATION}/invite/`)) {
    return normalized;
  }
  return null;
}

function _formatProfileInventoryBadge(
  summary: ReturnType<typeof buildPkmProfileSummaryPresentation> | null,
  params: { loading: boolean; ready: boolean; failed: boolean },
) {
  if (!params.ready) {
    if (params.failed) return "Unavailable";
    return params.loading ? "Loading" : "Checking";
  }
  const itemCount = summary?.totalAttributes ?? 0;
  const sourceCount = summary?.totalSourceCount ?? 0;
  return `${itemCount} items · ${sourceCount} sources`;
}

function _formatProfileAccessBadge(params: {
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
      <svg
        className="h-4 w-4 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
      >
        <path d="M17.05 20.28c-.98.95-2.05.88-3.08.38-1.07-.52-2.07-.51-3.2 0-1.01.43-2.1.49-2.98-.38C5.22 17.63 2.7 12 5.45 8.04c1.47-2.09 3.8-2.31 5.33-1.18 1.1.75 3.3.73 4.45-.04 2.1-1.31 3.55-.95 4.5 1.14-.15.08.2.14 0 .2-2.63 1.34-3.35 6.03.95 7.84-.46 1.4-1.25 2.89-2.26 4.4l-.07.08-.05-.2zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.17 2.22-1.8 4.19-3.74 4.25z" />
      </svg>
    );
  }

  return <Icon icon={User} size="xs" className="shrink-0" />;
}

function readableMethod(method: VaultMethod | null): string {
  if (method === "generated_default_native_biometric")
    return "Device biometric";
  if (method === "generated_default_native_passkey_prf") return "Passkey";
  if (method === "generated_default_web_prf") return "Passkey";
  if (method === "passphrase") return "Passphrase";
  return "Unknown";
}

function readableQuickMethod(method: VaultMethod | null): string {
  if (method === "generated_default_native_biometric")
    return "device biometric";
  if (method === "generated_default_native_passkey_prf") return "passkey";
  if (method === "generated_default_web_prf") return "passkey";
  return "quick unlock";
}

function isPasskeyVaultMethod(method: VaultMethod | null): boolean {
  return (
    method === "generated_default_web_prf" ||
    method === "generated_default_native_passkey_prf"
  );
}

const VAULT_INLINE_CONTROL_CLASS =
  "inline-flex h-8 w-[7.5rem] items-center justify-center whitespace-nowrap rounded-full px-3 text-xs font-medium";
const VAULT_INLINE_BADGE_CLASS =
  "inline-flex h-8 w-[7.5rem] items-center justify-center whitespace-nowrap rounded-full px-3 text-xs font-medium";

function vaultWrapperKey(
  wrapper: Pick<VaultWrapper, "method" | "wrapperId">,
): string {
  return `${wrapper.method}:${wrapper.wrapperId ?? "default"}`;
}

function formatPasskeyIdentifier(wrapper: VaultWrapper): string {
  const raw = wrapper.passkeyCredentialId || wrapper.wrapperId || "";
  if (!raw) return "Identifier unavailable";
  const compact = raw.replace(/\s+/g, "");
  if (compact.length <= 10) return `Identifier ${compact}`;
  return `Identifier ending ${compact.slice(-6)}`;
}

function formatPasskeyLabel(wrapper: VaultWrapper): string {
  if (wrapper.passkeyDeviceLabel) return wrapper.passkeyDeviceLabel;
  if (wrapper.passkeyProvider === "webauthn_prf") return "Browser passkey";
  if (wrapper.passkeyProvider === "native_passkey") return "Device passkey";
  return "Saved passkey";
}

function describePasskeyWrapper(wrapper: VaultWrapper): string {
  const parts = [formatPasskeyLabel(wrapper), formatPasskeyIdentifier(wrapper)];
  return parts.join(" / ");
}

function VaultComingSoonLogos() {
  return (
    <div className="flex items-center gap-1.5">
      <span className="grid h-7 w-7 place-items-center rounded-full border border-border/70 bg-background/70 text-muted-foreground">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 7a4 4 0 1 0-3.3 3.94L7 15.64V18h2.36l1.36-1.36H13v-2.28l2.06-2.06A4 4 0 0 0 15 7Z" />
          <path d="M15 7h.01" />
        </svg>
      </span>
      <span className="grid h-7 w-7 place-items-center rounded-full border border-border/70 bg-background/70 text-muted-foreground">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3a5 5 0 0 0-5 5v2" />
          <path d="M7 10h10a2 2 0 0 1 2 2v7H5v-7a2 2 0 0 1 2-2Z" />
          <path d="M9 15h6" />
        </svg>
      </span>
      <Badge variant="secondary" className={VAULT_INLINE_BADGE_CLASS}>
        Coming soon
      </Badge>
    </div>
  );
}

function profileRouteRequiresUnlockedVault(
  panel: ProfilePanel | null,
  detail: ProfileDetail | null,
): boolean {
  if (
    panel === "my-data" ||
    panel === "access" ||
    panel === "connected-systems" ||
    panel === "gmail"
  ) {
    return true;
  }
  if (panel === "security") {
    return true;
  }
  return (
    panel === "preferences" &&
    (detail === "kai-preferences" || detail === "gemini")
  );
}

function profileRouteNeedsWorkspaceData(panel: ProfilePanel | null): boolean {
  return panel === "my-data" || panel === "access";
}

function ProfilePageContent() {
  const [canShowPkmAgentLab, setCanShowPkmAgentLab] = useState(false);
  const appAccent = useAccent();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();

  useEffect(() => {
    setCanShowPkmAgentLab(
      process.env.NODE_ENV === "development" &&
        isPkmDeveloperHost(window.location.hostname),
    );
  }, []);

  const {
    user,
    loading: authLoading,
    phoneNumber,
    signOut,
    startPhoneVerification,
    confirmPhoneVerification,
    startPhoneReplacement,
    confirmPhoneReplacement,
  } = useAuth();
  const { personaState, refresh: refreshPersonaState } = usePersonaState();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const pendingConsents = useConsentPendingSummaryCount();
  const { registerSteps, completeStep, reset } = useStepProgress();

  const [showVaultUnlock, setShowVaultUnlock] = useState(false);

  const [vaultUnlockReason, setVaultUnlockReason] = useState<
    "profile_data" | "delete_account" | "reset_account"
  >("profile_data");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [pendingProfileTarget, setPendingProfileTarget] = useState<{
    panel: ProfilePanel;
    detail: ProfileDetail | null;
    mode: "push" | "replace";
  } | null>(null);
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [showVaultCreation, setShowVaultCreation] = useState(false);
  const [pkmMetadata, setPkmMetadata] =
    useState<PersonalKnowledgeModelMetadata | null>(null);
  const [loadingPkmMetadata, setLoadingPkmMetadata] = useState(false);
  const [pkmError, setPkmError] = useState<string | null>(null);
  const [domainManifests, setDomainManifests] = useState<
    Record<string, DomainManifest | null | undefined>
  >({});
  const [loadingDomainManifests, setLoadingDomainManifests] = useState<
    Record<string, boolean>
  >({});
  const [domainManifestErrors, setDomainManifestErrors] = useState<
    Record<string, string | null>
  >({});
  const [pendingPermissionToggles, setPendingPermissionToggles] = useState<
    Record<string, boolean>
  >({});
  const [domainPreview, setDomainPreview] = useState<{
    open: boolean;
    permissionKey: string | null;
    domainKey: string | null;
    topLevelScopePath: string | null;
    title: string;
    description: string;
    presentation: PkmSectionPreviewPresentation | null;
    loading: boolean;
    error: string | null;
    deletingEntityKey: string | null;
  }>({
    open: false,
    permissionKey: null,
    domainKey: null,
    topLevelScopePath: null,
    title: "",
    description: "",
    presentation: null,
    loading: false,
    error: null,
    deletingEntityKey: null,
  });
  const [consentCenter, setConsentCenter] =
    useState<ConsentCenterResponse | null>(null);
  const [loadingConsentCenter, setLoadingConsentCenter] = useState(false);
  const [consentCenterError, setConsentCenterError] = useState<string | null>(
    null,
  );
  const [initialized, setInitialized] = useState(false);
  const [vaultMethod, setVaultMethod] = useState<VaultMethod | null>(null);
  const [capabilityMatrix, setCapabilityMatrix] =
    useState<VaultCapabilityMatrix | null>(null);
  const [enrolledVaultWrappers, setEnrolledVaultWrappers] = useState<
    VaultWrapper[]
  >([]);
  const [primaryVaultWrapperId, setPrimaryVaultWrapperId] = useState<
    string | null
  >(null);
  const [availableQuickMethod, setAvailableQuickMethod] =
    useState<VaultMethod | null>(null);
  const [availableQuickWrapperId, setAvailableQuickWrapperId] = useState<
    string | null
  >(null);
  const [effectiveVaultMethod, setEffectiveVaultMethod] =
    useState<VaultMethod | null>(null);
  const [loadingVaultMethod, setLoadingVaultMethod] = useState(false);
  const [switchingVaultMethod, setSwitchingVaultMethod] = useState(false);
  const [passphraseDialogOpen, setPassphraseDialogOpen] = useState(false);
  const [passkeyRemovalTarget, setPasskeyRemovalTarget] =
    useState<VaultWrapper | null>(null);
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [marketplaceOptIn, setMarketplaceOptIn] = useState(false);
  const [loadingMarketplaceOptIn, setLoadingMarketplaceOptIn] = useState(true);
  const [savingMarketplaceOptIn, setSavingMarketplaceOptIn] = useState(false);
  // Contact discoverability defaults ON, so the optimistic initial value is
  // true; a user who has opted out sees the toggle settle once the fetch lands.
  const [contactDiscoverable, setContactDiscoverable] = useState(true);
  const [loadingContactDiscoverable, setLoadingContactDiscoverable] =
    useState(true);
  const [savingContactDiscoverable, setSavingContactDiscoverable] =
    useState(false);
  const [supportKind, setSupportKind] =
    useState<SupportMessageKind>("support_request");
  const [supportSubject, setSupportSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [sendingSupportMessage, setSendingSupportMessage] = useState(false);
  const [gmailActionBusy, setGmailActionBusy] = useState<
    "connect" | "disconnect" | "sync" | null
  >(null);
  const [savingFinancialContext, setSavingFinancialContext] = useState(false);
  const [financialContextText, setFinancialContextText] = useState("");
  const [financialContextCategory, setFinancialContextCategory] =
    useState<FinancialContextCategory>("general");
  const [editingFinancialContextId, setEditingFinancialContextId] = useState<
    string | null
  >(null);
  const vaultUnlockCompletingRef = useRef(false);

  const legacyProfileRedirectHref = useMemo(
    () => buildCanonicalProfileRouteFromLegacyQuery(pathname, searchParams),
    [pathname, searchParams],
  );
  const profileRouteState = useMemo(
    () => resolveProfileRouteState(pathname, searchParams),
    [pathname, searchParams],
  );
  const activePanel = profileRouteState.panel;
  const activeDetail = profileRouteState.detail;
  const profileNativeRouteId = useMemo(
    () =>
      pathname === ROUTES.PROFILE || pathname.startsWith(`${ROUTES.PROFILE}/`)
        ? pathname
        : ROUTES.PROFILE,
    [pathname],
  );
  const shouldLoadProfileWorkspaceData =
    profileRouteNeedsWorkspaceData(activePanel);
  const shouldRequestVaultUnlock = searchParams.get("unlock_vault") === "1";
  const vaultReturnTo = normalizeProfileVaultReturnTo(
    searchParams.get("return_to"),
  );
  const vaultReturnToRef = useRef<string | null>(vaultReturnTo);
  useEffect(() => {
    if (vaultReturnTo) {
      vaultReturnToRef.current = vaultReturnTo;
    }
  }, [vaultReturnTo]);
  useScrollReset(
    `${pathname}:${activePanel ?? "root"}:${activeDetail ?? "root"}`,
    {
      enabled: true,
      behavior: "auto",
    },
  );

  useEffect(() => {
    if (!legacyProfileRedirectHref) return;
    router.replace(legacyProfileRedirectHref, { scroll: false });
  }, [legacyProfileRedirectHref, router]);

  const provider = getProvider(user);
  const gmailRouteHref = searchParamsString
    ? `${pathname}?${searchParamsString}`
    : pathname;
  const gmail = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: Boolean(user?.uid) && !authLoading && activePanel === "gmail",
    idTokenProvider: user?.getIdToken ? () => user.getIdToken() : null,
    routeHref: gmailRouteHref,
    refreshKey: gmailRouteHref,
  });
  const gmailActionsBusy =
    gmail.refreshingStatus || gmail.syncingRun || gmailActionBusy !== null;
  const vaultAccess = useMemo(
    () =>
      resolveVaultAvailabilityState({
        hasVault,
        isVaultUnlocked,
        vaultKey,
        vaultOwnerToken,
      }),
    [hasVault, isVaultUnlocked, vaultKey, vaultOwnerToken],
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
    [gmail.loadingStatus, gmail.status, gmail.statusError, gmailActionBusy],
  );
  const upgradeStatesByDomain = useMemo<Record<string, PkmUpgradeDomainState>>(
    () =>
      Object.fromEntries(
        (pkmMetadata?.upgradableDomains || []).map((entry) => [
          entry.domain,
          entry,
        ]),
      ),
    [pkmMetadata?.upgradableDomains],
  );

  const domainPresentations = useMemo(
    () =>
      (pkmMetadata?.domains || [])
        .filter(isConsumerVisiblePkmDomain)
        .map((domain) =>
          buildPkmDomainPresentation({
            domain,
            activeGrants: consentCenter?.active_grants || [],
            manifest: domainManifests[domain.key],
            upgradeState: upgradeStatesByDomain[domain.key] || null,
          }),
        ),
    [
      consentCenter?.active_grants,
      domainManifests,
      pkmMetadata?.domains,
      upgradeStatesByDomain,
    ],
  );

  const pkmMetadataReady = pkmMetadata !== null;
  const consentCenterReady = consentCenter !== null;

  const profileSummary = useMemo(
    () =>
      buildPkmProfileSummaryPresentation({
        metadata: pkmMetadata,
        domains: domainPresentations,
        activeGrants: consentCenter?.active_grants || [],
        pendingRequestCount: pendingConsents ?? 0,
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
    ],
  );

  const accessConnections = useMemo(
    () => buildPkmAccessConnections(domainPresentations),
    [domainPresentations],
  );

  const selectedDomain = useMemo(() => {
    if (activePanel !== "my-data" || !activeDetail?.startsWith("domain:"))
      return null;
    const domainKey = activeDetail.slice("domain:".length);
    return (
      domainPresentations.find((domain) => domain.key === domainKey) || null
    );
  }, [activeDetail, activePanel, domainPresentations]);

  const selectedDomainMetadata = useMemo(() => {
    if (!selectedDomain) return null;
    return (
      (pkmMetadata?.domains || []).find(
        (domain) => domain.key === selectedDomain.key,
      ) || null
    );
  }, [pkmMetadata?.domains, selectedDomain]);

  const selectedDomainManifest = selectedDomain
    ? (domainManifests[selectedDomain.key] ?? null)
    : null;
  const selectedDomainUpgrade = useMemo(() => {
    if (!selectedDomain || !selectedDomainMetadata) return null;
    if (vaultAccess.needsUnlock && hasVault) {
      return {
        status: "updating" as const,
        label: "Unlock required",
        description:
          "These details stay readable while locked. Unlock the vault to manage section-level sharing controls.",
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
        domainKey: null,
        topLevelScopePath: null,
        title: "",
        description: "",
        presentation: null,
        loading: false,
        error: null,
        deletingEntityKey: null,
      };
    });
  }, [selectedDomain?.key]);

  const selectedConnection = useMemo(() => {
    if (activePanel !== "access" || !activeDetail?.startsWith("connection:"))
      return null;
    const connectionId = activeDetail.slice("connection:".length);
    return (
      accessConnections.find((connection) => connection.id === connectionId) ||
      null
    );
  }, [accessConnections, activeDetail, activePanel]);

  const updateProfileView = useMemo(
    () =>
      (
        next: {
          panel?: ProfilePanel | null;
          detail?: ProfileDetail | null;
        },
        mode: "push" | "replace" = "push",
      ) => {
        // Preserve only the `from` origin marker (not transient vault/return
        // keys, which must not re-fire while drilling panels) so the shared
        // top-bar back control can retrace to wherever Profile was opened from,
        // even after Profile → panel → detail → back all the way out.
        const originFrom = searchParams.get("from");
        const originParams = originFrom
          ? new URLSearchParams({ from: originFrom })
          : undefined;
        const href = buildProfileRoute({
          panel: typeof next.panel === "undefined" ? activePanel : next.panel,
          detail:
            typeof next.detail === "undefined" ? activeDetail : next.detail,
          searchParams: originParams,
        });
        if (mode === "push") {
          router.push(href, { scroll: false });
        } else {
          router.replace(href, { scroll: false });
        }
      },
    [activeDetail, activePanel, router, searchParams],
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
      setEnrolledVaultWrappers(vaultState.wrappers);
      setPrimaryVaultWrapperId(vaultState.primaryWrapperId ?? "default");
      setAvailableQuickMethod(quickWrapper?.method ?? null);
      setAvailableQuickWrapperId(quickWrapper?.wrapperId ?? null);
      setEffectiveVaultMethod(nextEffectiveMethod);
    } catch (error) {
      console.warn("[ProfilePage] Failed to resolve vault method:", error);
      setVaultMethod(null);
      setEnrolledVaultWrappers([]);
      setPrimaryVaultWrapperId(null);
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
      setEnrolledVaultWrappers([]);
      setPrimaryVaultWrapperId(null);
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
    if (!user) {
      setContactDiscoverable(true);
      setLoadingContactDiscoverable(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const result = await RiaService.getContactDiscoverability(idToken);
        if (!cancelled) {
          setContactDiscoverable(Boolean(result.contact_discoverable));
        }
      } catch (error) {
        // Leave the default in place; a failed read must not silently present
        // the user as opted out when they are not.
        console.error(
          "[ProfilePage] Failed to load contact discoverability:",
          error,
        );
      } finally {
        if (!cancelled) setLoadingContactDiscoverable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);


  const refreshPkmMetadata = useCallback(
    async (force = false) => {
      if (!user?.uid || hasVault === null) return;
      const metadata = await loadProfilePkmMetadataForVaultState({
        userId: user.uid,
        hasVault,
        force,
        vaultOwnerToken,
      });
      setPkmMetadata(metadata);
      setPkmError(null);
      if (!hasVault) {
        setDomainManifests({});
        setDomainManifestErrors({});
        setLoadingDomainManifests({});
      }
      return metadata;
    },
    [hasVault, user?.uid, vaultOwnerToken],
  );

  const refreshDomainManifest = useCallback(
    async (domainKey: string, force = false) => {
      if (!user?.uid || !vaultOwnerToken) return null;
      setLoadingDomainManifests((current) => ({
        ...current,
        [domainKey]: true,
      }));
      try {
        const manifest = await PersonalKnowledgeModelService.getDomainManifest(
          user.uid,
          domainKey,
          vaultOwnerToken,
          force,
        );
        setDomainManifests((current) => ({
          ...current,
          [domainKey]: manifest,
        }));
        setDomainManifestErrors((current) => ({
          ...current,
          [domainKey]: null,
        }));
        return manifest;
      } catch (_error) {
        const message = "Couldn't load sharing controls for these details.";
        setDomainManifestErrors((current) => ({
          ...current,
          [domainKey]: message,
        }));
        return null;
      } finally {
        setLoadingDomainManifests((current) => ({
          ...current,
          [domainKey]: false,
        }));
      }
    },
    [user?.uid, vaultOwnerToken],
  );

  const refreshVisibleDomainManifests = useCallback(
    async (force = false) => {
      if (!user?.uid || !vaultOwnerToken) return;
      const domainKeys = (pkmMetadata?.domains || [])
        .filter(isConsumerVisiblePkmDomain)
        .map((domain) => domain.key);
      if (domainKeys.length === 0) return;
      await Promise.all(
        domainKeys.map((domainKey) => refreshDomainManifest(domainKey, force)),
      );
    },
    [pkmMetadata?.domains, refreshDomainManifest, user?.uid, vaultOwnerToken],
  );

  useEffect(() => {
    if (!user?.uid || !shouldLoadProfileWorkspaceData) return;

    const handleUpgradeCompleted = (event: Event) => {
      const detail = (event as CustomEvent<PkmUpgradeCompletedEventDetail>)
        .detail;
      if (detail?.userId !== user.uid) {
        return;
      }

      void (async () => {
        setLoadingPkmMetadata(true);
        try {
          const nextMetadata = await refreshPkmMetadata(true);
          if (
            vaultOwnerToken &&
            !vaultAccess.needsVaultCreation &&
            !vaultAccess.needsUnlock
          ) {
            const domainKeys = (nextMetadata?.domains || [])
              .filter(isConsumerVisiblePkmDomain)
              .map((domain) => domain.key);
            await Promise.all(
              domainKeys.map((domainKey) =>
                refreshDomainManifest(domainKey, true),
              ),
            );
          }
        } catch (error) {
          console.warn(
            "[ProfilePage] Failed to refresh PKM after upgrade completion.",
            error,
          );
        } finally {
          setLoadingPkmMetadata(false);
        }
      })();
    };

    window.addEventListener(
      PKM_UPGRADE_COMPLETED_EVENT,
      handleUpgradeCompleted,
    );
    return () => {
      window.removeEventListener(
        PKM_UPGRADE_COMPLETED_EVENT,
        handleUpgradeCompleted,
      );
    };
  }, [
    refreshPkmMetadata,
    refreshDomainManifest,
    shouldLoadProfileWorkspaceData,
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
    [user],
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
      if (!shouldLoadProfileWorkspaceData) {
        setLoadingPkmMetadata(false);
        setLoadingConsentCenter(false);
        return;
      }

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
          loadProfilePkmMetadataForVaultState({
            userId: user.uid,
            hasVault,
            force: false,
            vaultOwnerToken,
          }),
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
        if (!hasVault) {
          setDomainManifests({});
          setDomainManifestErrors({});
          setLoadingDomainManifests({});
        }
        completeStep();
      } catch (error) {
        console.error("Failed to load profile manager data:", error);
        if (!cancelled) {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to load profile knowledge view.";
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
    shouldLoadProfileWorkspaceData,
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

    // Resolve auth first so a vault-unlock requirement is handled as a guard
    // (not as a failed delete). Only the real delete-and-ack work is wrapped in
    // the branded promise toast.
    let resolution: Awaited<ReturnType<typeof resolveDeleteAccountAuth>>;
    try {
      resolution = await resolveDeleteAccountAuth({
        userId: user.uid,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });
    } catch (error) {
      console.error("Delete account auth error:", error);
      morphyToast.error("Failed to delete account. Please try again.");
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      return;
    }

    if (resolution.kind === "needs_unlock") {
      morphyToast.info(
        "Please unlock your vault first to delete your account.",
      );
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setVaultUnlockReason("delete_account");
      setShowVaultUnlock(true);
      return;
    }

    setHasVault(resolution.hasVault);

    // Branded actionable loading: the Sonner toast stays in its loading state
    // while the delete promise runs and only resolves once the backend ack and
    // local cleanup complete.
    const token = resolution.token;
    try {
      await morphyToast
        .promise(
          (async () => {
            await executeVerifiedAccountDeletion({
              userId: user.uid,
              vaultOwnerToken: token,
            });
          })(),
          {
            loading: "Deleting your account...",
            success: "Account deleted.",
            error: "Failed to delete account. Please try again.",
            variant: "destructive",
          },
        )
        .unwrap();

      // No artificial delay: the success toast already conveyed completion, and
      // FCM cleanup is skipped because the backend has already destroyed the
      // account and its push tokens. Redirect as fast as the session teardown
      // allows.
      await signOut({ skipFcmCleanup: true });
    } catch (error) {
      console.error("Delete account error:", error);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleDeleteClick = async () => {
    if (!user) return;

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

  const handleResetAccount = async () => {
    if (!user) return;

    setIsResetting(true);

    let resolution: Awaited<ReturnType<typeof resolveDeleteAccountAuth>>;
    try {
      resolution = await resolveDeleteAccountAuth({
        userId: user.uid,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });
    } catch (error) {
      console.error("Reset account auth error:", error);
      morphyToast.error("Failed to reset account. Please try again.");
      setIsResetting(false);
      setShowResetConfirm(false);
      return;
    }

    if (resolution.kind === "needs_unlock") {
      morphyToast.info("Please unlock your vault first to reset your account.");
      setIsResetting(false);
      setShowResetConfirm(false);
      setVaultUnlockReason("reset_account");
      setShowVaultUnlock(true);
      return;
    }

    setHasVault(resolution.hasVault);

    // Branded actionable loading: keep the toast in its loading state until the
    // reset has been acknowledged and local state has been cleared.
    try {
      await morphyToast
        .promise(
          (async () => {
            await AccountService.resetAccount(resolution.token);

            CacheSyncService.onAccountDeleted(user.uid);
            await UserLocalStateService.clearForUser(user.uid);
            await refreshPersonaState({ force: true });

            // Reset returns the account to a fresh, just-onboarded state: keep
            // the identity and vault, but re-run onboarding on the next visit.
            setOnboardingRequiredCookie(true);
            setOnboardingFlowActiveCookie(true);
          })(),
          {
            loading: "Resetting your account...",
            success: "Account reset. Restarting onboarding...",
            error: "Failed to reset account. Please try again.",
            variant: "destructive",
          },
        )
        .unwrap();

      await new Promise((resolve) => setTimeout(resolve, 1200));
      router.replace(ROUTES.ONE_SETUP);
    } catch (error) {
      console.error("Reset account error:", error);
    } finally {
      setIsResetting(false);
      setShowResetConfirm(false);
    }
  };

  const handleResetClick = async () => {
    if (!user) return;

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
      setShowResetConfirm(true);
      return;
    }

    if (vaultAccess.canMutateSecureData) {
      setShowResetConfirm(true);
    } else {
      requestVaultUnlock("reset_account");
    }
  };

  const handleContactDiscoverableToggle = async () => {
    if (!user) return;
    const next = !contactDiscoverable;
    try {
      setSavingContactDiscoverable(true);
      const idToken = await user.getIdToken();
      const result = await RiaService.setContactDiscoverability(idToken, next);
      setContactDiscoverable(Boolean(result.contact_discoverable));
      toast.success(
        result.contact_discoverable
          ? "People who have your number can find you on Hussh."
          : "You are hidden from contact sync.",
      );
    } catch (error) {
      console.error(
        "[ProfilePage] Failed to update contact discoverability:",
        error,
      );
      toast.error("Could not update contact discoverability.");
    } finally {
      setSavingContactDiscoverable(false);
    }
  };

  const handleMarketplaceOptInToggle = async () => {
    if (!user) return;
    try {
      setSavingMarketplaceOptIn(true);
      const idToken = await user.getIdToken();
      const result = await RiaService.setInvestorMarketplaceOptIn(
        idToken,
        !marketplaceOptIn,
      );
      setMarketplaceOptIn(Boolean(result.investor_marketplace_opt_in));
      CacheSyncService.onMarketplaceVisibilityChanged(user.uid);
      await refreshPersonaState({ force: true });
      toast.success(
        result.investor_marketplace_opt_in
          ? "Investor marketplace profile is now discoverable."
          : "Investor marketplace profile is now hidden.",
      );
    } catch (error) {
      console.error(
        "[ProfilePage] Failed to update marketplace opt-in:",
        error,
      );
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
      "push",
    );
  }

  function requestVaultUnlock(
    reason:
      "profile_data" | "delete_account" | "reset_account" = "profile_data",
  ) {
    setVaultUnlockReason(reason);
    setShowVaultUnlock(true);
  }

  function openVaultBackedPanel(
    panel: Extract<
      ProfilePanel,
      "my-data" | "access" | "connected-systems" | "gmail" | "security"
    >,
  ) {
    if (vaultAccess.needsVaultCreation && panel !== "security") {
      setShowVaultCreation(true);
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
          : `Sent to ${result.recipient}.`,
      );
      updateProfileView({ panel: "support", detail: null }, "replace");
      setSupportMessage("");
    } catch (error) {
      console.error("[ProfilePage] Failed to send support message:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We couldn't send your message right now.",
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
      const isGoogleProvider = provider.id === "google";

      const payload = await GmailReceiptsService.startConnect({
        idToken,
        userId: user.uid,
        loginHint: isGoogleProvider ? user.email : null,
        includeGrantedScopes: isGoogleProvider,
      });

      if (!payload.configured || !payload.authorize_url) {
        throw new Error("Gmail OAuth is not configured for this environment.");
      }
      assignWindowLocation(payload.authorize_url);
    } catch (error) {
      const message = sanitizeGmailUserMessage(error, {
        fallback:
          "We couldn't start Gmail connection right now. Please try again in a moment.",
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
        fallback:
          "We couldn't disconnect Gmail right now. Please try again in a moment.",
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
        fallback:
          "We couldn't sync your receipts. Please try again in a moment.",
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
        displayName: user.displayName || user.email || "Hussh User",
        targetMethod,
      });

      setVaultMethod(result.method);
      toast.success(
        `Vault method updated to ${readableMethod(result.method)}.`,
      );
      await refreshVaultMethodState(user.uid);
    } catch (error) {
      console.error("[ProfilePage] Failed to switch vault method:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We could not update your unlock preference.",
      );
    } finally {
      setSwitchingVaultMethod(false);
    }
  }

  async function setQuickMethodAsDefault(
    targetMethod: VaultMethod,
    wrapperId?: string | null,
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
        wrapperId ?? "default",
      );
      setVaultMethod(targetMethod);
      toast.success(
        `Primary unlock updated to ${readableMethod(targetMethod)}.`,
      );
      await refreshVaultMethodState(user.uid);
    } catch (error) {
      console.error(
        "[ProfilePage] Failed to set quick unlock as default:",
        error,
      );
      toast.error(
        error instanceof Error
          ? error.message
          : "We could not update your preferred unlock method.",
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
      await VaultService.setPrimaryVaultMethod(
        user.uid,
        "passphrase",
        "default",
      );
      setVaultMethod("passphrase");
      toast.success("Primary unlock updated to passphrase.");
      await refreshVaultMethodState(user.uid);
    } catch (error) {
      console.error("[ProfilePage] Failed to prefer passphrase unlock:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We could not update your preferred unlock method.",
      );
    } finally {
      setSwitchingVaultMethod(false);
    }
  }

  async function removePasskeyWrapper(wrapper: VaultWrapper) {
    if (!user?.uid) return;

    if (!vaultAccess.canMutateSecureData || !vaultKey) {
      toast.info("Unlock your vault to remove a passkey.");
      requestVaultUnlock("profile_data");
      return;
    }
    if (!vaultOwnerToken) {
      toast.info("Unlock your vault to remove a passkey.");
      requestVaultUnlock("profile_data");
      return;
    }

    setSwitchingVaultMethod(true);
    try {
      const result = await VaultMethodService.removeMethod({
        userId: user.uid,
        currentVaultKey: vaultKey,
        vaultOwnerToken,
        method: wrapper.method,
        wrapperId: wrapper.wrapperId ?? "default",
        fallbackPrimaryMethod: "passphrase",
        fallbackPrimaryWrapperId: "default",
      });
      setVaultMethod(result.primaryMethod);
      toast.success("Passkey removed. Passphrase unlock is still available.");
      setPasskeyRemovalTarget(null);
      await refreshVaultMethodState(user.uid);
    } catch (error) {
      console.error("[ProfilePage] Failed to remove passkey wrapper:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "We could not remove this passkey.",
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
          : "We could not update your passphrase.",
      );
    } finally {
      setSwitchingVaultMethod(false);
    }
  }

  const deleteButtonLabel = vaultAccess.needsUnlock
    ? "Unlock to delete account"
    : "Delete account";
  const deleteRowDescription = vaultAccess.needsVaultCreation
    ? "Deletes cloud-linked records."
    : "Deletes your One account.";
  const deleteDialogTitle = DELETE_ACCOUNT_DIALOG_TITLE;
  const deleteDialogDescription = DELETE_ACCOUNT_DIALOG_DESCRIPTION;

  const resetRowDescription =
    "Clears saved details. Keeps sign-in.";
  const resetDialogTitle = "Reset account?";
  const resetDialogDescription =
    "This clears all your saved details: connected services, finance and Gmail, your knowledge base, consents, and saved preferences. It keeps your account, your sign-in, and your vault. You will start onboarding again.";

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
      ? "Unlock to delete"
      : vaultUnlockReason === "reset_account"
        ? "Unlock to reset"
        : "Unlock vault";
  const unlockDialogDescription =
    vaultUnlockReason === "delete_account"
      ? "This permanently removes encrypted records."
      : vaultUnlockReason === "reset_account"
        ? "Saved details reset. Account and vault stay."
        : "Unlock to continue.";

  const displayedUnlockMethod = effectiveVaultMethod ?? vaultMethod;
  const recommendedQuickMethod =
    capabilityMatrix?.recommendedMethod &&
    capabilityMatrix.recommendedMethod !== "passphrase"
      ? capabilityMatrix.recommendedMethod
      : null;
  const quickMethodReadyOnCurrentDevice =
    vaultMethod === "passphrase" && availableQuickMethod
      ? availableQuickMethod
      : null;
  const enrolledPasskeyWrappers = enrolledVaultWrappers.filter((wrapper) =>
    isPasskeyVaultMethod(wrapper.method),
  );
  const passphraseWrapper = enrolledVaultWrappers.find(
    (wrapper) => wrapper.method === "passphrase",
  );
  const activePrimaryWrapperId = primaryVaultWrapperId ?? "default";
  const canSwitchDefaultToPassphrase = Boolean(
    vaultAccess.canMutateSecureData &&
    vaultMethod &&
    vaultMethod !== "passphrase" &&
    passphraseWrapper,
  );
  const canSwitchDefaultToQuick = Boolean(
    vaultAccess.canMutateSecureData &&
    vaultMethod === "passphrase" &&
    quickMethodReadyOnCurrentDevice,
  );
  const defaultUnlockDescription =
    vaultMethod === "passphrase"
      ? "Passphrase opens your vault by default."
      : vaultMethod
        ? `${readableMethod(vaultMethod)} opens your vault by default.`
        : "Default unlock is not set.";
  const canEditKaiPreferences = Boolean(
    user?.uid && vaultAccess.hasVault && vaultAccess.canMutateSecureData,
  );

  const marketplaceStatusText = loadingMarketplaceOptIn
    ? "Checking visibility…"
    : marketplaceOptIn
      ? "Discoverable to RIAs"
      : "Hidden from marketplace search";
  const contactDiscoverableStatusText = loadingContactDiscoverable
    ? "Checking discoverability…"
    : contactDiscoverable
      ? "People with your number can find you"
      : "Hidden from contact sync";
  const phoneSummaryText = phoneNumber
    ? maskPhoneNumber(phoneNumber)
    : "No phone number linked yet";
  const emailVerified = Boolean(user?.emailVerified);

  const gmailStatusLabel = gmailPresentation.badgeLabel;
  const gmailStatusSummary = useMemo(
    () =>
      resolveGmailStatusSummary({
        status: gmail.status,
        loading: gmail.loadingStatus || gmailActionBusy === "sync",
        errorText: gmail.statusError,
      }),
    [gmail.loadingStatus, gmail.status, gmail.statusError, gmailActionBusy],
  );
  const gmailSettingsDescription = gmailPresentation.description;
  const gmailLastSyncText = gmailPresentation.latestSyncText;
  const profileManagerLoading = loadingPkmMetadata || loadingConsentCenter;
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();
  const supportComposeKind =
    activePanel === "support" && activeDetail?.startsWith("support-compose:")
      ? (activeDetail.slice("support-compose:".length) as SupportMessageKind)
      : null;
  const securitySummaryText = vaultAccess.needsVaultCreation
    ? "Vault not created yet"
    : loadingVaultMethod
      ? "Loading methods…"
      : vaultAccess.needsUnlock
        ? "Locked"
        : readableMethod(displayedUnlockMethod);
  const profileVoiceSurfaceMetadata = useMemo(() => {
    const profileHomeControls = [
      {
        id: "profile_my_data",
        label: "Memory",
        purpose: "opens your saved details and sharing controls.",
        role: "card",
        voiceAliases: ["personal knowledge model", "my saved details", "pkm"],
      },
      {
        id: "profile_access",
        label: "Access & sharing",
        purpose: "opens consent-backed access and sharing controls.",
        role: "card",
        voiceAliases: ["access", "sharing", "consent access"],
      },
      {
        id: "profile_security",
        label: PROFILE_LABELS.security,
        purpose: "opens vault, account access, and account deletion controls.",
        actionId: "route.profile_security_panel",
        role: "card",
        voiceAliases: [
          "vault",
          "create your vault",
          "unlock vault",
          "vault security",
        ],
      },
      {
        id: "profile_account",
        label: PROFILE_LABELS.account,
        purpose: "opens account identity, email, and phone management.",
        actionId: "route.profile",
        role: "card",
        voiceAliases: ["account", "phone number", "identity"],
      },
      {
        id: "profile_gmail",
        label: "Gmail receipts",
        purpose: "opens Gmail receipt sync and receipt-memory management.",
        actionId: "route.profile_receipts",
        role: "card",
        voiceAliases: ["gmail receipts", "receipts"],
      },
      {
        id: "profile_support",
        label: PROFILE_LABELS.support,
        purpose: "opens support routing and compose flows.",
        actionId: "route.profile_support_panel",
        role: "card",
        voiceAliases: ["support", "feedback"],
      },
      {
        id: "profile_sign_out",
        label: "Sign out",
        purpose: "signs you out of this device.",
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
              label: PROFILE_LABELS.developerTools,
              purpose: "opens the local developer workspace.",
              actionId: "route.profile_pkm_agent_lab",
              role: "card",
              voiceAliases: ["pkm agent lab", "memory lab"],
            },
          ]
        : []),
    ];
    const preferenceControls = [
      {
        id: "profile_theme",
        label: "Appearance",
        type: "segmented_control",
        purpose:
          "shows the local Light, Dark, and System appearance selector for this app.",
        role: "control",
        voiceAliases: ["theme", "appearance", "dark mode", "light mode"],
      },
    ];
    const controls =
      activePanel === "preferences" ? preferenceControls : profileHomeControls;
    const activeControl =
      controls.find((control) => control.id === activeVoiceControlId) ||
      controls.find((control) => control.id === lastVoiceControlId) ||
      null;
    const visibleModules = activePanel
      ? [
          activePanel === "account"
            ? PROFILE_LABELS.account
            : activePanel === "my-data"
              ? "Memory"
              : activePanel === "access"
                ? "Access & sharing"
                : activePanel === "connected-systems"
                  ? "Connected Systems"
                  : activePanel === "preferences"
                    ? PROFILE_LABELS.preferences
                    : activePanel === "security"
                      ? PROFILE_LABELS.security
                      : activePanel === "gmail"
                        ? "Gmail receipts"
                        : PROFILE_LABELS.support,
          ...(activeDetail ? [activeDetail] : []),
        ]
      : [
          PROFILE_LABELS.account,
          PROFILE_LABELS.preferences,
          PROFILE_LABELS.security,
          PROFILE_LABELS.support,
          ...(canShowPkmAgentLab ? [PROFILE_LABELS.developerTools] : []),
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
          : activePanel === "connected-systems"
            ? [
                "Load Salesforce CRM schema",
                "Read Salesforce CRM record",
                "Propose Salesforce CRM create",
                "Propose Salesforce CRM update",
              ]
            : activePanel === "account"
              ? [phoneNumber ? "Change phone number" : "Add phone number"]
              : activePanel === "preferences"
                ? []
                : activePanel === "security"
                  ? [
                      vaultAccess.needsVaultCreation
                        ? "Create your vault"
                        : "Unlock vault",
                      "Change passphrase",
                      "Delete account",
                    ]
                  : [
                      "Open your account",
                      "Open security & privacy",
                      "Open help & feedback",
                    ];

    return {
      surfaceDefinition: {
        screenId: activePanel ? `profile_${activePanel}` : "profile_home",
        title: activePanel
          ? activePanel === "account"
            ? PROFILE_LABELS.account
            : activePanel === "my-data"
              ? "Memory"
              : activePanel === "access"
                ? "Access & sharing"
                : activePanel === "connected-systems"
                  ? "Connected Systems"
                  : activePanel === "preferences"
                    ? PROFILE_LABELS.preferences
                    : activePanel === "security"
                      ? PROFILE_LABELS.security
                      : activePanel === "gmail"
                        ? "Gmail receipts"
                        : PROFILE_LABELS.support
          : "Profile",
        purpose:
          "This surface manages account details, appearance, help, and vault privacy.",
        sections: [
          {
            id: "account",
            title: PROFILE_LABELS.account,
            purpose: "Email, phone, and sign-in identity.",
          },
          {
            id: "preferences",
            title: PROFILE_LABELS.preferences,
            purpose: "Theme and accent preferences.",
          },
          {
            id: "security",
            title: PROFILE_LABELS.security,
            purpose: "Vault and account access controls.",
          },
          {
            id: "support",
            title: PROFILE_LABELS.support,
            purpose: "Support routing and compose flows.",
          },
        ],
        actions: availableActions.map((action) => ({
          id: action.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
          label: action,
          purpose: `${action} from Profile.`,
        })),
        controls,
        concepts: [],
        activeControlId: activeVoiceControlId,
        lastInteractedControlId: lastVoiceControlId,
      },
      activeSection: activePanel || "profile",
      activeTab: activePanel || "profile",
      visibleModules,
      focusedWidget:
        activeControl?.label || (activeDetail ?? activePanel ?? "Profile"),
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
        pending_consents: pendingConsents ?? 0,
        gmail_connected: gmailPresentation.isConnected,
        gmail_state: gmailPresentation.state,
        gmail_status_label: gmailStatusLabel,
        gmail_status_title: gmailStatusSummary.title,
        gmail_last_sync_text: gmailLastSyncText,
        google_email: gmail.status?.google_email || null,
        pkm_agent_lab_available: canShowPkmAgentLab,
        marketplace_opt_in: marketplaceOptIn,
        security_summary: securitySummaryText,
        phone_verified: Boolean(phoneNumber),
        email_verified: emailVerified,
        preference_voice_actions_available:
          activePanel === "preferences" ? false : null,
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
    phoneNumber,
    profileSummary.totalAttributes,
    profileSummary.totalDomains,
    savingMarketplaceOptIn,
    securitySummaryText,
    sendingSupportMessage,
    showVaultUnlock,
    supportComposeKind,
    switchingVaultMethod,
    emailVerified,
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
      setShowVaultCreation(true);
    }

    router.replace(
      buildProfileRoute({ panel: activePanel, detail: activeDetail }),
      { scroll: false },
    );
  }, [
    activeDetail,
    activePanel,
    authLoading,
    hasVault,
    router,
    shouldRequestVaultUnlock,
  ]);

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
      router.replace(buildProfileRoute({ panel: null, detail: null }), {
        scroll: false,
      });
    }
    requestVaultUnlock("profile_data");
  }, [
    activeDetail,
    activePanel,
    authLoading,
    hasVault,
    router,
    user?.uid,
    vaultAccess.needsUnlock,
  ]);

  if (authLoading || !user) {
    return null;
  }

  const popProfileStack = () => {
    if (activeDetail) {
      updateProfileView({ panel: activePanel, detail: null }, "replace");
      return;
    }
    updateProfileView({ panel: null, detail: null }, "replace");
  };
  const openAccountPanel = () =>
    updateProfileView({ panel: "account", detail: null }, "push");
  const openPreferencesPanel = () =>
    updateProfileView({ panel: "preferences", detail: null }, "push");
  const openSecurityPanel = () => openVaultBackedPanel("security");
  const handlePreviewDomainPermission = async (
    domainKey: string,
    permission: {
      key: string;
      label: string;
      description: string;
      topLevelScopePath: string;
    },
  ) => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return;
    }

    setDomainPreview({
      open: true,
      permissionKey: permission.key,
      domainKey,
      topLevelScopePath: permission.topLevelScopePath,
      title: permission.label,
      description:
        permission.description ||
        `Saved values from ${selectedDomain?.title?.toLowerCase() || domainKey}.`,
      presentation: null,
      loading: true,
      error: null,
      deletingEntityKey: null,
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
        domainKey,
        topLevelScopePath: permission.topLevelScopePath,
        title: permission.label,
        description:
          permission.description ||
          `Saved values from ${selectedDomain?.title?.toLowerCase() || domainKey}.`,
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
        deletingEntityKey: null,
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't load saved values for this section.";
      setDomainPreview((current) => ({
        ...current,
        open: true,
        permissionKey: permission.key,
        domainKey,
        topLevelScopePath: permission.topLevelScopePath,
        title: permission.label,
        description:
          permission.description ||
          `Saved values from ${selectedDomain?.title?.toLowerCase() || domainKey}.`,
        presentation: null,
        loading: false,
        error: message,
        deletingEntityKey: null,
      }));
    }
  };

  const handleDeletePkmPreviewEntity = async (
    entity: PkmSectionPreviewEntity,
  ) => {
    const domainKey = domainPreview.domainKey || selectedDomain?.key || null;
    const topLevelScopePath = domainPreview.topLevelScopePath;
    if (
      !user?.uid ||
      !vaultKey ||
      !vaultOwnerToken ||
      !domainKey ||
      !topLevelScopePath
    ) {
      requestVaultUnlock("profile_data");
      return;
    }

    setDomainPreview((current) => ({
      ...current,
      error: null,
      deletingEntityKey: entity.key,
    }));

    try {
      if (domainKey === "financial" && topLevelScopePath === "context") {
        const deleted = await handleDeleteFinancialContextEntry(entity.key);
        if (!deleted) {
          setDomainPreview((current) => ({
            ...current,
            deletingEntityKey: null,
          }));
          return;
        }
      } else {
        await PersonalKnowledgeModelService.storePreparedDomain({
          userId: user.uid,
          vaultKey,
          domain: domainKey,
          domainData: buildPkmEntityDeletionCandidate(
            topLevelScopePath,
            entity.key,
          ),
          summary: {},
          mergeDecision: {
            merge_mode: "delete_entity",
            target_domain: domainKey,
            target_entity_id: entity.key,
            target_entity_path: `${topLevelScopePath}.entities.${entity.key}`,
            match_confidence: 1,
            match_reason:
              "User removed this saved PKM entry from the profile interface.",
          },
          vaultOwnerToken,
        });
      }

      const permission = selectedDomainPermissions.find(
        (candidate) => candidate.key === domainPreview.permissionKey,
      );
      const data = await PersonalKnowledgeModelService.loadDomainData({
        userId: user.uid,
        domain: domainKey,
        vaultKey,
        vaultOwnerToken,
        segmentIds: [topLevelScopePath],
      });

      setDomainPreview((current) => ({
        ...current,
        presentation: buildPkmSectionPreviewPresentation({
          domain: domainKey,
          domainTitle: selectedDomain?.title || domainKey,
          permissionLabel:
            permission?.label || current.title || topLevelScopePath,
          permissionDescription:
            permission?.description || current.description || null,
          topLevelScopePath,
          value: data,
        }),
        loading: false,
        error: null,
        deletingEntityKey: null,
      }));

      void refreshPkmMetadata(true);
      void refreshDomainManifest(domainKey, true);
      toast.success("Saved entry removed.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't remove this saved entry.";
      setDomainPreview((current) => ({
        ...current,
        error: message,
        deletingEntityKey: null,
      }));
      toast.error(message);
    }
  };

  const handleToggleDomainPermission = async (
    domainKey: string,
    permission: {
      key: string;
      scopeHandle: string | null;
      topLevelScopePath: string;
      exposureEnabled: boolean;
      visibilityPosture: PkmVisibilityPosture;
      label: string;
      description?: string | null;
    },
    nextPosture: PkmVisibilityPosture,
  ) => {
    if (!user?.uid || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return;
    }
    const permissionKey = permission.key;
    const previousManifest = cloneManifest(domainManifests[domainKey] ?? null);
    if (!previousManifest) {
      toast.error("These details are still preparing sharing controls.");
      return;
    }

    const optimisticManifest = applyManifestExposureChange(
      previousManifest,
      {
        scopeHandle: permission.scopeHandle,
        topLevelScopePath: permission.topLevelScopePath,
      },
      nextPosture,
    );

    setPendingPermissionToggles((current) => ({
      ...current,
      [permissionKey]: true,
    }));
    setDomainManifests((current) => ({
      ...current,
      [domainKey]: optimisticManifest ?? previousManifest,
    }));
    setDomainManifestErrors((current) => ({ ...current, [domainKey]: null }));

    try {
      const { manifest: updatedManifest } = await applySlicePosture({
        userId: user.uid,
        domain: domainKey,
        domainTitle: selectedDomain?.title || domainKey,
        permission: {
          scopeHandle: permission.scopeHandle,
          label: permission.label,
          description: permission.description,
          topLevelScopePath: permission.topLevelScopePath,
        },
        nextPosture,
        previousManifest,
        vaultOwnerToken,
      });

      setDomainManifests((current) => ({
        ...current,
        [domainKey]: updatedManifest,
      }));
      await Promise.all([refreshConsentCenter(true), refreshPkmMetadata(true)]);
      toast.success(
        nextPosture === "private"
          ? "This section is private."
          : "One will ask before sharing this section.",
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't update sharing right now.";
      setDomainManifests((current) => ({
        ...current,
        [domainKey]: previousManifest,
      }));

      if (error instanceof PkmScopeExposureError && error.status === 409) {
        await Promise.all([
          refreshDomainManifest(domainKey, true),
          refreshConsentCenter(true),
          refreshPkmMetadata(true),
        ]);
        toast.error(
          "Sharing changed elsewhere. The latest version has been reloaded.",
        );
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

  const handleSaveFinancialContext = async () => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return;
    }

    const contextText = financialContextText.trim();

    if (!contextText) {
      toast.error("Add financial context before saving.");
      return;
    }

    const updatedAt = new Date().toISOString();
    setSavingFinancialContext(true);
    setPkmError(null);

    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: "financial",
        vaultKey,
        vaultOwnerToken,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "profile_financial_context_save",
        },
        build: (context) => {
          const current = context.currentDomainData || {};
          const existingContext =
            current.context &&
            typeof current.context === "object" &&
            !Array.isArray(current.context)
              ? (current.context as Record<string, unknown>)
              : {};
          const existingEntries = Array.isArray(existingContext.entries)
            ? existingContext.entries.filter(
                (entry): entry is Record<string, unknown> =>
                  Boolean(entry) &&
                  typeof entry === "object" &&
                  !Array.isArray(entry),
              )
            : [];
          const nextEntry = {
            id: editingFinancialContextId || `ctx_${Date.parse(updatedAt)}`,
            category: financialContextCategory,
            text: contextText,
            status: "active",
            source: "profile_my_data",
            updated_at: updatedAt,
          };
          const nextEntries = editingFinancialContextId
            ? existingEntries.map((entry) =>
                entry.id === editingFinancialContextId
                  ? { ...entry, ...nextEntry }
                  : entry,
              )
            : [nextEntry, ...existingEntries];

          return {
            domainData: {
              ...current,
              schema_version: Number(current.schema_version || 3),
              context: {
                ...existingContext,
                entries: nextEntries.slice(0, 50),
                source: "profile_my_data",
                updated_at: updatedAt,
              },
              updated_at: updatedAt,
            },
            summary: {
              readable_summary:
                "Your financial profile includes saved context from Memory.",
              readable_highlights: [],
              readable_updated_at: updatedAt,
              readable_source_label: "Memory",
              consumer_item_count: nextEntries.length,
              context_entry_count: nextEntries.length,
              last_updated: updatedAt,
            },
          };
        },
      });

      if (!result.success) {
        throw new Error(result.message || "Financial context save failed.");
      }

      toast.success(
        editingFinancialContextId
          ? "Financial context updated."
          : "Financial context saved.",
      );
      setFinancialContextText("");
      setEditingFinancialContextId(null);
      void refreshPkmMetadata(true);
      void refreshDomainManifest("financial", true);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't save financial context.";
      setPkmError(message);
      toast.error(message);
    } finally {
      setSavingFinancialContext(false);
    }
  };

  const handleEditFinancialContextEntry = (entity: PkmSectionPreviewEntity) => {
    const payload = entity.editPayload || {};
    const category =
      typeof payload.category === "string" && payload.category.trim()
        ? payload.category.trim()
        : "general";
    const text =
      typeof payload.text === "string" && payload.text.trim()
        ? payload.text.trim()
        : entity.fields.find((field) => field.label === "Context")?.value || "";

    setEditingFinancialContextId(entity.key);
    setFinancialContextCategory(category as FinancialContextCategory);
    setFinancialContextText(text);
    setDomainPreview((current) => ({ ...current, open: false }));
  };

  const handleDeleteFinancialContextEntry = async (entryId: string) => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return false;
    }

    const updatedAt = new Date().toISOString();
    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: "financial",
        vaultKey,
        vaultOwnerToken,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "profile_financial_context_delete",
        },
        build: (context) => {
          const current = context.currentDomainData || {};
          const existingContext =
            current.context &&
            typeof current.context === "object" &&
            !Array.isArray(current.context)
              ? (current.context as Record<string, unknown>)
              : {};
          const existingEntries = Array.isArray(existingContext.entries)
            ? existingContext.entries.filter(
                (entry): entry is Record<string, unknown> =>
                  Boolean(entry) &&
                  typeof entry === "object" &&
                  !Array.isArray(entry),
              )
            : [];
          const nextEntries = existingEntries.filter(
            (entry) => entry.id !== entryId,
          );

          return {
            domainData: {
              ...current,
              context: {
                ...existingContext,
                entries: nextEntries,
                source: "profile_my_data",
                updated_at: updatedAt,
              },
              updated_at: updatedAt,
            },
            summary: {
              readable_summary:
                nextEntries.length > 0
                  ? "Your financial profile includes saved context from Memory."
                  : "Your financial profile is ready for saved context.",
              readable_highlights: [],
              readable_updated_at: updatedAt,
              readable_source_label: "Memory",
              consumer_item_count: nextEntries.length,
              context_entry_count: nextEntries.length,
              last_updated: updatedAt,
            },
          };
        },
      });

      if (!result.success) {
        throw new Error(result.message || "Financial context delete failed.");
      }

      void refreshPkmMetadata(true);
      void refreshDomainManifest("financial", true);
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't delete financial context.";
      setPkmError(message);
      toast.error(message);
      return false;
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
      description:
        "Broken flow, confusing UI, or something off in the product.",
    },
    {
      kind: "support_request",
      icon: LifeBuoy,
      label: "Get support",
      description:
        "Need help with onboarding, portfolio information, or account setup.",
    },
    {
      kind: "developer_reachout",
      icon: Code2,
      label: "Reach developer",
      description:
        "Direct product or engineering feedback routed through support.",
    },
  ];

  const myDataContent = (
    <div className="space-y-4 sm:space-y-5">
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
        loadingManifestsByDomain={loadingDomainManifests}
        manifestErrorsByDomain={domainManifestErrors}
        onOpenSharing={() =>
          updateProfileView({ panel: "access", detail: null }, "push")
        }
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
            "push",
          )
        }
      />
    </div>
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
            "push",
          )
        }
        onRevokeAccess={async (scope) => {
          await handleRevoke(scope);
        }}
      />

      <SettingsGroup>
        <SettingsRow
          icon={MapPin}
          title="Location sharing"
          description="Manage live location."
          trailing={<Badge variant="secondary">One</Badge>}
          chevron
          stackTrailingOnMobile
          onClick={() => router.push(ROUTES.ONE_LOCATION)}
        />
        <SettingsRow
          icon={ExternalLink}
          title="Consent center"
          description="Review sharing."
          trailing={<Badge variant="secondary">Manage</Badge>}
          chevron
          stackTrailingOnMobile
          onClick={() => router.push(ROUTES.CONSENTS)}
        />
        <SettingsRow
          icon={ContactRound}
          title="Find me by phone number"
          description={contactDiscoverableStatusText}
          trailing={
            <Switch
              checked={contactDiscoverable}
              disabled={loadingContactDiscoverable || savingContactDiscoverable}
              aria-label="Toggle contact discoverability"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={() => void handleContactDiscoverableToggle()}
            />
          }
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

  const handleAccountPhoneCompleted = async (
    verifiedUser?: typeof user | null,
  ) => {
    const activeUser = verifiedUser ?? user;
    await AccountIdentityService.syncCurrentUser(activeUser);
    updateProfileView({ panel: "account", detail: null }, "replace");
  };

  const accountContent = (
    <div className="profile-account-content space-y-4">
      <SettingsGroup title="Identity">
        <SettingsRow
          icon={User}
          iconTone="gray"
          title="Display name"
          description={user.displayName || "Not available"}
        />
        <SettingsRow
          icon={Mail}
          iconTone="blue"
          title="Email"
          description={user.email || "Not available"}
        />
        <SettingsRow
          icon={Phone}
          iconTone="green"
          title="Phone number"
          description={phoneSummaryText}
          trailing={
            <span className="text-xs font-medium text-accent-strong">
              {phoneNumber ? "Change" : "Add"}
            </span>
          }
          chevron
          onClick={() =>
            updateProfileView({ panel: "account", detail: "phone" }, "push")
          }
        />
        <SettingsRow
          icon={Fingerprint}
          iconTone="green"
          title="Sign-in provider"
          description={provider.name}
        />
        {walletCardEntryEnabled ? (
          <SettingsRow
            icon={Wallet}
            iconTone="purple"
            className="profile-account-service-row"
            title={WALLET_CARD_COPY.profileEntry.title}
            description={WALLET_CARD_COPY.profileEntry.description}
            chevron
            onClick={() => router.push(ROUTES.ONE_WALLET_CARD)}
          />
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="Account actions">
        <SettingsRow
          icon={RefreshCw}
          iconTone="gray"
          className="profile-account-reset-row"
          title="Reset account"
          description={resetRowDescription}
          chevron
          onClick={() => void handleResetClick()}
        />
        <SettingsRow
          icon={Trash2}
          className="profile-account-delete-row"
          title={deleteButtonLabel}
          description={deleteRowDescription}
          tone="destructive"
          chevron
          onClick={() => void handleDeleteClick()}
        />
      </SettingsGroup>
    </div>
  );

  const preferencesContent = (
    <div className="space-y-4">
      <SettingsGroup>
        <SettingsRow
          icon={Monitor}
          title="Appearance"
          description="Light, dark, or system."
          trailing={
            <ThemeToggleLean
              size="expanded"
              className="w-full sm:w-60 min-w-0"
            />
          }
          stackTrailingOnMobile
        />
        <SettingsRow
          icon={Palette}
          title="Accent"
          description="Choose the app accent."
          trailing={
            <Select
              value={appAccent}
              onValueChange={(value) => {
                writeAccent(value as AppAccent);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-60 min-w-[11rem]"
                aria-label="App accent color"
              >
                <SelectValue placeholder="iOS Blue" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blue">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: "var(--accent-preview-blue)" }}
                    />
                    iOS Blue
                  </span>
                </SelectItem>
                <SelectItem value="gold">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: "var(--accent-preview-gold)" }}
                    />
                    Molten Gold
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          }
          stackTrailingOnMobile
        />
        <SettingsRow
          leading={<GeminiLogo className="h-8 w-8" />}
          title="Gemini"
          description="Choose managed or BYOK."
          chevron
          onClick={() =>
            updateProfileView(
              { panel: "preferences", detail: "gemini" },
              "push",
            )
          }
        />
      </SettingsGroup>
    </div>
  );

  const securityContent = (
    <div className="space-y-4">
      <SettingsGroup>
        <SettingsRow
          icon={Fingerprint}
          title="Vault methods"
          description="Passphrase, passkey, and unlock method."
          chevron
          onClick={() =>
            updateProfileView({ panel: "security", detail: "vault" }, "push")
          }
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
          onClick={() =>
            updateProfileView(
              { panel: "support", detail: "support-routing" },
              "push",
            )
          }
        />
      </SettingsGroup>
    </div>
  );

  const gmailContent = (
    <div className="space-y-4 sm:space-y-5">
      <SettingsGroup>
        <SettingsRow
          icon={Mail}
          title="Connection"
          description={gmailSettingsDescription}
          trailing={<Badge variant="secondary">{gmailStatusLabel}</Badge>}
          chevron
          stackTrailingOnMobile
          onClick={() =>
            updateProfileView(
              { panel: "gmail", detail: "gmail-connection" },
              "push",
            )
          }
        />
        <SettingsRow
          icon={RefreshCw}
          title="Actions"
          description="Sync, receipts, or disconnect."
          chevron
          onClick={() =>
            updateProfileView(
              { panel: "gmail", detail: "gmail-actions" },
              "push",
            )
          }
        />
      </SettingsGroup>
    </div>
  );

  const connectedSystemsContent = (
    <ConnectedSystemsPanel
      cacheUserId={user?.uid}
      vaultOwnerToken={vaultOwnerToken}
      onRequestUnlock={() => requestVaultUnlock("profile_data")}
      profile={{
        displayName: user?.displayName,
        email: user?.email,
        phone: phoneNumber,
      }}
    />
  );

  const vaultMethodsContent = (
    <div className="space-y-4 sm:space-y-5">
      <SettingsGroup title="Vault">
        {vaultAccess.needsVaultCreation ? (
          <SettingsRow
            icon={KeyRound}
            title="Create your vault"
            description="Secure saved details."
            chevron
            onClick={() => setShowVaultCreation(true)}
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
            {vaultMethod ? (
              <SettingsRow
                icon={KeyRound}
                title="Default unlock"
                description={defaultUnlockDescription}
                trailing={
                  <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
                    <Badge
                      variant="secondary"
                      className={VAULT_INLINE_BADGE_CLASS}
                    >
                      {readableMethod(vaultMethod)}
                    </Badge>
                    {canSwitchDefaultToPassphrase ? (
                      <Button
                        variant="none"
                        effect="fade"
                        size="sm"
                        className={VAULT_INLINE_CONTROL_CLASS}
                        disabled={switchingVaultMethod}
                        onClick={() => void preferPassphraseUnlock()}
                      >
                        Use passphrase
                      </Button>
                    ) : null}
                    {canSwitchDefaultToQuick &&
                    quickMethodReadyOnCurrentDevice ? (
                      <Button
                        variant="none"
                        effect="fade"
                        size="sm"
                        className={VAULT_INLINE_CONTROL_CLASS}
                        disabled={switchingVaultMethod}
                        onClick={() =>
                          void setQuickMethodAsDefault(
                            quickMethodReadyOnCurrentDevice,
                            availableQuickWrapperId,
                          )
                        }
                      >
                        Use{" "}
                        {readableQuickMethod(quickMethodReadyOnCurrentDevice)}
                      </Button>
                    ) : null}
                  </div>
                }
                stackTrailingOnMobile
              />
            ) : null}
            {!vaultAccess.canMutateSecureData ? (
              <SettingsRow
                icon={KeyRound}
                title="Unlock vault"
                description="Change methods or passphrase."
                chevron
                onClick={() => requestVaultUnlock("profile_data")}
              />
            ) : null}

            {vaultAccess.canMutateSecureData && recommendedQuickMethod ? (
              <SettingsRow
                icon={Fingerprint}
                title={
                  enrolledPasskeyWrappers.length > 0
                    ? `Add another ${readableQuickMethod(recommendedQuickMethod)}`
                    : `Add ${readableQuickMethod(recommendedQuickMethod)}`
                }
                description={
                  isPasskeyVaultMethod(recommendedQuickMethod)
                    ? "Save a passkey."
                    : "Enable quick unlock."
                }
                disabled={switchingVaultMethod}
                chevron
                onClick={() => void switchToQuickMethod(recommendedQuickMethod)}
              />
            ) : null}

            {enrolledPasskeyWrappers.map((wrapper, index) => {
              const wrapperId = wrapper.wrapperId ?? "default";
              const isPrimary =
                vaultMethod === wrapper.method &&
                activePrimaryWrapperId === wrapperId;
              return (
                <SettingsRow
                  key={vaultWrapperKey(wrapper)}
                  icon={Fingerprint}
                  title={
                    enrolledPasskeyWrappers.length > 1
                      ? `Passkey ${index + 1}`
                      : "Passkey"
                  }
                  description={describePasskeyWrapper(wrapper)}
                  trailing={
                    vaultAccess.canMutateSecureData ? (
                      <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
                        {isPrimary ? (
                          <Badge
                            variant="secondary"
                            className={VAULT_INLINE_BADGE_CLASS}
                          >
                            Default
                          </Badge>
                        ) : (
                          <Button
                            variant="none"
                            effect="fade"
                            size="sm"
                            className={VAULT_INLINE_CONTROL_CLASS}
                            disabled={switchingVaultMethod}
                            onClick={() =>
                              void setQuickMethodAsDefault(
                                wrapper.method,
                                wrapperId,
                              )
                            }
                          >
                            Set default
                          </Button>
                        )}
                        <Button
                          variant="none"
                          effect="fade"
                          size="sm"
                          className={`${VAULT_INLINE_CONTROL_CLASS} text-destructive hover:text-destructive`}
                          disabled={switchingVaultMethod}
                          onClick={() => setPasskeyRemovalTarget(wrapper)}
                        >
                          Remove
                        </Button>
                      </div>
                    ) : (
                      <Badge
                        variant="secondary"
                        className={VAULT_INLINE_BADGE_CLASS}
                      >
                        {isPrimary ? "Default" : "Saved"}
                      </Badge>
                    )
                  }
                  stackTrailingOnMobile
                />
              );
            })}

            {vaultMethod ? (
              <SettingsRow
                icon={RefreshCw}
                title="Change passphrase"
                description="Update vault protection."
                disabled={switchingVaultMethod}
                chevron
                onClick={() => setPassphraseDialogOpen(true)}
              />
            ) : null}

            <SettingsRow
              icon={KeyRound}
              title="BYOK and passkeys"
              description="Additional key methods are being verified."
              disabled
              trailing={<VaultComingSoonLogos />}
              stackTrailingOnMobile
            />
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
          description="Authorize read-only receipt access. Shopping summaries are saved automatically to your private PKM."
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
        onClick={() => router.push(ROUTES.GMAIL)}
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
        <SurfaceCardTitle>
          {SUPPORT_KIND_COPY[supportComposeKind].title}
        </SurfaceCardTitle>
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

  const financialContextControls = (
    <div className="space-y-3">
      <Select
        value={financialContextCategory}
        onValueChange={(value) =>
          setFinancialContextCategory(value as FinancialContextCategory)
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="general">General</SelectItem>
          <SelectItem value="portfolio">Portfolio</SelectItem>
          <SelectItem value="risk">Risk</SelectItem>
          <SelectItem value="kyc">KYC</SelectItem>
          <SelectItem value="tax">Tax</SelectItem>
          <SelectItem value="documents">Documents</SelectItem>
        </SelectContent>
      </Select>
      <Textarea
        value={financialContextText}
        onChange={(event) => setFinancialContextText(event.target.value)}
        placeholder="What should Hussh remember?"
        className="min-h-[112px]"
      />
      <div className="flex justify-end">
        {editingFinancialContextId ? (
          <Button
            variant="none"
            effect="fade"
            size="default"
            onClick={() => {
              setEditingFinancialContextId(null);
              setFinancialContextText("");
              setFinancialContextCategory("general");
            }}
            disabled={savingFinancialContext}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          size="default"
          onClick={() => void handleSaveFinancialContext()}
          disabled={savingFinancialContext}
        >
          {savingFinancialContext ? (
            <>
              <Icon icon={Loader2} size="sm" className="mr-2 animate-spin" />
              Saving...
            </>
          ) : editingFinancialContextId ? (
            "Update"
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );

  const profileStackEntries: ProfileStackEntry[] = [];

  if (!routeBlockedByVault && activePanel === "account") {
    profileStackEntries.push({
      key: "panel:account",
      title: "Account",
      description: "Email, phone, and sign-in.",
      content: accountContent,
      presentation: "account",
    });
    if (activeDetail === "phone") {
      profileStackEntries.push({
        key: "detail:phone",
        title: phoneNumber ? "Change phone number" : "Add phone number",
        description: phoneNumber
          ? "Verify a new number."
          : "Add a verified number.",
        content: (
          <>
            <PhoneVerificationFlow
              mode={phoneNumber ? "replace" : "link"}
              currentPhoneNumber={phoneNumber}
              startVerification={
                phoneNumber ? startPhoneReplacement : startPhoneVerification
              }
              confirmVerification={
                phoneNumber ? confirmPhoneReplacement : confirmPhoneVerification
              }
              onCompleted={handleAccountPhoneCompleted}
              onCancel={popProfileStack}
              confirmLabel="Save phone number"
              className="gap-5"
              helperText={
                phoneNumber
                  ? "Enter the new phone number."
                  : "Enter your phone number."
              }
            />
            <div id="recaptcha-container" className="min-h-0" />
          </>
        ),
      });
    }
  } else if (!routeBlockedByVault && activePanel === "my-data") {
    profileStackEntries.push({
      key: "panel:my-data",
      title: "Memory",
      description: "Saved details and sharing.",
      content: myDataContent,
    });
    if (selectedDomain) {
      profileStackEntries.push({
        key: `detail:domain:${selectedDomain.key}`,
        title: selectedDomain.title,
        description: "Sections and sharing.",
        content: (
          <PkmDomainDetailPanel
            domain={selectedDomain}
            permissions={selectedDomainPermissions}
            upgrade={
              selectedDomainUpgrade || {
                status: "missing_manifest",
                label: "Updating structure",
                description:
                  "Sharing controls will appear here once these details are ready.",
                canManagePermissions: false,
              }
            }
            manifestLoading={Boolean(
              selectedDomain && loadingDomainManifests[selectedDomain.key],
            )}
            manifestError={
              selectedDomain ? domainManifestErrors[selectedDomain.key] : null
            }
            pendingPermissionKeys={selectedDomainPermissions
              .filter((permission) => pendingPermissionToggles[permission.key])
              .map((permission) => permission.key)}
            previewOpen={domainPreview.open}
            previewTitle={domainPreview.title}
            previewDescription={domainPreview.description}
            previewPresentation={domainPreview.presentation}
            previewLoading={domainPreview.loading}
            previewError={domainPreview.error}
            previewDeletingEntityKey={domainPreview.deletingEntityKey}
            contextControls={
              selectedDomain.key === "financial"
                ? financialContextControls
                : undefined
            }
            hideHighlights={selectedDomain.key === "financial"}
            onPreviewOpenChange={(open) =>
              setDomainPreview((current) => ({
                ...current,
                open,
              }))
            }
            onPreviewPermission={(permission) =>
              void handlePreviewDomainPermission(selectedDomain.key, permission)
            }
            onEditPreviewEntity={(entity) =>
              handleEditFinancialContextEntry(entity)
            }
            onDeletePreviewEntity={(entity) =>
              void handleDeletePkmPreviewEntity(entity)
            }
            onTogglePermission={(permission, nextPosture) =>
              void handleToggleDomainPermission(
                selectedDomain.key,
                permission,
                nextPosture,
              )
            }
          />
        ),
      });
    }
  } else if (!routeBlockedByVault && activePanel === "access") {
    profileStackEntries.push({
      key: "panel:access",
      title: "Access & sharing",
      description: "Review live access.",
      content: accessContent,
    });
    if (selectedConnection) {
      profileStackEntries.push({
        key: `detail:connection:${selectedConnection.id}`,
        title: selectedConnection.requesterLabel,
        description: "Scopes and access.",
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
  } else if (!routeBlockedByVault && activePanel === "connected-systems") {
    profileStackEntries.push({
      key: "panel:connected-systems",
      title: "Connected Systems",
      description: "Connected CRM systems.",
      content: connectedSystemsContent,
    });
  } else if (!routeBlockedByVault && activePanel === "preferences") {
    profileStackEntries.push({
      key: "panel:preferences",
      title: PROFILE_LABELS.preferences,
      description: "Theme and accent.",
      content: preferencesContent,
    });
    if (activeDetail === "kai-preferences") {
      profileStackEntries.push({
        key: "detail:kai-preferences",
        title: "Kai preferences",
        description: "Investing preferences.",
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
    } else if (activeDetail === "gemini") {
      profileStackEntries.push({
        key: "detail:gemini",
        title: "Gemini",
        description: "Gemini access.",
        content: (
          <GeminiRuntimeSettingsCard
            userId={user.uid}
            vaultKey={vaultKey}
            vaultOwnerToken={vaultOwnerToken}
            needsVaultCreation={vaultAccess.needsVaultCreation}
            needsUnlock={vaultAccess.needsUnlock}
            onRequestVaultCreation={() => requestVaultUnlock("profile_data")}
            onRequestVaultUnlock={() => requestVaultUnlock("profile_data")}
          />
        ),
      });
    }
  } else if (!routeBlockedByVault && activePanel === "security") {
    profileStackEntries.push({
      key: "panel:security",
      title: PROFILE_LABELS.security,
      description: "Vault and sign-in.",
      content: securityContent,
    });
    if (activeDetail === "vault") {
      profileStackEntries.push({
        key: "detail:vault",
        title: "Vault methods",
        description: "Unlock methods.",
        content: vaultMethodsContent,
      });
    } else if (activeDetail === "session") {
      profileStackEntries.push({
        key: "detail:session",
        title: PROFILE_LABELS.accountAccess,
        description: "This device.",
        content: (
          <SettingsGroup title={PROFILE_LABELS.accountAccess}>
            <SettingsRow
              icon={LogOut}
              title="Sign out"
              description="Sign out on this device."
              onClick={() => void handleSignOut()}
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
      description: "Receipts and sync.",
      content: gmailContent,
    });
    if (activeDetail === "gmail-connection") {
      profileStackEntries.push({
        key: "detail:gmail-connection",
        title: "Connection",
        description: "Inbox and sync.",
        content: gmailConnectionContent,
      });
    } else if (activeDetail === "gmail-actions") {
      profileStackEntries.push({
        key: "detail:gmail-actions",
        title: "Actions",
        description: "Sync, receipts, or disconnect.",
        content: gmailActionsContent,
      });
    }
  } else if (!routeBlockedByVault && activePanel === "support") {
    profileStackEntries.push({
      key: "panel:support",
      title: PROFILE_LABELS.support,
      description: "Help and feedback.",
      content: supportContent,
    });
    if (activeDetail === "support-routing") {
      profileStackEntries.push({
        key: "detail:support-routing",
        title: "Support routing",
        description: "Reply routing.",
        content: supportRoutingContent,
      });
    } else if (supportComposeKind && supportComposeContent) {
      profileStackEntries.push({
        key: `detail:support-compose:${supportComposeKind}`,
        title: SUPPORT_KIND_COPY[supportComposeKind].title,
        description: "Write your message.",
        content: supportComposeContent,
      });
    }
  }

  const profileRootContent = (
    <div className="profile-home-screen">
      <AppPageHeaderRegion>
        <header
          className="profile-home-hero flex w-full min-w-0 flex-col items-center gap-2 px-0 text-center sm:px-6"
          data-slot="page-header"
          data-page-primary="true"
        >
          <ProfileAvatarEditor />
          <div className="profile-home-copy w-full min-w-0 max-w-full space-y-2">
            <h1 className="profile-home-name ui-text-identity-name [overflow-wrap:anywhere]">
              {user.displayName || "User"}
            </h1>
            <div
              className="profile-home-meta flex w-full min-w-0 items-center justify-center gap-2 text-xs font-normal text-muted-foreground"
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
          <div className="profile-home-content space-y-4 sm:space-y-5">
            <SettingsGroup title="Your settings" separatorInset>
              <SettingsRow
                icon={UserRound}
                iconTone="gray"
                title={PROFILE_LABELS.account}
                chevron
                density="compact"
                onClick={openAccountPanel}
              />
              <SettingsRow
                icon={SlidersHorizontal}
                iconTone="purple"
                title={PROFILE_LABELS.preferences}
                chevron
                density="compact"
                onClick={openPreferencesPanel}
              />
              <SettingsRow
                icon={ShieldCheck}
                iconTone="green"
                title={PROFILE_LABELS.security}
                chevron
                density="compact"
                voiceControlId="profile_security"
                voiceActionId="route.profile_security_panel"
                voiceLabel={PROFILE_LABELS.security}
                voicePurpose="Opens vault, account access, and account deletion controls."
                onClick={openSecurityPanel}
              />
              <SettingsRow
                icon={MessageCircleQuestion}
                iconTone="orange"
                title={PROFILE_LABELS.support}
                chevron
                density="compact"
                onClick={() =>
                  updateProfileView({ panel: "support", detail: null }, "push")
                }
              />
              {canShowPkmAgentLab ? (
                <SettingsRow
                  icon={CodeXml}
                  iconTone="purple"
                  title={PROFILE_LABELS.developerTools}
                  trailing={<Badge variant="secondary">Local</Badge>}
                  chevron
                  density="compact"
                  onClick={() => router.push("/one/profile/pkm-agent-lab")}
                />
              ) : null}
            </SettingsGroup>

            <SettingsGroup title={PROFILE_LABELS.accountAccess} separatorInset>
              <SettingsRow
                icon={LogOut}
                title="Sign out"
                tone="destructive"
                chevron
                density="compact"
                onClick={() => void handleSignOut()}
              />
            </SettingsGroup>
          </div>
        </SurfaceStack>
      </AppPageContentRegion>
    </div>
  );

  if (legacyProfileRedirectHref) {
    return null;
  }

  return (
    <AppPageShell
      data-testid="profile-primary"
      as="div"
      width="reading"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: profileNativeRouteId,
        marker: "native-route-profile",
        authState: user ? "authenticated" : "pending",
        dataState: authLoading ? "loading" : "loaded",
      }}
    >
      <ProfileStackNavigator
        rootContent={profileRootContent}
        entries={profileStackEntries}
      />

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
            if (vaultUnlockReason === "reset_account") {
              setTimeout(() => setShowResetConfirm(true), 300);
              setTimeout(() => {
                vaultUnlockCompletingRef.current = false;
              }, 0);
              return;
            }
            const returnTo = vaultReturnToRef.current;
            if (returnTo) {
              vaultReturnToRef.current = null;
              router.replace(returnTo);
              setTimeout(() => {
                vaultUnlockCompletingRef.current = false;
              }, 0);
              toast.success("Vault unlocked.");
              return;
            }
            if (pendingProfileTarget) {
              updateProfileView(
                {
                  panel: pendingProfileTarget.panel,
                  detail: pendingProfileTarget.detail,
                },
                pendingProfileTarget.mode,
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

      {hasVault === false && (
        <VaultUnlockDialog
          user={user}
          open={showVaultCreation}
          onOpenChange={setShowVaultCreation}
          title="Create your vault"
          description="Set up a passphrase to secure your saved details."
          onSuccess={() => {
            setShowVaultCreation(false);
            setHasVault(true);
            VaultService.setVaultCheckCache(user.uid, true);
            const returnTo = vaultReturnToRef.current;
            if (returnTo) {
              vaultReturnToRef.current = null;
              router.replace(returnTo);
            }
            toast.success("Vault created and unlocked.");
          }}
        />
      )}

      <Dialog
        open={passphraseDialogOpen}
        onOpenChange={setPassphraseDialogOpen}
      >
        <DialogContent className="w-[calc(100%-1rem)] max-h-[calc(100svh-1rem)] overflow-y-auto sm:max-w-md">
          <DialogTitle>Change passphrase</DialogTitle>
          <DialogDescription>
            Set a new passphrase for Vault unlock. Your passkey and biometric
            methods stay active.
          </DialogDescription>
          <div className="space-y-3 pt-2">
            <Input
              type="password"
              placeholder="New passphrase (min 8 characters)"
              autoComplete="new-password"
              value={newPassphrase}
              onChange={(event) => setNewPassphrase(event.target.value)}
            />
            <Input
              type="password"
              placeholder="Confirm passphrase"
              autoComplete="new-password"
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

      <AlertDialog
        open={Boolean(passkeyRemovalTarget)}
        onOpenChange={(open) => {
          if (!open) setPasskeyRemovalTarget(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-1rem)] sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved passkey from One. It may still remain in
              your password manager, and passphrase unlock will stay available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {passkeyRemovalTarget ? (
            <p className="rounded-2xl bg-muted/50 px-4 py-3 text-sm leading-6 text-muted-foreground">
              {describePasskeyWrapper(passkeyRemovalTarget)}
            </p>
          ) : null}
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel
              className="w-full sm:w-auto"
              disabled={switchingVaultMethod}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              className="app-critical-action w-full opacity-90 transition-opacity hover:opacity-100 sm:w-auto"
              disabled={switchingVaultMethod || !passkeyRemovalTarget}
              onClick={(event) => {
                event.preventDefault();
                if (passkeyRemovalTarget) {
                  void removePasskeyWrapper(passkeyRemovalTarget);
                }
              }}
            >
              {switchingVaultMethod ? "Removing..." : "Remove passkey"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel
              className="w-full sm:w-auto"
              disabled={isDeleting}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              className="app-critical-action min-h-10 w-full !whitespace-normal px-4 py-2 text-center leading-tight opacity-90 transition-opacity hover:opacity-100 sm:w-auto sm:min-w-[12rem]"
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteAccount();
              }}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Yes, delete my account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent className="w-[calc(100%-1rem)] sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Icon icon={RefreshCw} size="md" />
              {resetDialogTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resetDialogDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel
              className="w-full sm:w-auto"
              disabled={isResetting}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              className="min-h-10 w-full !whitespace-normal px-4 py-2 text-center leading-tight sm:w-auto sm:min-w-[12rem]"
              onClick={(event) => {
                event.preventDefault();
                void handleResetAccount();
              }}
              disabled={isResetting}
            >
              {isResetting ? "Resetting..." : "Yes, reset my account"}
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
