"use client";

import { LivingMemoryDocument } from "@/components/profile/living-memory-document";
import { MarketingPreferencePanel } from "@/components/account/marketing-preference-panel";
import { useMarketingPreference } from "@/components/account/use-marketing-preference";

import { useDocumentFeedStream } from "@/lib/feed/use-document-feed-stream";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { isNative } from "@/lib/capacitor/platform";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { backendPhoneIsMissing } from "@/lib/auth/phone-identity";
import {
  WarningIcon as AlertTriangle,
  SpinnerGapIcon as Loader2,
  ArrowsClockwiseIcon as RefreshCw,
} from "@/components/icons";
import { FinanceAgentIcon } from "@/components/icons/agents";
import { PROFILE_ICONS } from "@/components/icons/profile-icons";
import accountStyles from "@/components/profile/profile-your-account.module.css";
import auxiliaryTabStyles from "@/components/profile/profile-auxiliary-tabs.module.css";
import secondaryTypographyStyles from "@/components/profile/profile-secondary-typography.module.css";
import { toast } from "sonner";
import { AgentSettingsPanel, useAgentSettingsController } from "@/components/profile/agent-settings-panel";
import { useNativeAgentSettings } from "./use-native-agent-settings";
import { NativeProfilePresentation } from "./native-profile-menu";
import { AccountConfirmationPreparation } from "./account-confirmation-preparation";
import { useNativeProfilePreferences } from "./use-native-profile-preferences";
import { useNativeVoiceProfile } from "./use-native-voice-profile";
import { NativeSupportComposer } from "./native-support-composer";
import { projectNativeProfileLegal } from "./profile-native-legal";
import type { NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { PROFILE_LABELS, profileMenuGroups, type ProfileMenuActions } from "./profile-menu-model";
import { VaultMethodsPanel } from "@/components/profile/vault-methods-panel";
import { PaymentsAndEarnings } from "@/components/consent/payments-and-earnings";
import { useProfileVaultMethodsModel } from "./use-profile-vault-methods-model";
import { useNativeVaultMethods } from "./use-native-vault-methods";
import { NativeVaultPasswordEditor } from "./native-vault-password-editor";
import { NativeRequestPricingEditor, projectNativeRequestPricing } from "./native-request-pricing";
import { useNativePayments } from "./use-native-payments";
import { useNativeReferrals } from "./use-native-referrals";
import { ReferralsPanelView } from "./referrals-panel";
import { useNativeConnectors } from "./use-native-connectors";
import { useNativeMemory } from "./use-native-memory";
import { NativeMemoryEditor } from "./native-memory-editor";
import { validNativeMemoryDraft, type NativeMemoryDraft } from "@/lib/capacitor/native-profile-memory-scene";
import { useProfileFinancePreferences } from "./use-profile-finance-preferences";
import { projectNativeFinancePreferences } from "./native-finance-preferences";
import { pkmPreviewEntityTarget, validPkmPreviewPath } from "@/lib/profile/pkm-section-preview";
import { ProfileMemoryOperations } from "./profile-memory-operations";
import { nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useDocumentRequestPricingModel } from "@/components/consent/use-document-request-pricing-model";
import { useNativeProfilePortrait } from "./use-native-profile-portrait";

import {
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
} from "@/components/profile/settings-ui";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import {
  PkmAccessManagerPanel,
  PkmAccessConnectionDetailPanel,
  PkmDataManagerPanel,
  PkmDomainDetailPanel,
} from "@/components/profile/pkm-data-manager";
import { SharedWithYouGroup } from "@/components/profile/shared-with-you-group";
import { useMemorySharedModel } from "@/components/profile/use-memory-shared-model";
import { PersonalWorldModelPage, usePersonalWorldModelModel } from "@/components/profile/personal-world-model-page";
import { useNativeWorldModel } from "@/components/profile/use-native-world-model";
import { DocumentRequestPricingCard } from "@/components/consent/document-request-pricing-card";
import { SecretsListGroup } from "@/components/secrets/secrets-list-group";
import { useSecretsListModel } from "@/components/secrets/use-secrets-list-model";
import {
  ProfileStackNavigator,
  type ProfileStackEntry,
} from "@/components/profile/profile-stack-navigator";
import { ProfileKaiPreferencesPanel } from "@/components/profile/profile-kai-preferences-panel";
import { CommunicationPreferencesSection } from "@/components/profile/communication-preferences-section";
import { Brain } from "@/components/icons";
import { AccountCloudCleanup } from "@/components/profile/account-cloud-cleanup";
import { azureAccountCleanupRequired } from "@/lib/services/account-cloud-cleanup";
import { GeminiRuntimeSettingsView, useGeminiRuntimeSettingsModel } from "@/components/connections/gemini-runtime-settings-card";
import { useNativeRuntimeSettings } from "@/components/profile/use-native-runtime-settings";
import { VoicePreferencesPanel } from "@/components/profile/voice-preferences-panel";
import { MailActionsGroup } from "@/components/profile/mail-actions-group";
import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { buildProfileConnectorsStackEntry, RetainedProfileConnectors } from "@/components/profile/profile-connectors-section";
import type { ConnectorsPanelPresentation } from "@/components/agent/connectors-panel";
import {
  buildProfileLegalStackEntries,
} from "@/components/profile/profile-legal-section";
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import { ProfileAppearancePreferences } from "@/components/profile/profile-appearance-preferences";
import { ProfileAppearanceControls } from "@/components/profile/profile-appearance-controls";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
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
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { VOICE_CONFIRM_DATA_KEY } from "@/lib/kai/actions/voice-action-card";
import { getKaiActionById } from "@/lib/kai/actions/kai-action-gateway";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { currentPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import { isPkmDeveloperHost } from "@/app/one/pkm/developer-visibility";
import {
  DELETE_ACCOUNT_DIALOG_DESCRIPTION,
  DELETE_ACCOUNT_DIALOG_TITLE,
  accountDeletionErrorMessage,
  executeVerifiedAccountDeletion,
  isHandledAccountDeletionOutcome,
  resolveDeleteAccountAuth,
  revokeVaultBanksBeforeErasure,
} from "@/lib/flows/delete-account";
import { buildLoginRouteWithAuthSessionNotice } from "@/lib/auth/session-invalidation";
import {
  normalizeInternalRouteHref,
  normalizeInvitationReturnTo,
  ROUTES,
} from "@/lib/navigation/routes";
import { WALLET_CARD_COPY } from "@/components/wallet-card/wallet-card-copy";
import { isWalletCardEntryEnabled } from "@/components/wallet-card/wallet-card-entry";
import {
  buildCanonicalProfileRouteFromLegacyQuery,
  buildLegacyDocumentPayoutReturnRoute,
  buildProfileRoute,
  resolveProfileRouteState,
  type ProfileDetail,
  type ProfilePanel,
} from "@/lib/navigation/profile-routes";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import {
  popProfilePaneLocation,
  profileLegalParentForPresentation,
  profilePanelParentForPresentation,
  pushProfilePaneLocation,
  replaceProfilePaneLocation,
  resolveProfilePaneUrlState,
  stripProfilePaneTransientParams,
  type ProfilePaneLocation,
} from "@/lib/navigation/profile-pane";
import { backProfilePane } from "@/lib/navigation/profile-pane-back";
import { useBackLayer } from "@/lib/navigation/back-layers";
import {
  resolveGmailConnectionPresentation,
  resolveGmailStatusSummary,
  sanitizeGmailUserMessage,
} from "@/lib/profile/mail-flow";
import { usePersonaState } from "@/lib/persona/persona-context";
import { Icon } from "@/lib/morphy-ux/ui";
import { SegmentedControl } from "@/lib/morphy-ux/ui/segmented-control";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { getProvider, ProviderIcon } from "@/components/profile/provider-identity";
import { EmailIdentityMark } from "@/components/app-ui/email-identity-mark";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { cn } from "@/lib/utils";
import { DisplayNameEditor } from "@/components/profile/display-name-editor";
import { NativeDisplayNameEditor } from "@/components/profile/native-display-name-editor";
import { NativePhoneVerificationFlow } from "@/components/profile/native-phone-verification-flow";
import { AccountService } from "@/lib/services/account-service";
import {
  AccountResetNotConfirmedError,
  classifyDeletionError,
  lifecycleOutcomeToVoice,
  marketplaceOutcomeToVoice,
  resetErrorMessage,
  resolveMarketplaceTarget,
  resolveResetOutcome,
  supportOutcomeToVoice,
  type LifecycleOutcome,
  type MarketplaceOutcome,
  type SupportSubmitOutcome,
} from "@/lib/profile/profile-action-outcomes";
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
  SupportDeliveryUncertainError,
  type SupportMessageKind,
} from "@/lib/services/support-service";
import { ReferralsPanel } from "@/components/profile/referrals-panel";
import TrustedDevicesPage from "@/components/profile/trusted-devices-page";
import { useTrustedDevicesModel } from "./use-trusted-devices-model";
import { useNativeTrustedDevices } from "./use-native-trusted-devices";
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
import { formatMaskedPhoneNumber } from "@/lib/services/phone-display";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import { VaultService, type VaultWrapper } from "@/lib/services/vault-service";
import type { VaultMethod } from "@/lib/services/vault-method-service";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/kai/actions/voice-surface-metadata";
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
import { useAccent, writeAccent } from "@/lib/theme/accent";

type FinancialContextCategory =
  "general" | "portfolio" | "risk" | "kyc" | "tax" | "documents";

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
  if (!validPkmPreviewPath(topLevelScopePath) || !validPkmPreviewPath(entityKey) || entityKey.includes("."))
    throw new Error("This saved entry cannot be addressed safely.");
  const segments = topLevelScopePath.split(".");
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

const SUPPORT_INTENT_PRESENTATION: Record<
  SupportMessageKind,
  {
    label: string;
    accessibleLabel: string;
    placeholder: string;
    submitLabel: string;
    successTitle: string;
    successDescription: string;
    internalSubject: string;
  }
> = {
  bug_report: {
    label: "Problem",
    accessibleLabel: "Problem, report something that is not working",
    placeholder: "What happened, and what did you expect?",
    submitLabel: "Send report",
    successTitle: "Report sent",
    successDescription: "Thanks -- we'll review it.",
    internalSubject: "Bug report",
  },
  support_request: {
    label: "Help",
    accessibleLabel: "Help, get help using One",
    placeholder: "What do you need help with?",
    submitLabel: "Send request",
    successTitle: "Request sent",
    successDescription: "We received your support request.",
    internalSubject: "Support request",
  },
  developer_reachout: {
    label: "Feedback",
    accessibleLabel: "Feedback, share an idea or improvement",
    placeholder: "What should we improve?",
    submitLabel: "Send feedback",
    successTitle: "Feedback sent",
    successDescription: "Thanks for helping us improve One.",
    internalSubject: "Developer feedback",
  },
};

type SupportComposerState =
  | { status: "editing" }
  | { status: "sending" }
  | { status: "sent"; kind: SupportMessageKind }
  | { status: "error"; message: string };

const SUPPORT_INTENT_OPTIONS = (
  Object.keys(SUPPORT_INTENT_PRESENTATION) as SupportMessageKind[]
).map((kind) => ({
  value: kind,
  label: SUPPORT_INTENT_PRESENTATION[kind].label,
  accessibleLabel: SUPPORT_INTENT_PRESENTATION[kind].accessibleLabel,
}));

function normalizeSupportKind(value: string | null): SupportMessageKind | null {
  if (
    value === "bug_report" ||
    value === "support_request" ||
    value === "developer_reachout"
  ) {
    return value;
  }
  return null;
}

function normalizeProfileVaultReturnTo(value: string | null): string | null {
  return normalizeInvitationReturnTo(value);
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

function readableMethod(method: VaultMethod | null): string {
  if (method === "generated_default_native_biometric")
    return "Device biometric";
  if (method === "generated_default_native_passkey_prf") return "Passkey";
  if (method === "generated_default_web_prf") return "Passkey";
  if (method === "passphrase") return "Password";
  return "Unknown";
}

function isPasskeyVaultMethod(method: VaultMethod | null): boolean {
  return (
    method === "generated_default_web_prf" ||
    method === "generated_default_native_passkey_prf"
  );
}

function formatPasskeyLabel(wrapper: VaultWrapper): string {
  if (wrapper.passkeyDeviceLabel) return wrapper.passkeyDeviceLabel;
  if (wrapper.passkeyProvider === "webauthn_prf") return "Browser passkey";
  if (wrapper.passkeyProvider === "native_passkey") return "Device passkey";
  return "Saved passkey";
}

function describePasskeyWrapper(wrapper: VaultWrapper): string {
  return formatPasskeyLabel(wrapper);
}

function profileRouteRequiresUnlockedVault(
  panel: ProfilePanel | null,
  detail: ProfileDetail | null,
): boolean {
  if (
    panel === "my-data" ||
    panel === "payouts" ||
    panel === "world-model" ||
    panel === "request-pricing" ||
    panel === "connected-systems" ||
    panel === "connectors" ||
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
  return panel === "my-data";
}

export type ProfilePagePresentation = "route" | "pane" | "native-page";

type ProfilePageProps = {
  presentation?: ProfilePagePresentation;
  paneLocation?: ProfilePaneLocation;
  panePresentation?: import("@/lib/navigation/use-profile-pane-presentation").ProfilePanePresentation;
  nativeControlsEligible?: boolean;
  nativeMenuOpen?: boolean;
  onNativeMenuClose?: () => void;
};

function ProfilePageContent({
  presentation = "route",
  paneLocation,
  panePresentation,
  nativeControlsEligible = true,
  nativeMenuOpen = false,
  onNativeMenuClose,
}: ProfilePageProps) {
  const [retainedConnectors, setRetainedConnectors] = useState<ConnectorsPanelPresentation>();
  const isPanePresentation = presentation !== "route";
  const [canShowPkmAgentLab, setCanShowPkmAgentLab] = useState(false);
  const appAccent = useAccent();
  const router = useRouter();
  const routePathname = usePathname();
  const routeSearchParams = useSearchParams();
  const pathname = panePresentation?.pathname ?? routePathname;
  const searchParams = panePresentation?.searchParams ?? routeSearchParams;
  const searchParamsString = searchParams.toString();

  useEffect(() => {
    setCanShowPkmAgentLab(
      process.env.NODE_ENV === "development" &&
        isPkmDeveloperHost(window.location.hostname),
    );
  }, []);

  const {
    user,
    userId: applicationOwnerId,
    loading: authLoading,
    phoneNumber,
    phoneNumberStatus,
    resolveVerifiedPhoneNumber,
    signOut,
    startPhoneVerification,
    confirmPhoneVerification,
    startPhoneReplacement,
    confirmPhoneReplacement,
  } = useAuth();
  const nativePortrait = useNativeProfilePortrait(applicationOwnerId ?? null, presentation === "native-page" && nativeMenuOpen);
  const voiceGetIdToken = useMemo(() => user?.getIdToken ? () => user.getIdToken() : null, [user]);
  const { personaState, refresh: refreshPersonaState } = usePersonaState();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked, getVaultOwnerToken } = useVault();
  const pendingConsents = useConsentPendingSummaryCount();
  const { registerSteps, completeStep, reset } = useStepProgress();

  const [showVaultUnlock, setShowVaultUnlock] = useState(false);

  const [vaultUnlockReason, setVaultUnlockReason] = useState<
    "profile_data" | "delete_account" | "reset_account"
  >("profile_data");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [cloudCleanupRequired, setCloudCleanupRequired] = useState(false);
  useEffect(() => { setCloudCleanupRequired(false); }, [applicationOwnerId]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const accountPreparation = useRef(new AccountConfirmationPreparation());
  const dismissAccountConfirmation = useCallback(() => {
    if (isDeleting || isResetting) return;
    accountPreparation.current.invalidate();
    setShowDeleteConfirm(false); setShowResetConfirm(false);
  }, [isDeleting, isResetting]);
  const closeNativeProfile = useCallback(() => {
    if (isDeleting || isResetting) return false;
    dismissAccountConfirmation(); onNativeMenuClose?.();
    return true;
  }, [isDeleting, isResetting, dismissAccountConfirmation, onNativeMenuClose]);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [nativeNameHost, setNativeNameHost] = useState<HTMLDivElement | null>(null);
  const [nativePhoneHost, setNativePhoneHost] = useState<HTMLDivElement | null>(null);
  const [nativeAccountException, setNativeAccountException] = useState<"photo" | "name" | null>(null);
  const [pendingProfileTarget, setPendingProfileTarget] = useState<{
    panel: ProfilePanel;
    detail: ProfileDetail | null;
    mode: "push" | "replace";
  } | null>(null);
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [vaultCheckFailed, setVaultCheckFailed] = useState(false);
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
  const [marketplaceOptIn, setMarketplaceOptIn] = useState(false);
  const [loadingMarketplaceOptIn, setLoadingMarketplaceOptIn] = useState(true);
  const [savingMarketplaceOptIn, setSavingMarketplaceOptIn] = useState(false);
  // The combined find-and-auto-connect setting is explicit and fail-closed.
  const [contactDiscoverable, setContactDiscoverable] = useState(false);
  const [loadingContactDiscoverable, setLoadingContactDiscoverable] =
    useState(true);
  const [savingContactDiscoverable, setSavingContactDiscoverable] =
    useState(false);
  const [supportKind, setSupportKind] =
    useState<SupportMessageKind>("support_request");
  const [supportMessage, setSupportMessage] = useState("");
  const [supportMessageError, setSupportMessageError] = useState<string | null>(
    null,
  );
  const [supportComposerState, setSupportComposerState] =
    useState<SupportComposerState>({ status: "editing" });
  const pendingSupportSubmission = useRef<symbol | null>(null);
  const supportDraft = useRef({ kind: supportKind, message: supportMessage, revision: 0 });
  const changeSupportDraft = useCallback((patch: { kind?: SupportMessageKind; message?: string }) => {
    const next = { ...supportDraft.current, ...patch, revision: supportDraft.current.revision + 1 };
    supportDraft.current = next; // Accept and revision edits before React batches a render.
    setSupportKind(next.kind); setSupportMessage(next.message); setSupportMessageError(null);
    setSupportComposerState(current => current.status === "error" ? { status: "editing" } : current);
  }, []);
  const [gmailActionBusy, setGmailActionBusy] = useState<
    "connect" | "disconnect" | "sync" | null
  >(null);
  const [savingFinancialContext, setSavingFinancialContext] = useState(false);
  const financialDraft = useRef({ text: "", category: "general" as FinancialContextCategory, target: null as string | null, revision: 0 });
  const [financialContextText, renderFinancialContextText] = useState("");
  const [financialContextCategory, renderFinancialContextCategory] =
    useState<FinancialContextCategory>("general");
  const [editingFinancialContextId, renderEditingFinancialContextId] = useState<
    string | null
  >(null);
  const setFinancialContextText = useCallback((text: string) => {
    financialDraft.current = { ...financialDraft.current, text, revision: financialDraft.current.revision + 1 }; renderFinancialContextText(text);
  }, []);
  const setFinancialContextCategory = useCallback((category: FinancialContextCategory) => {
    financialDraft.current = { ...financialDraft.current, category, revision: financialDraft.current.revision + 1 }; renderFinancialContextCategory(category);
  }, []);
  const setEditingFinancialContextId = useCallback((target: string | null) => {
    financialDraft.current = { ...financialDraft.current, target, revision: financialDraft.current.revision + 1 }; renderEditingFinancialContextId(target);
  }, []);
  const [nativeContextOpen, setNativeContextOpen] = useState(false);
  const [nativeContextFailed, setNativeContextFailed] = useState(false);
  const [nativeContextError, setNativeContextError] = useState<string | null>(null);
  const vaultUnlockCompletingRef = useRef(false);
  const vaultCreationCompletingRef = useRef(false);
  const supportMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const supportSuccessHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const legacyProfileRedirectHref = useMemo(
    () =>
      isPanePresentation
        ? null
        : (buildLegacyDocumentPayoutReturnRoute(pathname, searchParams) ??
          buildCanonicalProfileRouteFromLegacyQuery(pathname, searchParams)),
    [isPanePresentation, pathname, searchParams],
  );
  const profileRouteState = useMemo(
    () =>
      isPanePresentation
        ? (paneLocation ?? resolveProfilePaneUrlState(searchParams).location)
        : resolveProfileRouteState(pathname, searchParams),
    [isPanePresentation, paneLocation, pathname, searchParams],
  );
  const localCrmEnabled = isLocalCrmBuildEnabled();
  const activePanel =
    profileRouteState.panel === "connected-systems" && !localCrmEnabled
      ? null
      : profileRouteState.panel;
  const activeDetail = activePanel ? profileRouteState.detail : null;
  const emailPreference = useMarketingPreference(activePanel === "account" ? applicationOwnerId ?? null : null, "account");
  const phoneVaultEpoch = snapshotVaultSessionEpoch();
  const phoneVisit = useMemo(() => ({ active: false, id: Symbol("phone-visit"), userId: applicationOwnerId, owner: snapshotValidatedAuthSessionPrincipal(),
    vaultEpoch: phoneVaultEpoch, enabled: activePanel === "account" && activeDetail === "phone" &&
      (presentation !== "native-page" || nativeMenuOpen) }),
  [applicationOwnerId, phoneVaultEpoch, activePanel, activeDetail, presentation, nativeMenuOpen]);
  useLayoutEffect(() => { phoneVisit.active = true; return () => { phoneVisit.active = false; }; }, [phoneVisit]);
  const phoneVisitIsCurrent = () => phoneVisit.active && phoneVisit.enabled && !!phoneVisit.owner &&
    phoneVisit.owner.userId === applicationOwnerId && isValidatedAuthSessionOwnerCurrent(phoneVisit.owner) &&
    phoneVisit.vaultEpoch === snapshotVaultSessionEpoch();
  const devicesActive = activePanel === "security" && activeDetail === "trusted-devices";
  const devicesParent = devicesActive ? profilePanelParentForPresentation("security", panePresentation?.history) : null;
  const devicesModel = useTrustedDevicesModel(applicationOwnerId ?? null, !!user && !authLoading && isVaultUnlocked &&
    devicesActive && (presentation !== "native-page" || nativeMenuOpen));
  const [nativeDevicesAvailable, setNativeDevicesAvailable] = useState(false);
  const nativeDevices = useNativeTrustedDevices(devicesModel, JSON.stringify([applicationOwnerId, snapshotVaultSessionEpoch()]),
    presentation === "native-page" && nativeDevicesAvailable);
  useBackLayer(pathname, devicesActive && devicesModel.confirmation ? 3 : 0, () => {
    if (!devicesActive || !devicesModel.confirmation) return false;
    devicesModel.cancel(); return true;
  }, isPanePresentation ? { profile_pane: "1" } : undefined);
  const phoneBackStep = useRef<(() => boolean) | null>(null);
  const bindPhoneBackStep = useCallback((handler: (() => boolean) | null) => {
    phoneBackStep.current = handler;
  }, []);
  useBackLayer(pathname, isVaultUnlocked && activePanel === "account" && activeDetail === "phone" &&
    (presentation !== "native-page" || nativeMenuOpen) ? 2 : 0,
  () => phoneBackStep.current?.() ?? false, isPanePresentation ? { profile_pane: "1" } : undefined);
  useBackLayer(pathname, presentation === "native-page" && nativeMenuOpen && activePanel === "account" &&
    !activeDetail && (showDeleteConfirm || showResetConfirm) ? 3 : 0, () => {
      // Global/voice Back observes the same local confirmation boundary as
      // UIKit Back. Busy operations consume Back without repeating or closing.
      if (presentation !== "native-page" || !nativeMenuOpen || activePanel !== "account" || activeDetail ||
          !showDeleteConfirm && !showResetConfirm) return false;
      dismissAccountConfirmation(); return true;
    }, { profile_pane: "1" });
  useLayoutEffect(() => {
    // The pane remains mounted while closed. External navigation and late
    // preflight settlement cannot retain an idle confirmation for a new visit.
    if (presentation === "native-page" && (!nativeMenuOpen || activePanel !== "account" || activeDetail)) {
      dismissAccountConfirmation();
    }
  }, [presentation, nativeMenuOpen, activePanel, activeDetail, showDeleteConfirm, showResetConfirm, dismissAccountConfirmation]);
  useEffect(() => {
    if (activePanel !== "account" || activeDetail) {
      setNativeAccountException(null); setEditingDisplayName(false);
    }
  }, [activePanel, activeDetail, applicationOwnerId]);
  useEffect(() => {
    if (!editingDisplayName && nativeAccountException === "name") setNativeAccountException(null);
  }, [editingDisplayName, nativeAccountException]);
  const nativeDetailOwner = JSON.stringify([applicationOwnerId, snapshotVaultSessionEpoch()]);
  const memoryOperations = useMemo(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    const epoch = snapshotVaultSessionEpoch();
    return new ProfileMemoryOperations(() => !!owner && owner.userId === applicationOwnerId &&
      JSON.stringify([owner.userId, snapshotVaultSessionEpoch()]) === nativeDetailOwner &&
      isValidatedAuthSessionOwnerCurrent(owner) && snapshotVaultSessionEpoch() === epoch);
  }, [nativeDetailOwner, applicationOwnerId]);
  useLayoutEffect(() => {
    memoryOperations.activate();
    setPendingPermissionToggles({});
    setPkmMetadata(null); setConsentCenter(null); setDomainManifests({});
    setPkmError(null); setConsentCenterError(null);
    setDomainManifestErrors({}); setLoadingDomainManifests({});
    setSavingFinancialContext(false); setFinancialContextText(""); setEditingFinancialContextId(null); setFinancialContextCategory("general");
    setNativeContextOpen(false); setNativeContextError(null);
    setDomainPreview({ open: false, permissionKey: null, domainKey: null, topLevelScopePath: null,
      title: "", description: "", presentation: null, loading: false, error: null, deletingEntityKey: null });
    return () => memoryOperations.retire();
  }, [memoryOperations, setFinancialContextText, setEditingFinancialContextId, setFinancialContextCategory]);
  useLayoutEffect(() => {
    memoryOperations.cancelPreview();
    return () => memoryOperations.cancelPreview();
  }, [memoryOperations, activePanel, activeDetail, nativeMenuOpen]);
  const closeDomainPreview = () => {
    memoryOperations.cancelPreview();
    setDomainPreview(value => ({ ...value, open: false }));
  };
  const accountPreparationOwner = useRef<string | null>(nativeDetailOwner);
  useLayoutEffect(() => {
    // A confirmation is not an authorization that survives owner/vault change.
    const preparation = accountPreparation.current;
    preparation.invalidate();
    accountPreparationOwner.current = nativeDetailOwner;
    setShowDeleteConfirm(false); setShowResetConfirm(false);
    return () => { preparation.invalidate(); accountPreparationOwner.current = null; };
  }, [nativeDetailOwner]);
  const supportOwner = useRef<string | null>(nativeDetailOwner);
  const supportDraftOwner = useRef(nativeDetailOwner);
  useLayoutEffect(() => {
    if (supportDraftOwner.current !== nativeDetailOwner) {
      supportDraftOwner.current = nativeDetailOwner;
      changeSupportDraft({ kind: "support_request", message: "" }); setSupportComposerState({ status: "editing" });
    }
    supportOwner.current = nativeDetailOwner;
    return () => { supportOwner.current = null; pendingSupportSubmission.current = null; };
  }, [nativeDetailOwner, changeSupportDraft]);
  const [nativeActiveHeading, setNativeActiveHeading] = useState<{ owner: string; title: string } | null>(null);
  const updateNativeActiveHeading = useCallback((entry: Pick<ProfileStackEntry, "key" | "title"> | null) => {
    const title = typeof entry?.title === "string" ? entry.title : "Profile";
    setNativeActiveHeading(previous => previous?.owner === nativeDetailOwner && previous.title === title
      ? previous : { owner: nativeDetailOwner, title });
  }, [nativeDetailOwner]);
  const preferenceChrome = {
    owner: applicationOwnerId ?? null,
    context: JSON.stringify([pathname, isPanePresentation, activePanel, activeDetail, snapshotVaultSessionEpoch()]),
    eligible: nativeControlsEligible && !!user && !authLoading && activePanel === "preferences" && !activeDetail && (!isPanePresentation || isVaultUnlocked),
  };
  const supportComposeKind =
    activePanel === "support" && activeDetail?.startsWith("support-compose:")
      ? normalizeSupportKind(activeDetail.slice("support-compose:".length))
      : null;
  const supportQueryKind =
    activePanel === "support"
      ? normalizeSupportKind(searchParams.get("kind"))
      : null;
  const supportRouteKind = supportComposeKind ?? supportQueryKind;
  const sendingSupportMessage = supportComposerState.status === "sending";
  const supportPresentation = SUPPORT_INTENT_PRESENTATION[supportKind];
  useDocumentFeedStream(
    activePanel === "payouts" && !authLoading ? user : null,
  );

  const effectiveReplyEmail = user?.emailVerified
    ? user.email?.trim() || ""
    : "";
  const supportReplyLine = effectiveReplyEmail
    ? `Replies go to ${effectiveReplyEmail}`
    : "Verify an account email to receive a reply.";
  const supportMessageErrorId = "support-message-error";
  const supportSendStatusId = "support-send-status";
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
      enabled: !isPanePresentation,
      behavior: "auto",
    },
  );

  useEffect(() => {
    if (!legacyProfileRedirectHref) return;
    router.replace(legacyProfileRedirectHref, { scroll: false });
  }, [legacyProfileRedirectHref, router]);

  useEffect(() => {
    if (!supportRouteKind || supportRouteKind === supportDraft.current.kind) return;
    changeSupportDraft({ kind: supportRouteKind });
  }, [supportRouteKind, nativeDetailOwner, changeSupportDraft]);

  const legacySupportRouteHref = useMemo(() => {
    if (isPanePresentation || activePanel !== "support") return null;
    if (activeDetail === "support-routing") {
      return buildProfileRoute({
        panel: "support",
        detail: null,
        searchParams,
      });
    }
    if (supportComposeKind) {
      return buildProfileRoute({
        panel: "support",
        detail: `support-compose:${supportComposeKind}`,
        searchParams,
      });
    }
    return null;
  }, [
    activeDetail,
    activePanel,
    isPanePresentation,
    searchParams,
    supportComposeKind,
  ]);

  useEffect(() => {
    if (!legacySupportRouteHref || isPanePresentation) return;
    router.replace(legacySupportRouteHref, { scroll: false });
  }, [isPanePresentation, legacySupportRouteHref, router]);

  useEffect(() => {
    if (supportComposerState.status !== "sent") return;
    supportSuccessHeadingRef.current?.focus();
  }, [supportComposerState.status]);

  const provider = getProvider(user);
  const gmailRouteHref = searchParamsString
    ? `${pathname}?${searchParamsString}`
    : pathname;
  const gmailIdTokenProvider = useCallback(
    () => (user?.getIdToken ? user.getIdToken() : Promise.resolve("")),
    [user],
  );
  const gmail = useGmailConnectorStatus({
    userId: applicationOwnerId || null,
    enabled: Boolean(applicationOwnerId) && !authLoading && activePanel === "gmail",
    idTokenProvider: user?.getIdToken ? gmailIdTokenProvider : null,
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
        authLoading,
        presenceFailed: vaultCheckFailed,
      }),
    [
      authLoading,
      hasVault,
      isVaultUnlocked,
      vaultCheckFailed,
      vaultKey,
      vaultOwnerToken,
    ],
  );
  const vaultMethods = useProfileVaultMethodsModel({ userId: applicationOwnerId ?? null, vaultKey, vaultOwnerToken,
    hasVault, authLoading, canMutate: vaultAccess.canMutateSecureData,
    active: activePanel === "security" && activeDetail === "vault" && (presentation !== "native-page" || nativeMenuOpen),
    displayName: user?.displayName || user?.email || "Hussh User", requestUnlock: () => requestVaultUnlock("profile_data") });
  const { primaryMethod: vaultMethod, capability: capabilityMatrix, wrappers: enrolledVaultWrappers,
    primaryWrapperId: primaryVaultWrapperId, effectiveMethod: effectiveVaultMethod, loading: loadingVaultMethod,
    needsRefresh: vaultMethodsNeedRefresh, owner: vaultMethodsOwner, localBiometricId: localBiometricWrapperId,
    busy: switchingVaultMethod, passphraseOpen: passphraseDialogOpen, removal: passkeyRemovalTarget,
    password: newPassphrase, confirmation: confirmPassphrase } = vaultMethods;
  const [nativeVaultAvailable, setNativeVaultAvailable] = useState(false);
  const [nativePricingAvailable, setNativePricingAvailable] = useState(false);
  const [nativeMemoryAvailable, setNativeMemoryAvailable] = useState(false);
  const [nativeSharedMemoryAvailable, setNativeSharedMemoryAvailable] = useState(false);
  const [nativeSecretsAvailable, setNativeSecretsAvailable] = useState(false);
  const [nativeWorldModelAvailable, setNativeWorldModelAvailable] = useState(false);
  const [nativeConnectorsAvailable, setNativeConnectorsAvailable] = useState(false);
  const [nativePaymentsAvailable, setNativePaymentsAvailable] = useState(false);
  const [nativePaymentsFailed, setNativePaymentsFailed] = useState(false);
  const agentSettingsActive = (activePanel === "hosting" || activePanel === "software-updates") &&
    (presentation !== "native-page" || nativeMenuOpen) && vaultAccess.canMutateSecureData;
  const agentSettings = useAgentSettingsController({ kind: activePanel === "hosting" ? "hosting" : "software-updates",
    userId: applicationOwnerId || null, enabled: agentSettingsActive });
  const nativeAgentSettings = useNativeAgentSettings(agentSettings, agentSettingsActive, nativeDetailOwner);
  const nativeConnectorsWanted = presentation === "native-page" && nativeMenuOpen && nativeConnectorsAvailable &&
    activePanel === "connectors" && vaultAccess.canMutateSecureData;
  const nativeConnectors = useNativeConnectors(retainedConnectors, nativeDetailOwner, nativeConnectorsWanted);
  const nativeConnectorsActive = nativeConnectorsWanted && (!retainedConnectors || nativeConnectors.mapped) && !nativeConnectors.failed;
  useBackLayer(pathname, nativeConnectorsActive && nativeConnectors.nested ? 3 : 0, nativeConnectors.back, { profile_pane: "1" });
  const nativeWorldModelActive = presentation === "native-page" && nativeMenuOpen && nativeWorldModelAvailable &&
    activePanel === "world-model" && vaultAccess.canMutateSecureData;
  const worldModel = usePersonalWorldModelModel({ embedded: true, enabled: activePanel === "world-model" &&
    (presentation !== "native-page" || nativeMenuOpen) });
  const [nativeMemoryWebBody, setNativeMemoryWebBody] = useState(false);
  const nativeMemoryActive = presentation === "native-page" && nativeMenuOpen && nativeMemoryAvailable &&
    activePanel === "my-data" && vaultAccess.canMutateSecureData;
  const contextVisit = useMemo(() => {
    const visit = { active: false, panel: activePanel, detail: activeDetail, open: nativeMenuOpen,
      current: () => visit.active && visit.panel === "my-data" && (presentation !== "native-page" || visit.open) && memoryOperations.current() };
    return visit;
  }, [memoryOperations, activePanel, activeDetail, nativeMenuOpen, presentation]);
  useLayoutEffect(() => {
    contextVisit.active = true;
    setNativeContextOpen(false); setNativeContextFailed(false); setNativeContextError(null);
    return () => { contextVisit.active = false; };
  }, [contextVisit]);
  useLayoutEffect(() => { setNativeMemoryWebBody(false); }, [activeDetail, nativeMenuOpen, nativeDetailOwner]);
  const memoryShared = useMemorySharedModel({ owner: nativeDetailOwner, token: vaultOwnerToken, visit: activeDetail,
    active: activePanel === "my-data" && isVaultUnlocked && (presentation !== "native-page" || nativeMenuOpen && (!nativeMemoryAvailable || nativeSharedMemoryAvailable || nativeMemoryWebBody)),
    native: nativeMemoryActive && nativeSharedMemoryAvailable && !nativeMemoryWebBody, current: contextVisit.current });
  const memorySecrets = useSecretsListModel({
    active: activePanel === "my-data" && isVaultUnlocked && (presentation !== "native-page" || nativeMenuOpen && (!nativeMemoryAvailable || nativeSecretsAvailable || nativeMemoryWebBody)),
    native: nativeMemoryActive && nativeSecretsAvailable && !nativeMemoryWebBody, current: contextVisit.current });
  const paymentsEnabled = activePanel === "payouts" && vaultAccess.canMutateSecureData && (presentation !== "native-page" || nativeMenuOpen);
  const nativePayoutActive = presentation === "native-page" && paymentsEnabled && nativePaymentsAvailable && !nativePaymentsFailed;
  const nativePayout = useNativePayments(paymentsEnabled, nativePayoutActive, nativeDetailOwner);
  useLayoutEffect(() => { if (!nativeMenuOpen || activePanel !== "payouts") setNativePaymentsFailed(false); }, [nativeMenuOpen, activePanel]);
  const nativeReferralActive = presentation === "native-page" && nativeMenuOpen &&
    activePanel === "referrals" && isVaultUnlocked;
  const nativeReferrals = useNativeReferrals(presentation === "native-page" && nativeMenuOpen && activePanel === "referrals", applicationOwnerId ?? null);
  useBackLayer(pathname, nativePayoutActive && nativePayout.nested ? 3 : 0, nativePayout.back,
    isPanePresentation ? { profile_pane: "1" } : undefined);
  const [nativePricingEditorOpen, setNativePricingEditorOpen] = useState(false);
  const [nativePricingFailed, setNativePricingFailed] = useState(false);
  const nativePricingActive = presentation === "native-page" && nativeMenuOpen && nativePricingAvailable &&
    activePanel === "request-pricing" && !activeDetail && vaultAccess.canMutateSecureData && !nativePricingFailed;
  const nativePricingModel = useDocumentRequestPricingModel({ enabled: presentation === "native-page" && nativeMenuOpen && nativePricingAvailable &&
    activePanel === "request-pricing" && !activeDetail && vaultAccess.canMutateSecureData });
  const nativePricing = projectNativeRequestPricing(nativePricingModel, () => setNativePricingEditorOpen(true));
  useLayoutEffect(() => { if (activePanel !== "request-pricing" || !nativeMenuOpen) { setNativePricingEditorOpen(false); setNativePricingFailed(false); } }, [activePanel, nativeMenuOpen]);
  const [nativeVaultPasswordFallback, setNativeVaultPasswordFallback] = useState(false);
  const vaultParent = activePanel === "security" && activeDetail === "vault" ? profilePanelParentForPresentation("security", panePresentation?.history) : null;
  const vaultNativeActive = presentation === "native-page" && nativeMenuOpen && nativeVaultAvailable &&
    activePanel === "security" && activeDetail === "vault" && vaultAccess.canMutateSecureData && vaultParent !== null && !nativeVaultPasswordFallback;
  const nativeVault = useNativeVaultMethods(vaultMethods, vaultNativeActive, vaultAccess.canMutateSecureData);
  useLayoutEffect(() => { if (!passphraseDialogOpen) setNativeVaultPasswordFallback(false); }, [passphraseDialogOpen]);
  useBackLayer(pathname, vaultNativeActive && nativeVault.nested ? 3 : 0, nativeVault.back,
    isPanePresentation ? { profile_pane: "1" } : undefined);
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
    if (activePanel !== "my-data" || !activeDetail?.startsWith("connection:"))
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
        const nextLocation = {
          panel: typeof next.panel === "undefined" ? activePanel : next.panel,
          detail:
            typeof next.detail === "undefined" ? activeDetail : next.detail,
        };
        if (isPanePresentation) {
          if (mode === "push") {
            pushProfilePaneLocation(pathname, searchParams, nextLocation);
          } else {
            replaceProfilePaneLocation(pathname, searchParams, nextLocation);
          }
          return;
        }
        // Preserve only the `from` origin marker (not transient vault/return
        // keys, which must not re-fire while drilling panels) so the shared
        // top-bar back control can retrace to wherever Profile was opened from,
        // even after Profile → panel → detail → back all the way out.
        const originFrom = searchParams.get("from");
        const originParams = originFrom
          ? new URLSearchParams({ from: originFrom })
          : undefined;
        const href = buildProfileRoute({
          panel: nextLocation.panel,
          detail: nextLocation.detail,
          searchParams: originParams,
        });
        if (mode === "push") {
          router.push(href, { scroll: false });
        } else {
          router.replace(href, { scroll: false });
        }
      },
    [
      activeDetail,
      activePanel,
      isPanePresentation,
      pathname,
      router,
      searchParams,
    ],
  );

  const nativeWorldModel = useNativeWorldModel({ active: nativeWorldModelActive, owner: nativeDetailOwner, model: worldModel,
    onAccount: () => updateProfileView({ panel: "account", detail: null }, "push"),
    onMemory: () => updateProfileView({ panel: "my-data", detail: null }, "push") });
  const changeRetainedConnector = useCallback((id: string | null) => updateProfileView({ panel: "connectors", detail: id ? `connector:${id}` : null }, "push"), [updateProfileView]);
  useBackLayer(pathname, nativeWorldModelActive && nativeWorldModel.nested ? 3 : 0, nativeWorldModel.back,
    isPanePresentation ? { profile_pane: "1" } : undefined);
  const nativeMemory = useNativeMemory({
    active: nativeMemoryActive, owner: nativeDetailOwner, detail: activePanel === "my-data" ? activeDetail : null,
    loading: loadingPkmMetadata || loadingConsentCenter, metadataReady: pkmMetadataReady, sharingReady: consentCenterReady,
    metadataFailed: !!pkmError, sharingFailed: !!consentCenterError, domains: domainPresentations, connections: accessConnections,
    selectedDomain, selectedConnection, permissions: selectedDomainPermissions, upgrade: selectedDomainUpgrade,
    manifestLoading: !!selectedDomain && !!loadingDomainManifests[selectedDomain.key],
    manifestFailed: !!selectedDomain && !!domainManifestErrors[selectedDomain.key], pendingPermissions: pendingPermissionToggles,
    preview: domainPreview,
    shared: nativeSharedMemoryAvailable ? memoryShared : undefined,
    secrets: nativeSecretsAvailable ? memorySecrets : undefined,
    openDomain: key => updateProfileView({ panel: "my-data", detail: `domain:${key}` }, "push"),
    openConnection: id => updateProfileView({ panel: "my-data", detail: `connection:${id}` }, "push"),
    openSharing: () => updateProfileView({ panel: "my-data", detail: "sharing" }, "push"),
    openRoot: () => updateProfileView({ panel: "my-data", detail: null }, "replace"),
    refresh: () => { void refreshPkmMetadata(true); void refreshConsentCenter(true); void refreshVisibleDomainManifests(true); },
    navigate: href => router.push(href),
    closePreview: closeDomainPreview,
    openRetainedDetails: () => setNativeMemoryWebBody(true),
    openFinancialContext: () => {
      if (!memoryOperations.current() || memoryOperations.writing("financial")) return;
      setEditingFinancialContextId(null); setFinancialContextText(""); setFinancialContextCategory("general");
      setNativeContextError(null); setNativeContextOpen(true);
    },
    previewPermission: permission => selectedDomain ? handlePreviewDomainPermission(selectedDomain.key, permission) : Promise.resolve(),
    setPosture: (permission, posture) => selectedDomain ? handleToggleDomainPermission(selectedDomain.key, permission, posture) : Promise.resolve(),
    removeEntity: entity => handleDeletePkmPreviewEntity(entity),
    editEntity: entity => {
      if (!handleEditFinancialContextEntry(entity)) return;
      setNativeContextError(null); setNativeContextOpen(true);
    },
    revoke: scope => handleRevoke(scope, undefined, { quiet: true }),
  });
  useBackLayer(pathname, nativeMemoryActive && !nativeMemoryWebBody && nativeMemory.nested ? 3 : 0, nativeMemory.back,
    isPanePresentation ? { profile_pane: "1" } : undefined);
  useBackLayer(pathname, nativeMemoryActive && nativeMemoryWebBody ? 3 : 0, () => {
    if (savingFinancialContext) return true;
    setNativeMemoryWebBody(false); return true;
  }, isPanePresentation ? { profile_pane: "1" } : undefined);

  const nativePreferences = useNativeProfilePreferences({
    enabled: presentation === "native-page" && nativeMenuOpen && activePanel === "preferences" && !activeDetail && isVaultUnlocked,
    retainDraft: presentation === "native-page" && nativeMenuOpen && activePanel === "preferences" && isVaultUnlocked,
    userId: applicationOwnerId ?? null, vaultKey, vaultOwnerToken,
    onGemini: () => updateProfileView({ panel: "preferences", detail: "gemini" }, "push"),
    onVoice: () => updateProfileView({ panel: "preferences", detail: "voice" }, "push"),
  });
  const [nativeVoiceAvailable, setNativeVoiceAvailable] = useState(false);
  const voiceParent = profilePanelParentForPresentation("preferences", panePresentation?.history);
  const [nativeRuntimeAvailable, setNativeRuntimeAvailable] = useState(false);
  const runtimeSettings = useGeminiRuntimeSettingsModel({ userId: applicationOwnerId, vaultKey, vaultOwnerToken,
    needsVaultCreation: vaultAccess.needsVaultCreation, needsUnlock: vaultAccess.needsUnlock,
    onRequestVaultCreation: () => requestVaultUnlock("profile_data"), onRequestVaultUnlock: () => requestVaultUnlock("profile_data"),
    enabled: activePanel === "preferences" && activeDetail === "gemini" && (presentation !== "native-page" || nativeMenuOpen) });
  const nativeRuntimeEligible = runtimeSettings.placement === "shared" && !runtimeSettings.otherProvider && nativeRuntimeAvailable && voiceParent !== null && presentation === "native-page" && nativeMenuOpen &&
    activePanel === "preferences" && activeDetail === "gemini" && isVaultUnlocked;
  const nativeRuntime = useNativeRuntimeSettings(runtimeSettings, nativeDetailOwner, nativeRuntimeEligible);
  const nativeRuntimeActive = nativeRuntimeEligible && !nativeRuntime.failed;
  useBackLayer(pathname, nativeRuntimeActive && (runtimeSettings.isSaving || runtimeSettings.isRemoving) ? 3 : 0,
    () => runtimeSettings.operationPending(), isPanePresentation ? { profile_pane: "1" } : undefined);
  const [nativeFinanceAvailable, setNativeFinanceAvailable] = useState(false);
  const nativeFinanceActive = nativeFinanceAvailable && voiceParent !== null && presentation === "native-page" &&
    nativeMenuOpen && activePanel === "preferences" && activeDetail === "kai-preferences" && isVaultUnlocked && vaultAccess.canMutateSecureData;
  const financePreferences = useProfileFinancePreferences({ userId: applicationOwnerId ?? null, vaultKey, vaultOwnerToken,
    canEdit: Boolean(applicationOwnerId && vaultAccess.hasVault && vaultAccess.canMutateSecureData), active: nativeFinanceActive });
  const nativeFinance = projectNativeFinancePreferences(financePreferences);
  useBackLayer(pathname, nativeFinanceActive && (financePreferences.wizard.step > 0 || financePreferences.wizard.horizonDialogOpen || nativeFinance.busy) ? 3 : 0,
    nativeFinance.back, isPanePresentation ? { profile_pane: "1" } : undefined);
  const nativeVoice = useNativeVoiceProfile({
    enabled: nativeVoiceAvailable && voiceParent !== null && presentation === "native-page" && nativeMenuOpen && activePanel === "preferences" && activeDetail === "voice" && isVaultUnlocked,
    userId: applicationOwnerId ?? null, vaultOwnerToken, getIdToken: voiceGetIdToken,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadVaultState() {
      if (authLoading) return;
      if (!applicationOwnerId) return;
      try {
        const next = await VaultService.checkVault(applicationOwnerId);
        if (!cancelled) {
          setHasVault(next);
          setVaultCheckFailed(false);
        }
      } catch (error) {
        console.warn("[ProfilePage] Failed to check vault existence:", error);
        // A failed read is not an absent vault. Treating it as false opens the
        // creation flow for users who already have a vault.
        if (!cancelled) setVaultCheckFailed(true);
      }
    }

    void loadVaultState();

    return () => {
      cancelled = true;
    };
  }, [authLoading, applicationOwnerId]);


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
      setContactDiscoverable(false);
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
        // Keep the fail-closed default; a failed read must never imply consent.
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
      if (!user || !applicationOwnerId || hasVault === null || !memoryOperations.current()) return;
      const request = memoryOperations.beginRead("metadata");
      setLoadingPkmMetadata(true);
      try {
      const metadata = await loadProfilePkmMetadataForVaultState({
        userId: applicationOwnerId,
        hasVault,
        force,
        vaultOwnerToken,
      });
      if (!request.current()) return;
      setPkmMetadata(previous => request.current() ? metadata : previous);
      setPkmError(null);
      if (!hasVault) {
        setDomainManifests({});
        setDomainManifestErrors({});
        setLoadingDomainManifests({});
      }
      return metadata;
      } finally { if (request.current()) setLoadingPkmMetadata(false); }
    },
    [hasVault, user, applicationOwnerId, vaultOwnerToken, memoryOperations],
  );

  // A domain written on another route (Wallet, Kai import, chat) reaches this
  // screen through the epoch when it mounts later, and through the event
  // while it is mounted. Either way the metadata is re-read, not patched.
  const appliedPkmEpochRef = useRef(0);
  useEffect(() => {
    const uid = applicationOwnerId;
    if (!uid || hasVault === null || typeof window === "undefined") return;
    const epoch = currentPkmInvalidationEpoch(uid);
    if (epoch > appliedPkmEpochRef.current) {
      appliedPkmEpochRef.current = epoch;
      void refreshPkmMetadata(true).catch(() => undefined);
    }
    const handleDomainChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: unknown }>).detail;
      if (detail?.userId !== uid) return;
      appliedPkmEpochRef.current = currentPkmInvalidationEpoch(uid);
      void refreshPkmMetadata(true).catch(() => undefined);
    };
    window.addEventListener("pkm-domain-changed", handleDomainChanged);
    return () =>
      window.removeEventListener("pkm-domain-changed", handleDomainChanged);
  }, [hasVault, refreshPkmMetadata, applicationOwnerId]);

  const refreshDomainManifest = useCallback(
    async (domainKey: string, force = false, recoveryIsCurrent?: () => boolean) => {
      if (!applicationOwnerId || !vaultOwnerToken || !memoryOperations.current()) return null;
      const request = memoryOperations.beginRead(`manifest:${domainKey}`);
      setLoadingDomainManifests((current) => ({
        ...current,
        [domainKey]: true,
      }));
      try {
        const manifest = await PersonalKnowledgeModelService.getDomainManifest(
          applicationOwnerId,
          domainKey,
          vaultOwnerToken,
          force,
        );
        if (!request.current() || recoveryIsCurrent && !recoveryIsCurrent()) return null;
        setDomainManifests((current) => !request.current() || memoryOperations.writing(domainKey) && !recoveryIsCurrent?.() ||
          (!manifest && !!current[domainKey]) || manifest && (current[domainKey]?.manifest_version ?? 0) > manifest.manifest_version ? current : ({
          ...current,
          [domainKey]: manifest,
        }));
        setDomainManifestErrors((current) => ({
          ...current,
          [domainKey]: null,
        }));
        return manifest;
      } catch (_error) {
        if (!request.current()) return null;
        const message = "Couldn't load sharing controls for these details.";
        setDomainManifestErrors((current) => ({
          ...current,
          [domainKey]: message,
        }));
        return null;
      } finally {
        if (request.current()) setLoadingDomainManifests((current) => ({
          ...current,
          [domainKey]: false,
        }));
      }
    },
    [applicationOwnerId, vaultOwnerToken, memoryOperations],
  );

  const refreshVisibleDomainManifests = useCallback(
    async (force = false) => {
      if (!applicationOwnerId || !vaultOwnerToken) return;
      const domainKeys = (pkmMetadata?.domains || [])
        .filter(isConsumerVisiblePkmDomain)
        .map((domain) => domain.key);
      if (domainKeys.length === 0) return;
      await Promise.all(
        domainKeys.map((domainKey) => refreshDomainManifest(domainKey, force)),
      );
    },
    [pkmMetadata?.domains, refreshDomainManifest, applicationOwnerId, vaultOwnerToken],
  );

  useEffect(() => {
    if (!applicationOwnerId || !shouldLoadProfileWorkspaceData) return;

    const handleUpgradeCompleted = (event: Event) => {
      const detail = (event as CustomEvent<PkmUpgradeCompletedEventDetail>)
        .detail;
      if (detail?.userId !== applicationOwnerId) {
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
    applicationOwnerId,
    vaultAccess.needsUnlock,
    vaultAccess.needsVaultCreation,
    vaultOwnerToken,
  ]);

  const refreshConsentCenter = useCallback(
    async (force = false) => {
      if (!user || !applicationOwnerId || !memoryOperations.current()) return;
      const request = memoryOperations.beginRead("sharing");
      setLoadingConsentCenter(true);
      try {
      const idToken = await user.getIdToken();
      if (!request.current()) return;
      const nextCenter = await ConsentCenterService.getCenter({
        idToken,
        userId: applicationOwnerId,
        actor: "investor",
        view: "active",
        force,
      });
      if (!request.current()) return;
      setConsentCenter(previous => request.current() ? nextCenter : previous);
      setConsentCenterError(null);
      } finally { if (request.current()) setLoadingConsentCenter(false); }
    },
    [user, applicationOwnerId, memoryOperations],
  );

  const { handleRevoke } = useConsentActions({
    userId: applicationOwnerId ?? null,
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

      if (!user || !applicationOwnerId || hasVault === null || !memoryOperations.current()) return;
      const metadataRead = memoryOperations.beginRead("metadata");
      const sharingRead = memoryOperations.beginRead("sharing");
      try {
        setLoadingPkmMetadata(true);
        setLoadingConsentCenter(true);

        const idToken = await user.getIdToken();
        if (cancelled || !memoryOperations.current()) return;
        const [metadata, center] = await Promise.all([
          loadProfilePkmMetadataForVaultState({
            userId: applicationOwnerId,
            hasVault,
            force: false,
            vaultOwnerToken,
          }),
          ConsentCenterService.getCenter({
            idToken,
            userId: applicationOwnerId,
            actor: "investor",
            view: "active",
            force: false,
          }),
        ]);
        if (cancelled || !memoryOperations.current()) return;
        if (metadataRead.current()) { setPkmMetadata(previous => metadataRead.current() ? metadata : previous); setPkmError(null); setLoadingPkmMetadata(false); }
        if (sharingRead.current()) { setConsentCenter(previous => sharingRead.current() ? center : previous); setConsentCenterError(null); setLoadingConsentCenter(false); }
        if (!hasVault) {
          setDomainManifests({});
          setDomainManifestErrors({});
          setLoadingDomainManifests({});
        }
        completeStep();
      } catch {
        if (!cancelled && memoryOperations.current()) {
          const message = "Couldn't load saved details and access state.";
          if (metadataRead.current()) setPkmError(message);
          if (sharingRead.current()) setConsentCenterError(message);
          completeStep();
        }
      } finally {
        if (!cancelled && memoryOperations.current()) {
          if (metadataRead.current()) setLoadingPkmMetadata(false);
          if (sharingRead.current()) setLoadingConsentCenter(false);
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
    applicationOwnerId,
    completeStep,
    hasVault,
    initialized,
    registerSteps,
    reset,
    shouldLoadProfileWorkspaceData,
    user,
    vaultOwnerToken,
    memoryOperations,
  ]);

  useEffect(() => {
    if (
      activePanel !== "my-data" ||
      authLoading ||
      !applicationOwnerId ||
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
    applicationOwnerId,
    vaultAccess.needsUnlock,
    vaultAccess.needsVaultCreation,
    vaultOwnerToken,
  ]);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error("Sign out error:", error);
    }
  };

  // Returns what actually happened so the voice wrapper narrates the same
  // outcome the screen shows. "unknown" (a lost response after a possible
  // commit) is kept distinct from "failed"; neither is ever spoken as deleted.
  const handleDeleteAccount = async (): Promise<LifecycleOutcome> => {
    const owner = snapshotValidatedAuthSessionPrincipal();
    if (!user || !owner || owner.firebaseUid !== user.uid) return "auth_failed";

    let needsCloudReview = false;
    setIsDeleting(true);

    // Resolve auth first so a vault-unlock requirement is handled as a guard
    // (not as a failed delete). Only the real delete-and-ack work is wrapped in
    // the branded promise toast.
    let resolution: Awaited<ReturnType<typeof resolveDeleteAccountAuth>>;
    try {
      resolution = await resolveDeleteAccountAuth({
        userId: owner.ownerId,
        owner,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });
    } catch (error) {
      console.error("Delete account auth error:", error);
      morphyToast.error("Failed to delete account. Please try again.");
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      return "auth_failed";
    }

    if (resolution.kind === "needs_unlock") {
      morphyToast.info(
        "Please unlock your vault first to delete your account.",
      );
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setVaultUnlockReason("delete_account");
      setShowVaultUnlock(true);
      return "needs_unlock";
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
              userId: owner.ownerId,
              owner,
              vaultOwnerToken: token,
              sessionUser: user,
              vaultKey,
            });
          })(),
          {
            loading: "Deleting your account...",
            success: "Account deleted.",
            error: accountDeletionErrorMessage,
            variant: "destructive",
          },
        )
        .unwrap();

      // No artificial delay: the success toast already conveyed completion, and
      // FCM cleanup is skipped because the backend has already destroyed the
      // account and its push tokens. Redirect as fast as the session teardown
      // allows.
      if (isValidatedAuthSessionOwnerCurrent(owner)) await signOut({
        redirectTo: buildLoginRouteWithAuthSessionNotice("account_deleted"),
        expectedUserId: owner.ownerId,
        skipFcmCleanup: true,
      });
      return "deleted";
    } catch (error) {
      needsCloudReview = azureAccountCleanupRequired(error);
      if (needsCloudReview && isValidatedAuthSessionOwnerCurrent(owner)) setCloudCleanupRequired(true);
      (isHandledAccountDeletionOutcome(error) ? console.warn : console.error)(
        "Delete account error:",
        error,
      );
      return classifyDeletionError(error);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(needsCloudReview);
    }
  };

  const prepareAccountConfirmation = async (kind: "delete" | "reset") => {
    if (!user || isDeleting || isResetting) return;
    const owner = snapshotValidatedAuthSessionPrincipal();
    const visitOwner = nativeDetailOwner;
    const epoch = snapshotVaultSessionEpoch();
    await accountPreparation.current.request({ hasVault,
      ownerIsCurrent: () => owner?.firebaseUid === user.uid && isValidatedAuthSessionOwnerCurrent(owner) &&
        accountPreparationOwner.current === visitOwner && snapshotVaultSessionEpoch() === epoch,
      checkVault: () => VaultService.checkVault(owner!.ownerId), vaultKnown: setHasVault,
      canMutate: () => vaultAccess.canMutateSecureData && !!getVaultOwnerToken(),
      confirm: () => { setShowDeleteConfirm(kind === "delete"); setShowResetConfirm(kind === "reset"); },
      unlock: () => requestVaultUnlock(kind === "delete" ? "delete_account" : "reset_account"),
    });
  };
  const handleDeleteClick = () => prepareAccountConfirmation("delete");

  const handleResetAccount = async (): Promise<
    "reset" | "not_reset" | "unknown" | "needs_unlock" | "auth_failed"
  > => {
    const owner = snapshotValidatedAuthSessionPrincipal();
    if (!user || !owner || owner.firebaseUid !== user.uid) return "auth_failed";
    const isCurrent = () => isValidatedAuthSessionOwnerCurrent(owner);

    setIsResetting(true);

    let resolution: Awaited<ReturnType<typeof resolveDeleteAccountAuth>>;
    try {
      resolution = await resolveDeleteAccountAuth({
        userId: owner.ownerId,
        owner,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });
    } catch (error) {
      console.error("Reset account auth error:", error);
      morphyToast.error("Failed to reset account. Please try again.");
      setIsResetting(false);
      setShowResetConfirm(false);
      return "auth_failed";
    }

    if (resolution.kind === "needs_unlock") {
      morphyToast.info("Please unlock your vault first to reset your account.");
      setIsResetting(false);
      setShowResetConfirm(false);
      setVaultUnlockReason("reset_account");
      setShowVaultUnlock(true);
      return "needs_unlock";
    }

    setHasVault(resolution.hasVault);

    // Branded actionable loading: keep the toast in its loading state until the
    // reset has been acknowledged and local state has been cleared.
    //
    // Success cleanup runs only on a reset the backend actually confirmed
    // (`success && account_reset`). A resolved promise whose flags say
    // otherwise -- or say nothing -- is not a reset, and a lost response is
    // never permission to reset again.
    // `committed` is set the moment the backend confirms, so a failure in the
    // local cleanup that follows is reported as a committed reset with a
    // failed refresh -- not as an unknown backend outcome.
    const settlement = { committed: false };
    try {
      await morphyToast
        .promise(
          (async () => {
            await revokeVaultBanksBeforeErasure({
              userId: owner.ownerId,
              isCurrent,
              vaultKey,
              vaultOwnerToken: resolution.token,
            });
            if (!isCurrent()) throw new Error("Account changed before reset.");
            const result = await AccountService.resetAccount(resolution.token);
            const resetOutcome = resolveResetOutcome(result);
            if (resetOutcome !== "reset") {
              throw new AccountResetNotConfirmedError(resetOutcome);
            }
            settlement.committed = true;

            CacheSyncService.onAccountDeleted(owner.ownerId);
            await UserLocalStateService.clearForUser(owner.ownerId, { deleteDurableReceipts: true });
            if (!isCurrent()) return;
            await refreshPersonaState({ force: true });
            if (!isCurrent()) return;

            // Reset returns the account to a fresh, just-onboarded state: keep
            // the identity and vault, but re-run onboarding on the next visit.
            setOnboardingRequiredCookie(true);
            setOnboardingFlowActiveCookie(true);
          })(),
          {
            loading: "Resetting your account...",
            success: "Account reset. Restarting onboarding...",
            error: (error: unknown) => resetErrorMessage(error),
            variant: "destructive",
          },
        )
        .unwrap();

      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (isCurrent()) router.replace(ROUTES.ONE_SETUP);
      return "reset";
    } catch (error) {
      console.error("Reset account error:", error);
      if (error instanceof AccountResetNotConfirmedError) return error.outcome;
      return settlement.committed ? "reset" : "unknown";
    } finally {
      setIsResetting(false);
      setShowResetConfirm(false);
    }
  };

  const handleResetClick = () => prepareAccountConfirmation("reset");

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
          ? "People who have your number can find and connect with you automatically."
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

  // `target` is the reviewed state a voice confirmation carries; the switch
  // passes nothing and flips. The stored value comes back from the setter and
  // is what the UI and the voice wrapper both report.
  const handleMarketplaceOptInToggle = async (
    target?: boolean,
  ): Promise<MarketplaceOutcome> => {
    if (!user || !applicationOwnerId) return { kind: "no_user" };
    try {
      setSavingMarketplaceOptIn(true);
      const idToken = await user.getIdToken();
      const result = await RiaService.setInvestorMarketplaceOptIn(
        idToken,
        target ?? !marketplaceOptIn,
      );
      const stored = Boolean(result.investor_marketplace_opt_in);
      setMarketplaceOptIn(stored);
      CacheSyncService.onMarketplaceVisibilityChanged(applicationOwnerId);
      await refreshPersonaState({ force: true });
      toast.success(
        stored
          ? "Investor marketplace profile is now discoverable."
          : "Investor marketplace profile is now hidden.",
      );
      return { kind: "set", value: stored };
    } catch (error) {
      console.error(
        "[ProfilePage] Failed to update marketplace opt-in:",
        error,
      );
      toast.error("Couldn't update marketplace visibility.");
      return { kind: "failed" };
    } finally {
      setSavingMarketplaceOptIn(false);
    }
  };

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
      | "my-data"
      | "payouts"
      | "world-model"
      | "request-pricing"
      | "connected-systems"
      | "connectors"
      | "gmail"
      | "security"
    >,
    detail: ProfileDetail | null = null,
  ) {
    if (vaultAccess.needsVaultCreation && panel !== "security") {
      setPendingProfileTarget({ panel, detail, mode: "push" });
      setShowVaultCreation(true);
      return;
    }
    if (hasVault && vaultAccess.needsUnlock) {
      setPendingProfileTarget({ panel, detail, mode: "push" });
      requestVaultUnlock("profile_data");
      return;
    }
    updateProfileView({ panel, detail }, "push");
  }

  async function submitSupportMessage(
    messageOverride?: string,
  ): Promise<SupportSubmitOutcome> {
    if (!user || !applicationOwnerId) return { kind: "no_user" };
    if (sendingSupportMessage || pendingSupportSubmission.current) return { kind: "busy" };

    // Voice dictates the message rather than typing it into the composer, and
    // React state set in the same tick would not be readable here. Every
    // validation below still runs on it -- a dictated message that is too
    // short is refused exactly like a typed one.
    const submittedDraft = supportDraft.current;
    const kind = submittedDraft.kind;
    const trimmedMessage = (messageOverride ?? submittedDraft.message).trim();
    const presentation = SUPPORT_INTENT_PRESENTATION[kind];

    if (trimmedMessage.length < 10) {
      setSupportMessageError("Write at least 10 characters.");
      setSupportComposerState({ status: "editing" });
      supportMessageRef.current?.focus();
      return { kind: "too_short" };
    }
    if (trimmedMessage.length > 8000) {
      setSupportMessageError("Keep your message under 8,000 characters.");
      return { kind: "rejected" };
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSupportComposerState({
        status: "error",
        message: "You're offline. Reconnect to send your message.",
      });
      return { kind: "offline" };
    }

    setSupportMessageError(null);
    const submission = Symbol();
    const owner = nativeDetailOwner;
    const isCurrent = () => supportOwner.current === owner && pendingSupportSubmission.current === submission;
    pendingSupportSubmission.current = submission;
    setSupportComposerState({ status: "sending" });
    try {
      const idToken = await user.getIdToken();
      if (!isCurrent()) return { kind: "no_user" };
      const pageUrl =
        typeof window !== "undefined" ? window.location.href : ROUTES.PROFILE;
      const result = await SupportService.submitMessage({
        idToken,
        userId: applicationOwnerId,
        kind,
        subject: presentation.internalSubject,
        message: trimmedMessage,
        persona: personaState?.active_persona || null,
        pageUrl,
      });
      if (!isCurrent()) return { kind: "no_user" };

      if (!result.accepted) {
        setSupportComposerState({
          status: "error",
          message: "We couldn't send your message. Try again.",
        });
        return { kind: "rejected" };
      }

      // A route/voice edit may arrive while delivery is in flight. The accepted
      // snapshot does not authorize erasing a newer unsent message.
      if (supportDraft.current.revision === submittedDraft.revision &&
          (messageOverride === undefined || trimmedMessage === submittedDraft.message.trim())) {
        setSupportComposerState({ status: "sent", kind });
        changeSupportDraft({ message: "" });
      } else {
        setSupportComposerState({ status: "editing" });
        toast.success("Message sent");
      }
      return { kind: "accepted" };
    } catch (error) {
      if (!isCurrent()) return { kind: "no_user" };
      console.error(
        "[ProfilePage] Support delivery failed:",
        error instanceof SupportDeliveryUncertainError ? "uncertain" : "failed",
      );
      setSupportComposerState({
        status: "error",
        message:
          error instanceof SupportDeliveryUncertainError
            ? "We couldn't confirm delivery. Please wait before trying again."
            : "We couldn't send your message. Try again.",
      });
      if (error instanceof SupportDeliveryUncertainError) return { kind: "uncertain" };
      return { kind: "failed" };
    } finally {
      if (pendingSupportSubmission.current === submission) pendingSupportSubmission.current = null;
    }
  }

  async function handleDisconnectGmail() {
    if (!applicationOwnerId) return;
    try {
      setGmailActionBusy("disconnect");
      const next = await gmail.disconnectGmail();
      if (!next) return;
      toast.success("Mail disconnected and Mail receipt data was deleted.");
    } catch (error) {
      const message = sanitizeGmailUserMessage(error, {
        fallback:
          "We couldn't disconnect Mail right now. Please try again in a moment.",
      });
      console.error("[ProfilePage] Failed to disconnect Gmail:", error);
      toast.error(message);
    } finally {
      setGmailActionBusy(null);
    }
  }

  async function handleSyncGmailNow() {
    if (!applicationOwnerId) return;
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
        authFallback: "Reconnect Mail to continue syncing your receipts.",
      });
      console.error("[ProfilePage] Failed to start Gmail sync:", error);
      toast.error(message);
    } finally {
      setGmailActionBusy(null);
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

  const resetRowDescription = "Clears saved details. Keeps sign-in.";
  const resetDialogTitle = "Reset account?";
  const resetDialogDescription =
    "Clears saved details and setup progress. Your sign-in and vault stay.";

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

  const handleVaultCreationOpenChange = (open: boolean) => {
    setShowVaultCreation(open);
    if (open) {
      vaultCreationCompletingRef.current = false;
    } else if (!vaultCreationCompletingRef.current) {
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
  const enrolledPasskeyWrappers = enrolledVaultWrappers.filter((wrapper) =>
    isPasskeyVaultMethod(wrapper.method),
  );
  const canEditKaiPreferences = Boolean(
    applicationOwnerId && vaultAccess.hasVault && vaultAccess.canMutateSecureData,
  );

  const marketplaceStatusText = loadingMarketplaceOptIn
    ? "Checking visibility…"
    : marketplaceOptIn
      ? "Discoverable to RIAs"
      : "Hidden from marketplace search";
  const contactDiscoverableStatusText = loadingContactDiscoverable
    ? "Checking discoverability…"
    : contactDiscoverable
      ? "Verified people with your number can find and connect with you automatically. No location or personal information is shared."
      : "Hidden from contact sync";
  const phoneSummaryText = phoneNumber
    ? formatMaskedPhoneNumber(phoneNumber)
    : phoneNumberStatus === "missing"
      ? "No phone number yet"
      : phoneNumberStatus === "unavailable"
        ? "Phone number temporarily unavailable"
        : "Checking phone number…";
  const phoneLookupPending = !phoneNumber && phoneNumberStatus !== "missing";
  const retryPhoneLookup = useCallback(async () => {
    const owner = snapshotValidatedAuthSessionOwner();
    if (!owner || owner.userId !== applicationOwnerId) {
      return { status: "blocked" as const, summary: "Sign in to check your phone number." };
    }
    try {
      const phone = await resolveVerifiedPhoneNumber();
      if (!isValidatedAuthSessionOwnerCurrent(owner)) {
        return { status: "blocked" as const, summary: "Your account changed. Try again." };
      }
      if (phone) return { status: "succeeded" as const, summary: "Your saved phone number is available." };
      const snapshot = AccountIdentityService.peekCachedIdentity(applicationOwnerId);
      if (snapshot && !snapshot.isStale && backendPhoneIsMissing(snapshot.data, applicationOwnerId)) {
        return { status: "succeeded" as const, summary: "You can add a verified phone number." };
      }
    } catch { /* Keep an unavailable lookup retryable. */ }
    return { status: "failed" as const, summary: "Couldn't load your phone number. Try again." };
  }, [resolveVerifiedPhoneNumber, applicationOwnerId]);
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
        id: "profile_payouts",
        label: "Payments and earnings",
        purpose:
          "opens payout setup, linked bank details, and transaction history.",
        actionId: "route.profile_payouts",
        role: "card",
        voiceAliases: ["payouts", "link my bank", "document earnings"],
      },
      {
        id: "profile_request_pricing",
        label: "Request pricing",
        purpose: "opens the default price for document requests.",
        actionId: "route.profile_request_pricing",
        role: "card",
        voiceAliases: ["request pricing", "Drive price", "document price"],
      },
      {
        id: "profile_my_data",
        label: "Memory",
        purpose: "opens saved details and sharing.",
        actionId: "route.profile_my_data",
        role: "card",
        voiceAliases: ["my data", "saved details"],
      },
      {
        id: "profile_preferences",
        label: PROFILE_LABELS.preferences,
        purpose: "opens appearance and private-agent preferences.",
        actionId: "route.profile_preferences_panel",
        role: "card",
        voiceAliases: ["preferences", "appearance", "settings"],
      },
      {
        id: "profile_access",
        label: "Access & sharing",
        purpose: "opens consent-backed access and sharing controls.",
        role: "card",
        voiceAliases: ["access", "sharing", "consent access"],
      },
      ...(localCrmEnabled
        ? [
            {
              id: "profile_connected_systems",
              label: "Connected Systems",
              purpose: "opens connected CRM systems.",
              actionId: "route.profile_connected_systems_panel",
              role: "card",
              voiceAliases: ["connected systems", "crm", "salesforce"],
            },
          ]
        : []),
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
        id: "profile_trusted_devices",
        label: "Trusted devices",
        purpose:
          "opens devices connected as an extension of your private agent.",
        actionId: "route.profile_trusted_devices",
        role: "card",
        voiceAliases: ["trusted devices", "connected devices", "devices"],
      },
      {
        id: "profile_account",
        label: PROFILE_LABELS.account,
        purpose: "opens account identity, mail, and phone management.",
        actionId: "route.profile_account",
        role: "card",
        voiceAliases: ["account", "phone number", "identity"],
      },
      {
        id: "profile_gmail",
        label: "Mail receipts",
        purpose: "opens Mail receipt sync and receipt-memory management.",
        actionId: "route.profile_receipts",
        role: "card",
        voiceAliases: ["gmail receipts", "receipts"],
      },
      {
        id: "profile_referrals",
        label: PROFILE_LABELS.referrals,
        purpose: "opens your referral link and referral status.",
        actionId: "route.profile_referrals_panel",
        role: "card",
        voiceAliases: ["referrals", "invite friends", "my referral link"],
      },
      {
        id: "profile_support",
        label:
          activePanel === "hosting"
            ? "Hosting"
            : activePanel === "software-updates"
              ? "Software updates"
              : PROFILE_LABELS.support,
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
      activePanel === "preferences"
        ? preferenceControls
        : activePanel === "account" && phoneLookupPending
          ? phoneNumberStatus === "unavailable" ? [{
              id: activeDetail === "phone" ? "profile-phone-detail-retry" : "profile-phone-retry",
              label: "Retry phone lookup",
              purpose: "retrieves the saved verified phone without starting OTP verification.",
              actionId: "profile.retry_phone_lookup",
              role: "control",
            }] : []
        : activePanel === "hosting" || activePanel === "software-updates" || activePanel === "payouts" || activePanel === "world-model" || activePanel === "request-pricing"
          ? []
          : profileHomeControls;
    const activeControl =
      controls.find((control) => control.id === activeVoiceControlId) ||
      controls.find((control) => control.id === lastVoiceControlId) ||
      null;
    const visibleModules = activePanel
      ? [
          activePanel === "account"
            ? PROFILE_LABELS.account
            : activePanel === "world-model"
              ? "Personal World Model"
            : activePanel === "payouts"
              ? "Payments and earnings"
              : activePanel === "request-pricing"
                ? "Request pricing"
                : activePanel === "my-data"
                  ? "Memory"
                  : activePanel === "connected-systems"
                    ? "Connected Systems"
                    : activePanel === "preferences"
                      ? PROFILE_LABELS.preferences
                      : activePanel === "security"
                        ? PROFILE_LABELS.security
                        : activePanel === "gmail"
                          ? "Mail receipts"
                          : PROFILE_LABELS.support,
          ...(activeDetail ? [activeDetail] : []),
        ]
      : [
          PROFILE_LABELS.account,
          PROFILE_LABELS.preferences,
          "Hosting",
          "Software updates",
          "Payments and earnings",
          "Request pricing",
          "Memory",
          "Access & sharing",
          ...(localCrmEnabled ? ["Connected Systems"] : []),
          "Mail receipts",
          PROFILE_LABELS.security,
          "Trusted devices",
          PROFILE_LABELS.referrals,
          PROFILE_LABELS.support,
          ...(canShowPkmAgentLab ? [PROFILE_LABELS.developerTools] : []),
        ];
    const availableActions =
      activePanel === "payouts" || activePanel === "world-model" || activePanel === "request-pricing"
        ? []
        : activePanel === "gmail"
          ? [
              gmailPresentation.isConnected
                ? "Sync Mail receipts"
                : gmailPresentation.state === "needs_reauthentication"
                  ? "Reconnect Mail"
                  : "Connect Mail",
              "Open receipts",
              ...(gmailPresentation.isConnected ? ["Disconnect Mail"] : []),
            ]
          : activePanel === "support"
            ? [
                "Choose Problem",
                "Choose Help",
                "Choose Feedback",
                "Send support message",
              ]
            : activePanel === "connected-systems"
              ? [
                  "Load Salesforce CRM schema",
                  "Read Salesforce CRM record",
                  "Propose Salesforce CRM create",
                  "Propose Salesforce CRM update",
                ]
              : activePanel === "account"
                ? phoneNumber ? ["Change phone number"] : phoneNumberStatus === "missing"
                  ? ["Add phone number"] : phoneNumberStatus === "unavailable" ? ["Retry phone lookup"] : []
                : activePanel === "preferences" || activePanel === "hosting" || activePanel === "software-updates"
                  ? []
                  : activePanel === "security"
                    ? [
                        vaultAccess.needsVaultCreation
                          ? "Create your vault"
                          : "Unlock vault",
                        "Change password",
                        "Delete account",
                      ]
                    : [
                        "Open your account",
                        "Open security & privacy",
                        "Open help & feedback",
                      ];

    return {
      surfaceDefinition: {
        screenId:
          activePanel === "world-model"
            ? "profile_world_model"
          : activePanel === "request-pricing"
            ? "profile_request_pricing"
            : activePanel
              ? `profile_${activePanel}`
              : "profile_home",
        title: activePanel
          ? activePanel === "account"
            ? PROFILE_LABELS.account
            : activePanel === "world-model"
              ? "Personal World Model"
            : activePanel === "payouts"
              ? "Payments and earnings"
              : activePanel === "request-pricing"
                ? "Request pricing"
            : activePanel === "my-data"
              ? "Memory"
              : activePanel === "connected-systems"
                ? "Connected Systems"
                : activePanel === "preferences"
                  ? PROFILE_LABELS.preferences
                  : activePanel === "security"
                    ? PROFILE_LABELS.security
                    : activePanel === "gmail"
                      ? "Mail receipts"
                      : activePanel === "hosting"
                        ? "Hosting"
                        : activePanel === "software-updates"
                          ? "Software updates"
                          : PROFILE_LABELS.support
          : "Profile",
        purpose:
          "This surface manages account details, payouts, request pricing, appearance, help, and vault privacy.",
        sections: [
          {
            id: "account",
            title: PROFILE_LABELS.account,
            purpose: "Mail, phone, and sign-in identity.",
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
            purpose:
              "Send a problem report, support request, or product feedback.",
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
          : activePanel === "support"
            ? "support_form"
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
        phone_lookup_status: phoneNumberStatus,
        email_verified: emailVerified,
        preference_voice_actions_available:
          activePanel === "preferences" ? false : null,
      },
      // Deliberately offered to the agent; screenMetadata above stays
      // browser-local. Curated rather than copied: screenMetadata carries
      // google_email, and this map is rendered into the model's prompt, so the
      // person's address would have travelled into every turn on this screen.
      // Counts, states and flags only.
      screenState: {
        profile_panel: activePanel,
        profile_detail: activeDetail ?? null,
        total_attributes: profileSummary.totalAttributes,
        domain_count: profileSummary.totalDomains,
        pending_consents: pendingConsents ?? 0,
        gmail_connected: gmailPresentation.isConnected,
        gmail_state: gmailPresentation.state,
        marketplace_opt_in: marketplaceOptIn,
        security_summary: securitySummaryText,
        phone_verified: Boolean(phoneNumber),
        phone_lookup_status: phoneNumberStatus,
        email_verified: emailVerified,
        pkm_agent_lab_available: canShowPkmAgentLab,
        vault_needs_creation: vaultAccess.needsVaultCreation === true,
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
    localCrmEnabled,
    marketplaceOptIn,
    passphraseDialogOpen,
    pendingConsents,
    phoneNumber,
    phoneLookupPending,
    phoneNumberStatus,
    profileSummary.totalAttributes,
    profileSummary.totalDomains,
    savingMarketplaceOptIn,
    securitySummaryText,
    sendingSupportMessage,
    showVaultUnlock,
    switchingVaultMethod,
    emailVerified,
    vaultAccess.needsVaultCreation,
  ]);
  usePublishVoiceSurfaceMetadata(profileVoiceSurfaceMetadata);

  useLocalOnboardingActionHandler(
    "profile.retry_phone_lookup",
    retryPhoneLookup,
    { enabled: Boolean(user) && activePanel === "account" && phoneLookupPending && phoneNumberStatus === "unavailable" },
  );

  // Profile's three remaining unwired actions. Registered here rather than in
  // the global registrar because each genuinely needs this page's state --
  // the delete flow's vault resolution, the support composer's kind and reply
  // email, the current marketplace value. profile.sign_out is the exception
  // and lives in components/agent/global-voice-action-handlers.tsx.
  useLocalOnboardingActionHandler(
    "profile.delete_account",
    async (slots) => {
      if (slots?.confirmed !== true) {
        // Deleting an account is the one thing in this app that cannot be
        // undone, so it never runs on a first utterance -- the person has to
        // hear what it does and say yes. handleDeleteAccount then resolves
        // auth and routes to vault unlock on its own, which is a second,
        // independent gate.
        return {
          status: "blocked" as const,
          summary: "Deleting your account needs a confirmation.",
          data: {
            [VOICE_CONFIRM_DATA_KEY]: {
              actionId: "profile.delete_account",
              slots: { confirmed: true },
              prompt: "Delete your account permanently? This cannot be undone.",
              subject: { name: "Your account", detail: user?.email ?? "" },
              consequence:
                getKaiActionById("profile.delete_account")?.meaning ?? null,
              confirmLabel: "Delete account",
            },
          },
        };
      }
      // Awaited, not fired: the spoken outcome is what actually happened --
      // deleted, needs unlock, blocked by an external resource, failed, or
      // genuinely unknown. "started" was narrated as done.
      const outcome = await handleDeleteAccount();
      return lifecycleOutcomeToVoice(outcome);
    },
    { enabled: Boolean(user) },
  );

  useLocalOnboardingActionHandler(
    "profile.marketplace_visibility.toggle",
    async (slots) => {
      // handleMarketplaceOptInToggle flips the current value; it is not a
      // setter. Wired directly, "make me discoverable" would HIDE someone who
      // already was. So a stated intent is honoured as a target state, and
      // only a bare "toggle" actually flips.
      const { target: desired, alreadyThere } = resolveMarketplaceTarget(
        slots?.enabled,
        marketplaceOptIn,
      );
      if (alreadyThere && desired !== null) {
        return {
          status: "succeeded" as const,
          summary: desired
            ? "Your marketplace profile is already discoverable."
            : "Your marketplace profile is already hidden.",
        };
      }
      if (slots?.confirmed !== true) {
        const next = desired ?? !marketplaceOptIn;
        return {
          status: "blocked" as const,
          summary: "Changing who can find you needs a confirmation.",
          data: {
            [VOICE_CONFIRM_DATA_KEY]: {
              actionId: "profile.marketplace_visibility.toggle",
              slots: { enabled: next, confirmed: true },
              prompt: next
                ? "Make your investor profile discoverable in the marketplace?"
                : "Hide your investor profile from the marketplace?",
              subject: { name: "Marketplace visibility", detail: "" },
              consequence:
                getKaiActionById("profile.marketplace_visibility.toggle")
                  ?.meaning ?? null,
              confirmLabel: next ? "Make discoverable" : "Hide profile",
            },
          },
        };
      }
      // The confirmation card carried the reviewed target; apply exactly that
      // and report the stored value. A delayed tap must not invert the result
      // because the switch moved in between.
      const outcome = await handleMarketplaceOptInToggle(desired ?? undefined);
      return marketplaceOutcomeToVoice(outcome);
    },
    { enabled: Boolean(user) },
  );

  useLocalOnboardingActionHandler(
    "profile.support.submit_message",
    async (slots) => {
      const message = String(slots?.message ?? "").trim();
      if (message.length < 10) {
        // The same floor the typed composer enforces. Saying so is the point:
        // a support message that silently failed validation would be reported
        // as sent and never arrive.
        return {
          status: "blocked" as const,
          summary:
            "Tell me a bit more about the problem and I will send it to support.",
        };
      }
      // Only the real service's accepted result is "sent"; an early return or
      // a caught error names why nothing went out and leaves the draft.
      const outcome = await submitSupportMessage(message);
      return supportOutcomeToVoice(outcome);
    },
    { enabled: Boolean(user) },
  );

  useEffect(() => {
    if (!shouldRequestVaultUnlock || authLoading || hasVault === null) {
      return;
    }

    if (hasVault) {
      requestVaultUnlock("profile_data");
    } else {
      setShowVaultCreation(true);
    }

    if (isPanePresentation) {
      replaceProfilePaneLocation(
        pathname,
        stripProfilePaneTransientParams(searchParams),
        { panel: activePanel, detail: activeDetail },
      );
    } else {
      // Keep the one-time invitation through unlock; only remove the unlock marker.
      const claimQuery = activePanel === "world-model" && searchParams.has("claim")
        ? new URLSearchParams(searchParams.toString())
        : null;
      claimQuery?.delete("unlock_vault");
      router.replace(
        claimQuery
          ? `${pathname}?${claimQuery.toString()}`
          : buildProfileRoute({ panel: activePanel, detail: activeDetail }),
        { scroll: false },
      );
    }
  }, [
    activeDetail,
    activePanel,
    authLoading,
    hasVault,
    isPanePresentation,
    pathname,
    router,
    searchParams,
    shouldRequestVaultUnlock,
  ]);

  useEffect(() => {
    if (authLoading || !applicationOwnerId || !hasVault || !vaultAccess.needsUnlock) {
      return;
    }
    if (!profileRouteRequiresUnlockedVault(activePanel, activeDetail)) {
      return;
    }
    // Stripe returns to Payouts with a short callback marker. Keep that route
    // while the owner unlocks so an expired Connect link can be refreshed.
    const documentPayoutReturn = searchParams.get("documentPayouts");
    const worldModelClaim = activePanel === "world-model" && searchParams.has("claim");
    if (
      activePanel &&
      !worldModelClaim &&
      documentPayoutReturn !== "refresh" &&
      documentPayoutReturn !== "done"
    ) {
      setPendingProfileTarget({
        panel: activePanel,
        detail: activeDetail ?? null,
        mode: "replace",
      });
      if (isPanePresentation) {
        replaceProfilePaneLocation(
          pathname,
          stripProfilePaneTransientParams(searchParams),
          { panel: null, detail: null },
        );
      } else {
        router.replace(buildProfileRoute({ panel: null, detail: null }), {
          scroll: false,
        });
      }
    }
    requestVaultUnlock("profile_data");
  }, [
    activeDetail,
    activePanel,
    authLoading,
    hasVault,
    isPanePresentation,
    pathname,
    router,
    searchParams,
    applicationOwnerId,
    vaultAccess.needsUnlock,
  ]);

  if (authLoading || !user || !applicationOwnerId) {
    return null;
  }

  const popProfileStack = () => {
    if (isPanePresentation) {
      if (!unwindBackLayer(pathname, searchParams, { profile_pane: "1" })) {
        popProfilePaneLocation(pathname, searchParams);
      }
      return;
    }
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
    if (!applicationOwnerId || !vaultKey || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return;
    }
    if (!memoryOperations.current()) return;
    const request = memoryOperations.beginPreview();
    const privacy = nativePrivacyObservation().state;
    const current = () => memoryOperations.acceptsPreview(request) && (!privacy ||
      nativePrivacyObservation().state?.generation === privacy.generation && nativePrivacyObservation().state?.appIsActive === true &&
      nativePrivacyObservation().state?.shielded === false);

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
        userId: applicationOwnerId,
        domain: domainKey,
        vaultKey,
        vaultOwnerToken,
        segmentIds: [permission.topLevelScopePath],
      });
      if (!current()) return;
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
      if (!current()) return;
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
  ): Promise<boolean> => {
    const target = pkmPreviewEntityTarget(entity);
    const reviewed = domainPreview.open && domainPreview.presentation?.groups.some(group => group.kind === "entities" && group.items.includes(entity));
    if (!target || !reviewed) { toast.error("Reopen this saved entry before removing it."); return false; }
    const domainKey = domainPreview.domainKey || selectedDomain?.key || null;
    const topLevelScopePath = domainPreview.topLevelScopePath;
    if (
      !applicationOwnerId ||
      !vaultKey ||
      !vaultOwnerToken ||
      !domainKey ||
      !topLevelScopePath
    ) {
      requestVaultUnlock("profile_data");
      return false;
    }
    const operation = memoryOperations.beginWrite(domainKey);
    if (!operation) return false;
    const previewRequest = memoryOperations.beginPreview();
    const previewIsCurrent = () => operation.current() && memoryOperations.acceptsPreview(previewRequest);
    let committed = false;

    setDomainPreview((current) => ({
      ...current,
      error: null,
      deletingEntityKey: entity.key,
    }));

    try {
      if (target.kind === "financial-context") {
        if (domainKey !== "financial" || topLevelScopePath !== "context") return false;
        const deleted = await handleDeleteFinancialContextEntry(target.entryId);
        if (!deleted) {
          if (previewIsCurrent()) setDomainPreview((current) => ({
            ...current,
            deletingEntityKey: null,
          }));
          return false;
        }
      } else {
        const parentPath = [topLevelScopePath, ...target.relativePath.slice(0, -2)].join(".");
        await PersonalKnowledgeModelService.storePreparedDomain({
          userId: applicationOwnerId,
          vaultKey,
          domain: domainKey,
          domainData: buildPkmEntityDeletionCandidate(
            parentPath,
            target.entityId,
          ),
          summary: {},
          mergeDecision: {
            merge_mode: "delete_entity",
            target_domain: domainKey,
            target_entity_id: target.entityId,
            target_entity_path: `${topLevelScopePath}.${target.relativePath.join(".")}`,
            match_confidence: 1,
            match_reason:
              "User removed this saved PKM entry from the profile interface.",
          },
          vaultOwnerToken,
        });
      }
      committed = true;
      if (!operation.current()) return true;

      const permission = selectedDomainPermissions.find(
        (candidate) => candidate.key === domainPreview.permissionKey,
      );
      const data = await PersonalKnowledgeModelService.loadDomainData({
        userId: applicationOwnerId,
        domain: domainKey,
        vaultKey,
        vaultOwnerToken,
        segmentIds: [topLevelScopePath],
      });
      if (!previewIsCurrent()) return true;
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
      return true;
    } catch (error) {
      if (!operation.current()) return committed;
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't remove this saved entry.";
      if (previewIsCurrent()) setDomainPreview((current) => ({
        ...current,
        error: committed ? "Entry removed. Refresh to load the latest details." : message,
        presentation: committed ? null : current.presentation,
        deletingEntityKey: null,
      }));
      if (committed) toast.success("Entry removed. Refresh to load the latest details.");
      else toast.error(message);
      return committed;
    } finally {
      if (previewIsCurrent()) setDomainPreview(value => ({ ...value, deletingEntityKey: null }));
      operation.finish();
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
    if (!applicationOwnerId || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return;
    }
    const permissionKey = permission.key;
    const previousManifest = cloneManifest(domainManifests[domainKey] ?? null);
    if (!previousManifest) {
      toast.error("These details are still preparing sharing controls.");
      return;
    }
    const operation = memoryOperations.beginWrite(domainKey);
    if (!operation) return;
    let committed = false;

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
        userId: applicationOwnerId,
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
      committed = true;
      if (!operation.current()) return;
      setDomainManifests((current) => ({
        ...current,
        [domainKey]: updatedManifest,
      }));
      await Promise.all([refreshConsentCenter(true), refreshPkmMetadata(true)]);
      if (!operation.current()) return;
      toast.success(
        nextPosture === "private"
          ? "This section is private."
          : "One will ask before sharing this section.",
      );
    } catch (error) {
      if (!operation.current()) return;
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't update sharing right now.";
      if (!committed) setDomainManifests((current) => ({
        ...current,
        [domainKey]: previousManifest,
      }));

      if (committed) {
        toast.success("Sharing updated. Refresh to load the latest access state.");
      } else if (error instanceof PkmScopeExposureError && error.status === 409) {
        const [refreshed] = await Promise.all([
          refreshDomainManifest(domainKey, true, operation.current),
          refreshConsentCenter(true),
          refreshPkmMetadata(true),
        ]);
        if (!operation.current()) return;
        toast.error(
          refreshed ? "Sharing changed elsewhere. The latest version has been reloaded."
            : "Sharing changed elsewhere. Refresh these details before trying again.",
        );
      } else {
        void refreshDomainManifest(domainKey, true);
        toast.error(message || "Couldn't update sharing right now.");
      }
    } finally {
      if (operation.current()) setPendingPermissionToggles((current) => {
        const next = { ...current };
        delete next[permissionKey];
        return next;
      });
      operation.finish();
    }
  };

  const handleSaveFinancialContext = async (): Promise<boolean> => {
    if (!applicationOwnerId || !vaultKey || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return false;
    }

    const submitted = { ...financialDraft.current };
    const contextText = submitted.text.trim();

    if (!contextText) {
      toast.error("Add financial context before saving.");
      return false;
    }
    const operation = memoryOperations.beginWrite("financial");
    if (!operation) return false;

    const updatedAt = new Date().toISOString();
    setSavingFinancialContext(true);
    setPkmError(null);
    setNativeContextError(null);

    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: applicationOwnerId,
        domain: "financial",
        vaultKey,
        vaultOwnerToken,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "profile_financial_context_save",
        },
        build: (context) => {
          if (!operation.current()) throw new Error("session_changed");
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
            id: submitted.target || `ctx_${Date.parse(updatedAt)}`,
            category: submitted.category,
            text: contextText,
            status: "active",
            source: "profile_my_data",
            updated_at: updatedAt,
          };
          if (submitted.target && !existingEntries.some(entry => entry.id === submitted.target)) throw new Error("This saved entry is no longer available. Go back and refresh.");
          const nextEntries = submitted.target
            ? existingEntries.map((entry) =>
                entry.id === submitted.target
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
      if (!operation.current()) return false;

      toast.success(
        submitted.target
          ? "Financial context updated."
          : "Financial context saved.",
      );
      if (financialDraft.current.revision === submitted.revision) {
        setFinancialContextText(""); setEditingFinancialContextId(null);
      }
      void refreshPkmMetadata(true);
      void refreshDomainManifest("financial", true);
      return true;
    } catch (error) {
      if (!operation.current()) return false;
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't save financial context.";
      setPkmError(message);
      setNativeContextError("Couldn't save financial context. Your text is still here. Try again when ready.");
      toast.error(message);
      return false;
    } finally {
      if (operation.current()) setSavingFinancialContext(false);
      operation.finish();
    }
  };

  const handleEditFinancialContextEntry = (entity: PkmSectionPreviewEntity) => {
    if (!memoryOperations.current() || memoryOperations.writing("financial")) return false;
    const target = pkmPreviewEntityTarget(entity);
    if (target?.kind !== "financial-context" || !domainPreview.open ||
        !domainPreview.presentation?.groups.some(group => group.kind === "entities" && group.items.includes(entity))) return false;
    const payload = entity.editPayload || {};
    const category =
      typeof payload.category === "string" && payload.category.trim()
        ? payload.category.trim()
        : "general";
    const text =
      typeof payload.text === "string" && payload.text.trim()
        ? payload.text.trim()
        : entity.fields.find((field) => field.label === "Context")?.value || "";

    setEditingFinancialContextId(target.entryId);
    setFinancialContextCategory(category as FinancialContextCategory);
    setFinancialContextText(text);
    closeDomainPreview();
    return true;
  };

  const handleDeleteFinancialContextEntry = async (entryId: string) => {
    if (!applicationOwnerId || !vaultKey || !vaultOwnerToken) {
      requestVaultUnlock("profile_data");
      return false;
    }
    // Called only by the fenced entity-removal owner, which already holds
    // the financial-domain writer. Do not acquire the same lock twice.
    if (!memoryOperations.current() || !memoryOperations.writing("financial")) return false;

    const updatedAt = new Date().toISOString();
    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: applicationOwnerId,
        domain: "financial",
        vaultKey,
        vaultOwnerToken,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "profile_financial_context_delete",
        },
        build: (context) => {
          if (!memoryOperations.current() || !memoryOperations.writing("financial")) throw new Error("session_changed");
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
      if (!memoryOperations.current()) return true;

      void refreshPkmMetadata(true);
      void refreshDomainManifest("financial", true);
      return true;
    } catch (error) {
      if (!memoryOperations.current()) return false;
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't delete financial context.";
      setPkmError(message);
      toast.error(message);
      return false;
    }
  };

  const myDataContent = (
    <div
      className={cn(
        "space-y-4 sm:space-y-5",
        isPanePresentation && "profile-account-content",
        isPanePresentation && accountStyles.paneAccountContent,
        isPanePresentation && accountStyles.managedContent,
      )}
    >
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
          updateProfileView({ panel: "my-data", detail: "sharing" }, "push")
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
      {isVaultUnlocked ? (
        <SharedWithYouGroup vaultOwnerToken={vaultOwnerToken} model={memoryShared.shared} received={memoryShared.received} />
      ) : null}
      {isVaultUnlocked ? <SecretsListGroup onUnlock={() => undefined} model={memorySecrets} /> : null}
    </div>
  );

  const accessContent = (
    <div
      className={cn(
        "space-y-4 sm:space-y-5",
        isPanePresentation && secondaryTypographyStyles.paneAccess,
      )}
    >
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
              panel: "my-data",
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
          icon={PROFILE_ICONS.location}
          iconTone="capability"
          title="Location sharing"
          description="Manage live location."
          trailing={<Badge variant="secondary">One</Badge>}
          chevron
          stackTrailingOnMobile
          onClick={() => router.push(ROUTES.ONE_LOCATION)}
        />
        <SettingsRow
          icon={PROFILE_ICONS.review}
          iconTone="capability"
          title="Consent center"
          description="Review sharing."
          trailing={<Badge variant="secondary">Manage</Badge>}
          chevron
          stackTrailingOnMobile
          onClick={() => router.push(ROUTES.CONSENTS)}
        />
        <SettingsRow
          icon={PROFILE_ICONS.people}
          iconTone="capability"
          title="Find and connect me by phone number"
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
          icon={PROFILE_ICONS.visibility}
          iconTone="capability"
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
    if (!phoneVisitIsCurrent() || activeUser?.uid !== phoneVisit.owner?.firebaseUid) return;
    await AccountIdentityService.syncCurrentUser(activeUser);
    if (!phoneVisitIsCurrent()) return;
    updateProfileView({ panel: "account", detail: null }, "replace");
  };

  const accountContent = (
    <div
      className={cn(
        "profile-account-content",
        isPanePresentation && accountStyles.paneAccountContent,
      )}
    >
      {presentation === "native-page" && nativeAccountException !== "photo" ? <ProfileAvatarEditor /> : null}
      <MarketingPreferencePanel model={emailPreference} />
      <SettingsGroup title="Identity">
        <SettingsRow
          icon={PROFILE_ICONS.name}
          iconTone="capability"
          title="Display name"
          description={user.displayName || "Not available"}
          trailing={
            <span className="profile-account-inline-action">
              {editingDisplayName ? "Close" : "Edit"}
            </span>
          }
          onClick={() => setEditingDisplayName((open) => !open)}
        />
        {editingDisplayName ? (
          <div
            className={cn(
              "px-4 pb-3",
              isPanePresentation && accountStyles.paneEditor,
            )}
            data-testid="profile-account-display-name-editor"
          >
            {presentation === "native-page" ? <div ref={setNativeNameHost} /> : <DisplayNameEditor
              user={user}
              onSaved={() => setEditingDisplayName(false)}
              onCancel={() => setEditingDisplayName(false)}
            />}
          </div>
        ) : null}
        <SettingsRow
          icon={PROFILE_ICONS.mail}
          iconTone="capability"
          title="Mail"
          description={user.email || "Not available"}
        />
        <SettingsRow
          icon={PROFILE_ICONS.phone}
          iconTone="capability"
          title="Phone number"
          description={phoneSummaryText}
          voiceControlId={phoneLookupPending ? "profile-phone-retry" : undefined}
          disabled={!phoneNumber && phoneNumberStatus === "loading"}
          trailing={
            <span className="profile-account-inline-action">
              {phoneNumber ? "Change" : phoneLookupPending ? "Retry" : "Add"}
            </span>
          }
          chevron
          onClick={() => {
            if (phoneLookupPending) {
              void retryPhoneLookup();
              return;
            }
            updateProfileView({ panel: "account", detail: "phone" }, "push");
          }}
        />
        <SettingsRow
          iconTone="capability"
          leading={
              <span className="profile-account-provider-icon inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                <ProviderIcon providerId={provider.id} email={user.email} />
              </span>
          }
          title="Sign-in provider"
          description={provider.name}
        />
        {walletCardEntryEnabled ? (
          <SettingsRow
            icon={PROFILE_ICONS.wallet}
            iconTone="capability"
            className="profile-account-service-row"
            title={WALLET_CARD_COPY.profileEntry.title}
            description={WALLET_CARD_COPY.profileEntry.description}
            chevron
            onClick={() => router.push(ROUTES.ONE_WALLET_CARD)}
          />
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="Payments">
        <SettingsRow icon={FinanceAgentIcon} iconTone="capability"
          title="Payments and earnings" description="Purchase balance, earnings and transactions."
          voiceControlId="profile_payouts" voiceActionId="route.profile_payouts"
          voiceLabel="Payments and earnings" voicePurpose="Opens purchase balance, payout setup and transaction history."
          chevron onClick={() => openVaultBackedPanel("payouts")} />
      </SettingsGroup>
      <SettingsGroup title="Account actions">
        <SettingsRow
          icon={PROFILE_ICONS.reset}
          iconTone="capability"
          className="profile-account-reset-row"
          title="Reset account"
          description={resetRowDescription}
          chevron
          onClick={() => void handleResetClick()}
        />
        <SettingsRow
          icon={PROFILE_ICONS.delete}
          iconTone="capability"
          className="profile-account-delete-row"
          testId="profile-account-delete-row"
          title={deleteButtonLabel}
          description={deleteRowDescription}
          tone="destructive"
          chevron
          onClick={() => void handleDeleteClick()}
        />
      </SettingsGroup>
    </div>
  );

  const appearanceControls = <ProfileAppearanceControls value={appAccent} nativeContext={preferenceChrome} />;
  const preferencesContent = (
    <div className="profile-preferences-content space-y-4">
      {isPanePresentation && (!isNative() || !nativeControlsEligible) ? (
        <ProfileAppearancePreferences
          accent={appAccent}
          onAccentChange={writeAccent}
          onGeminiClick={() =>
            updateProfileView(
              { panel: "preferences", detail: "gemini" },
              "push",
            )
          }
          onVoiceClick={() =>
            updateProfileView({ panel: "preferences", detail: "voice" }, "push")
          }
        />
      ) : (
      <>
      {appearanceControls}
      <SettingsGroup>
        <SettingsRow
          leading={<Brain className="h-8 w-8" />}
          title="AI connection"
          description="Cloud connection or your own key."
          chevron
          onClick={() =>
            updateProfileView(
              { panel: "preferences", detail: "gemini" },
              "push",
            )
          }
        />
        <SettingsRow
          icon={PROFILE_ICONS.voice}
          iconTone="capability"
          title="Voice"
          description="What One's voice can do, and its safety controls."
          chevron
          onClick={() =>
            updateProfileView({ panel: "preferences", detail: "voice" }, "push")
          }
        />
      </SettingsGroup>
      </>
      )}
      <CommunicationPreferencesSection
        nativeScene={presentation === "native-page"}
        userId={applicationOwnerId ?? null}
        vaultKey={vaultKey}
        vaultOwnerToken={vaultOwnerToken}
        onRequestUnlock={() => requestVaultUnlock("profile_data")}
      />
    </div>
  );

  const securityContent = (
    <div className="space-y-4">
      <SettingsGroup>
        <SettingsRow
          icon={PROFILE_ICONS.vault}
          iconTone="capability"
          title="Vault methods"
          description="Password, passkey, and unlock method."
          chevron
          onClick={() =>
            updateProfileView({ panel: "security", detail: "vault" }, "push")
          }
        />
      </SettingsGroup>
    </div>
  );

  const supportContent = (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[580px] flex-col px-0",
        auxiliaryTabStyles.support,
      )}
    >
      {supportComposerState.status === "sent" ? (
        <section
          aria-labelledby="support-success-heading"
          aria-live="polite"
          className="flex min-h-[280px] flex-col justify-center gap-5 py-6"
        >
          <div className="space-y-2">
            <h2
              id="support-success-heading"
              ref={supportSuccessHeadingRef}
              tabIndex={-1}
              className="text-[20px] font-semibold leading-[25px] text-foreground outline-none"
            >
              {
                SUPPORT_INTENT_PRESENTATION[supportComposerState.kind]
                  .successTitle
              }
            </h2>
            <p className="text-[15px] leading-5 text-muted-foreground">
              {supportComposerState.kind === "support_request" &&
              effectiveReplyEmail
                ? supportReplyLine
                : SUPPORT_INTENT_PRESENTATION[supportComposerState.kind]
                    .successDescription}
            </p>
          </div>
          <Button
            size="default"
            variant="none"
            effect="fill"
            showRipple={false}
            className="h-[52px] w-full rounded-[16px] bg-[color:var(--app-accent)] text-[17px] font-semibold leading-[22px] text-white shadow-none hover:bg-[color:var(--app-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
            onClick={() => {
              setSupportComposerState({ status: "editing" });
              updateProfileView({ panel: null, detail: null }, "replace");
            }}
          >
            Done
          </Button>
        </section>
      ) : (
        <form
          className="flex w-full flex-col py-1"
          onSubmit={(event) => {
            event.preventDefault();
            void submitSupportMessage();
          }}
        >
          <div className="space-y-2">
            <p
              id="support-intent-label"
              className="text-[15px] font-semibold leading-5 text-foreground"
            >
              What do you need?
            </p>
            <div
              role="group"
              aria-labelledby="support-intent-label"
              aria-describedby="support-intent-description"
            >
              <SegmentedControl
                ariaLabel="Support request type"
                value={supportKind}
                onValueChange={(value) => {
                  const nextKind = normalizeSupportKind(value);
                  if (!nextKind) return;
                  changeSupportDraft({ kind: nextKind });
                }}
                options={SUPPORT_INTENT_OPTIONS}
                disabled={sendingSupportMessage}
                className="min-h-11 w-full"
                labelClassName="whitespace-normal"
              />
            </div>
            <p id="support-intent-description" className="sr-only">
              Choose Problem to report something broken, Help to get support, or
              Feedback to share an improvement.
            </p>
          </div>

          <div className="mt-5 space-y-1.5">
            <label
              htmlFor="support-message"
              className="text-[15px] font-semibold leading-5 text-foreground"
            >
              Message
            </label>
            <Textarea
              id="support-message"
              maxLength={8000}
              ref={supportMessageRef}
              value={supportMessage}
              onChange={(event) => {
                changeSupportDraft({ message: event.target.value });
              }}
              placeholder={supportPresentation.placeholder}
              disabled={sendingSupportMessage}
              aria-invalid={Boolean(supportMessageError)}
              aria-describedby={cn(
                supportMessageError ? supportMessageErrorId : null,
                supportComposerState.status === "error"
                  ? supportSendStatusId
                  : null,
              )}
              className="min-h-[176px] resize-y rounded-[12px] border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-standard)] px-4 py-3 text-[16px] leading-[22px] shadow-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-70"
            />
            {supportMessageError ? (
              <p
                id={supportMessageErrorId}
                role="alert"
                className="px-1 text-[13px] leading-[18px] text-destructive"
              >
                {supportMessageError}
              </p>
            ) : null}
          </div>

          <p className="mt-3 text-[13px] leading-[18px] text-muted-foreground">
            {supportReplyLine}
          </p>
          <p className="mt-1 text-[13px] leading-[18px] text-muted-foreground">
            Your message goes to One support, with an internal copy to our
            support lead. No automatic receipt is sent.
          </p>

          {supportComposerState.status === "error" ? (
            <p
              id={supportSendStatusId}
              role="alert"
              className="mt-3 text-[13px] leading-[18px] text-destructive"
            >
              {supportComposerState.message}
            </p>
          ) : null}

          <Button
            type="submit"
            size="default"
            variant="none"
            effect="fill"
            showRipple={false}
            loading={sendingSupportMessage}
            className="mt-5 h-[52px] w-full rounded-[16px] bg-[color:var(--app-accent)] text-[17px] font-semibold leading-[22px] text-white shadow-none hover:bg-[color:var(--app-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-70"
            aria-describedby={
              supportComposerState.status === "error"
                ? supportSendStatusId
                : undefined
            }
          >
            {sendingSupportMessage
              ? "Sending..."
              : supportPresentation.submitLabel}
          </Button>
        </form>
      )}
    </div>
  );

  const gmailContent = (
    <div
      className={cn(
        "space-y-4 sm:space-y-5",
        isPanePresentation && secondaryTypographyStyles.paneGmail,
      )}
    >
      <SettingsGroup>
        <SettingsRow
          icon={PROFILE_ICONS.mail}
          iconTone="capability"
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
          icon={PROFILE_ICONS.refresh}
          iconTone="capability"
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
    <div className={auxiliaryTabStyles.connectedSystems}>
      <ConnectedSystemsPanel
        cacheUserId={applicationOwnerId}
        vaultOwnerToken={vaultOwnerToken}
        onRequestUnlock={() => requestVaultUnlock("profile_data")}
        profile={{
          displayName: user?.displayName,
          email: user?.email,
          phone: phoneNumber,
        }}
      />
    </div>
  );

  const vaultMethodsContent = (
    <div
      className={cn(
        "profile-account-content profile-vault-methods-content",
        isPanePresentation && secondaryTypographyStyles.paneVaultMethods,
      )}
    >
      <SettingsGroup title="Vault">
        {vaultAccess.needsVaultCreation ? (
          <SettingsRow
            icon={PROFILE_ICONS.security}
            iconTone="capability"
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
            {!vaultAccess.canMutateSecureData ? (
              <SettingsRow
                icon={PROFILE_ICONS.security}
                iconTone="capability"
                title="Unlock vault"
                description="Change methods or password."
                chevron
                onClick={() => requestVaultUnlock("profile_data")}
              />
            ) : null}

            <VaultMethodsPanel key={applicationOwnerId}
              wrappers={vaultMethodsOwner === applicationOwnerId ? enrolledVaultWrappers : []}
              primaryMethod={vaultMethodsOwner === applicationOwnerId ? vaultMethod : null} primaryWrapperId={primaryVaultWrapperId}
              biometricLabel={capabilityMatrix?.biometricLabel} localBiometricId={localBiometricWrapperId}
              mutable={vaultAccess.canMutateSecureData} busy={switchingVaultMethod} needsRefresh={vaultMethodsNeedRefresh}
              onSelect={(wrapper) => void vaultMethods.select(wrapper)}
              onRemove={vaultMethods.requestRemove}
              onAdd={vaultAccess.canMutateSecureData && recommendedQuickMethod ? () => void vaultMethods.add(recommendedQuickMethod) : undefined}
              addLabel={recommendedQuickMethod === "generated_default_native_biometric"
                ? `Add ${capabilityMatrix?.biometricLabel || "biometrics"}` : enrolledPasskeyWrappers.length ? "Add another passkey" : "Add passkey"}
              onChangePassphrase={vaultMethods.openPassword} onRefresh={() => void vaultMethods.refresh()} />

          </>
        ) : null}
      </SettingsGroup>
    </div>
  );

  const gmailConnectionContent = (
    <div
      className={cn(
        "space-y-4 sm:space-y-5",
        isPanePresentation && secondaryTypographyStyles.paneGmail,
      )}
    >
      <SettingsGroup title="Connection">
        <SettingsRow
          icon={PROFILE_ICONS.mail}
          iconTone="capability"
          title="Status"
          description={gmailSettingsDescription}
          trailing={<Badge variant="secondary">{gmailStatusLabel}</Badge>}
          stackTrailingOnMobile
        />
        <SettingsRow
          icon={PROFILE_ICONS.inbox}
          iconTone="capability"
          title="Inbox"
          description={
            gmail.status?.google_email
              ? gmail.status.google_email
              : gmail.loadingStatus
                ? "Resolving connected inbox..."
                : "No Mail inbox connected yet."
          }
        />
        <SettingsRow
          icon={PROFILE_ICONS.refresh}
          iconTone="capability"
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
    <MailActionsGroup
      connected={gmailPresentation.isConnected}
      needsReauthentication={gmailPresentation.state === "needs_reauthentication"}
      configured={gmail.status?.configured !== false}
      busy={gmailActionsBusy}
      onSync={() => void handleSyncGmailNow()}
      onConnect={() => router.push(ROUTES.GMAIL)}
      onRefresh={() => void gmail.refreshStatus({ force: true })}
      onOpenReceipts={() => router.push(ROUTES.GMAIL)}
      onDisconnect={() => void handleDisconnectGmail()}
    />
  );

  const financialContextControls = (
    <div className="space-y-3">
      <Select
        value={financialContextCategory}
        disabled={savingFinancialContext}
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
        disabled={savingFinancialContext}
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

  if (
    !routeBlockedByVault &&
    (activePanel === "hosting" || activePanel === "software-updates")
  ) {
    profileStackEntries.push({
      key: `panel:${activePanel}`,
      title: activePanel === "hosting" ? "Hosting" : "Software updates",
      description:
        activePanel === "hosting"
          ? "Where your private agent runs."
          : "Your version and available updates.",
      content: <AgentSettingsPanel kind={activePanel} userId={applicationOwnerId} controller={agentSettings} />,
    });
  } else if (!routeBlockedByVault && activePanel === "account") {
    profileStackEntries.push({
      key: "panel:account",
      title: "Account",
      content: accountContent,
      presentation: "account",
    });
    if (activeDetail === "phone") {
      profileStackEntries.push({
        key: "detail:phone",
        title: phoneNumber ? "Change phone number" : phoneLookupPending ? "Phone number" : "Add phone number",
        description: phoneNumber
          ? "Verify a new number."
          : phoneLookupPending ? undefined : "Add a verified number.",
        content: phoneLookupPending ? (
          <div className="flex flex-col gap-4">
            <p role="status">{phoneSummaryText}</p>
            <Button
              data-voice-control-id="profile-phone-detail-retry"
              onClick={() => void retryPhoneLookup()}
              disabled={phoneNumberStatus === "loading"}
            >
              Try again
            </Button>
            <Button variant="none" effect="fade" onClick={popProfileStack}>Cancel</Button>
          </div>
        ) : (
          <>
            {presentation === "native-page" ? <div ref={setNativePhoneHost} /> : <PhoneVerificationFlow
              ownerKey={phoneVisit.id}
              isCurrent={phoneVisitIsCurrent}
              mode={phoneNumber ? "replace" : "link"}
              currentPhoneNumber={phoneNumber}
              startVerification={
                phoneNumber ? startPhoneReplacement : startPhoneVerification
              }
              confirmVerification={
                phoneNumber ? confirmPhoneReplacement : confirmPhoneVerification
              }
              onCompleted={handleAccountPhoneCompleted}
              onBackStepChange={bindPhoneBackStep}
              onCancel={popProfileStack}
              confirmLabel="Save phone number"
              className={cn(
                "gap-5",
                isPanePresentation && accountStyles.phoneDetail,
              )}
              helperText={
                phoneNumber
                  ? "Enter the new phone number."
                  : "Enter your phone number."
              }
            />}
            <div id="recaptcha-container" className="min-h-0" />
          </>
        ),
      });
    }
  } else if (!routeBlockedByVault && activePanel === "payouts") {
    profileStackEntries.push({
      key: "panel:payouts",
      title: "Payments and earnings",
      content: (
        <div
          className={cn(
            "space-y-4",
            isPanePresentation && "profile-account-content",
            isPanePresentation && accountStyles.paneAccountContent,
            isPanePresentation && accountStyles.managedContent,
          )}
        >
          <PaymentsAndEarnings key={applicationOwnerId} commerce={nativePayout.commerce} answer={nativePayout.answer} />
        </div>
      ),
    });
  } else if (!routeBlockedByVault && activePanel === "world-model") {
    // The Profile pane is how /one/profile/world-model is presented (proxy.ts
    // redirects every Profile path to it), so the model renders here in both
    // presentations. Research state comes from the app-level store, which the
    // pane reads even though it is mounted beside the provider.
    profileStackEntries.push({
      key: "panel:world-model",
      title: "Personal World Model",
      content: (
        <div
          className={cn(
            "space-y-4",
            isPanePresentation && "profile-account-content",
            isPanePresentation && accountStyles.paneAccountContent,
            isPanePresentation && accountStyles.managedContent,
          )}
        >
          <PersonalWorldModelPage
            embedded
            model={worldModel}
            onManageDetails={() => openVaultBackedPanel("my-data")}
            onOpenAccount={openAccountPanel}
          />
        </div>
      ),
    });
  } else if (!routeBlockedByVault && activePanel === "request-pricing") {
    // Opened from another screen (Feed's "Set price"), a save returns there.
    // Without a safe origin, and in the pane, the card confirms inline.
    const pricingReturnTo = isPanePresentation
      ? null
      : normalizeInternalRouteHref(searchParams.get("from"));
    profileStackEntries.push({
      key: "panel:request-pricing",
      title: "Request pricing",
      content: (
        <div
          className={cn(
            isPanePresentation && "profile-account-content",
            isPanePresentation && accountStyles.paneAccountContent,
            isPanePresentation && accountStyles.managedContent,
          )}
        >
          <DocumentRequestPricingCard
            model={presentation === "native-page" && nativePricingAvailable ? nativePricingModel : undefined}
            onSaved={
              pricingReturnTo
                ? () => {
                    toast.success("Price saved");
                    router.replace(pricingReturnTo);
                  }
                : undefined
            }
          />
        </div>
      ),
    });
  } else if (!routeBlockedByVault && activePanel === "my-data") {
    profileStackEntries.push({
      key: "panel:my-data",
      title: "Memory",
      description: "Saved details and sharing.",
      content: (
        <div className="space-y-4">
          <LivingMemoryDocument />
          {myDataContent}
        </div>
      ),
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
            onPreviewOpenChange={(open) => { if (!open) closeDomainPreview(); }}
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
    if (activeDetail === "sharing") {
      profileStackEntries.push({
        key: "detail:sharing",
        title: "Access & sharing",
        description: "Review live access.",
        content: accessContent,
      });
    }
    if (selectedConnection) {
      profileStackEntries.push({
        key: `detail:connection:${selectedConnection.id}`,
        title: selectedConnection.requesterLabel,
        description: "Scopes and access.",
        content: (
          <div
            className={
              isPanePresentation
                ? secondaryTypographyStyles.paneAccess
                : undefined
            }
          >
            <PkmAccessConnectionDetailPanel
              connection={selectedConnection}
              onRevokeAccess={async (scope) => {
                await handleRevoke(scope);
              }}
            />
          </div>
        ),
      });
    }
    // A query destination must keep its own body while its record resolves,
    // and after access disappears. Showing the parent here made navigation
    // appear not to respond and changed the visible Back depth on refresh.
    const missingDomain = activeDetail?.startsWith("domain:") && !selectedDomain;
    const missingConnection = activeDetail?.startsWith("connection:") && !selectedConnection;
    if (missingDomain || missingConnection) {
      const pending = profileManagerLoading;
      const failed = !!pkmError || !!consentCenterError;
      profileStackEntries.push({
        key: `detail:${activeDetail}`,
        title: missingDomain ? "Memory details" : "Connection access",
        content: <p role="status" className="px-4 py-5 text-sm text-muted-foreground">
          {pending ? "Loading…" : failed ? "Couldn’t load these details. Go back and try again." :
            "These details are no longer available. Go back to Memory."}
        </p>,
      });
    }
  } else if (!routeBlockedByVault && activePanel === "connected-systems") {
    profileStackEntries.push({
      key: "panel:connected-systems",
      title: "Connected Systems",
      description: "Connected CRM systems.",
      content: connectedSystemsContent,
    });
  } else if (!routeBlockedByVault && activePanel === "connectors") {
    profileStackEntries.push(
      buildProfileConnectorsStackEntry({
        detail: activeDetail,
        updateView: updateProfileView,
        ...(presentation === "native-page" ? { content: retainedConnectors?.webBody ?? <p role="status">Loading connectors…</p> } : {}),
      }),
    );
  } else if (activePanel === "legal") {
    // Public documents: no vault needed to read them.
    profileStackEntries.push(
      ...buildProfileLegalStackEntries({
        detail: activeDetail,
        updateView: updateProfileView,
        paneIcons: isPanePresentation,
      }),
    );
  } else if (!routeBlockedByVault && activePanel === "preferences") {
    profileStackEntries.push({
      key: "panel:preferences",
      title: PROFILE_LABELS.preferences,
      description: "Theme, accent and how One writes.",
      content: preferencesContent,
    });
    if (activeDetail === "kai-preferences") {
      profileStackEntries.push({
        key: "detail:kai-preferences",
        title: "Finance preferences",
        description: "Investing preferences.",
        content: (
          <ProfileKaiPreferencesPanel
            model={nativeFinanceActive ? financePreferences : undefined}
            userId={applicationOwnerId}
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
        title: "AI connection",
        description: "Choose your AI connection.",
        content: (
          <GeminiRuntimeSettingsView model={runtimeSettings} />
        ),
      });
    } else if (activeDetail === "voice") {
      profileStackEntries.push({
        key: "detail:voice",
        title: "Voice",
        description: "One's voice controls.",
        content: (
          <VoicePreferencesPanel
            userId={applicationOwnerId}
            vaultOwnerToken={vaultOwnerToken}
            getIdToken={voiceGetIdToken}
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
              icon={PROFILE_ICONS.signOut}
              iconTone="capability"
              title="Sign out"
              description="Sign out on this device."
              onClick={() => void handleSignOut()}
              chevron
            />
          </SettingsGroup>
        ),
      });
    } else if (activeDetail === "trusted-devices") {
      profileStackEntries.push({
        key: "detail:trusted-devices",
        title: "Trusted devices",
        description: "Devices connected to your private agent.",
        content: <TrustedDevicesPage panePresentation={isPanePresentation} model={devicesModel} />,
      });
    }
  } else if (!routeBlockedByVault && activePanel === "gmail") {
    profileStackEntries.push({
      key: "panel:gmail",
      title: "Mail receipts",
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
  } else if (!routeBlockedByVault && activePanel === "referrals") {
    profileStackEntries.push({
      key: "panel:referrals",
      title: PROFILE_LABELS.referrals,
      description: "Your link and referrals.",
      content: presentation === "native-page" ? <ReferralsPanelView panePresentation model={nativeReferrals.model} /> : <ReferralsPanel panePresentation={isPanePresentation} />,
    });
  } else if (!routeBlockedByVault && activePanel === "support") {
    profileStackEntries.push({
      key: "panel:support",
      title: PROFILE_LABELS.support,
      description: "Tell us what you need. We'll route it to the right team.",
      content: supportContent,
    });
  }

  const menuGroups = profileMenuGroups(canShowPkmAgentLab);
  const menuActions: ProfileMenuActions = {
    hosting: () => updateProfileView({ panel: "hosting", detail: null }, "push"),
    "software-updates": () => updateProfileView({ panel: "software-updates", detail: null }, "push"),
    account: openAccountPanel,
    payouts: () => openVaultBackedPanel("payouts"),
    "request-pricing": () => openVaultBackedPanel("request-pricing"),
    "my-data": () => openVaultBackedPanel("my-data"),
    "world-model": () => openVaultBackedPanel("world-model"),
    preferences: openPreferencesPanel,
    security: openSecurityPanel,
    devices: () => openVaultBackedPanel("security", "trusted-devices"),
    connectors: () => openVaultBackedPanel("connectors"),
    invite: () => updateProfileView({ panel: "referrals", detail: null }, "push"),
    support: () => updateProfileView({ panel: "support", detail: null }, "push"),
    "developer-tools": () => router.push("/one/profile/pkm-agent-lab"),
    privacy: () => updateProfileView({ panel: "legal", detail: "privacy" }, "push"),
    terms: () => updateProfileView({ panel: "legal", detail: "terms" }, "push"),
    "sign-out": handleSignOut,
  };
  const profileRootContent = (
    <div
      className={cn(
        "profile-home-screen",
        isPanePresentation && "profile-home-screen--pane",
      )}
    >
      <AppPageHeaderRegion>
        <header
          className="profile-home-hero flex w-full min-w-0 items-center gap-3 px-0 text-left"
          data-slot="page-header"
          data-page-primary="true"
        >
          <ProfileAvatarEditor />
          <div className="profile-home-copy flex min-w-0 flex-1 flex-col items-start justify-center gap-1">
            <h1 className="profile-home-name ui-text-identity-name [overflow-wrap:anywhere]">
              {user.displayName || "User"}
            </h1>
            <div
              className="profile-home-meta flex w-full min-w-0 items-center justify-start gap-1.5 text-xs font-normal text-muted-foreground"
              title={provider.name}
            >
              <EmailIdentityMark email={user.email} providerId={provider.id} />
              <span className="[overflow-wrap:anywhere]">
                {user.email || "Not available"}
              </span>
            </div>
          </div>
        </header>
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <div className="profile-home-content">
            {menuGroups.map(group => <SettingsGroup key={group.id} title={group.title} separatorInset rowSizing="uniform">
              {group.entries.map(entry => <SettingsRow key={entry.id}
                icon={entry.icon} iconTone="capability" title={entry.label} chevron
                tone={"destructive" in entry && entry.destructive ? "destructive" : "default"}
                trailing={"localOnly" in entry ? <Badge variant="secondary">Local</Badge> : undefined}
                testId={entry.id === "privacy" || entry.id === "terms" ? `profile-legal-${entry.id}-row` : undefined}
                voiceControlId={"voiceControlId" in entry ? entry.voiceControlId : entry.id === "security" ? "profile_security" : entry.id === "invite" ? "profile_referrals" : undefined}
                voiceActionId={"voiceActionId" in entry ? entry.voiceActionId : entry.id === "security" ? "route.profile_security_panel" : entry.id === "invite" ? "route.profile_referrals_panel" : undefined}
                voiceLabel={"voiceActionId" in entry || entry.id === "security" || entry.id === "invite" ? entry.label : undefined}
                voicePurpose={"voicePurpose" in entry ? entry.voicePurpose : entry.id === "security" ? "Opens vault, account access, and account deletion controls." : entry.id === "invite" ? "Opens your referral link and referral status." : undefined}
                onClick={() => { void menuActions[entry.id](); }} />)}
            </SettingsGroup>)}
          </div>
        </SurfaceStack>
      </AppPageContentRegion>
    </div>
  );

  if (legacyProfileRedirectHref) {
    return null;
  }

  const vaultOverlays = <>
      <Dialog
        open={passphraseDialogOpen && (!vaultNativeActive || nativeVaultPasswordFallback)}
        onOpenChange={(open) => { if (!open) vaultMethods.closePassword(); }}
      >
        <DialogContent className="w-[calc(100%-1rem)] max-h-[calc(100svh-1rem)] overflow-y-auto sm:max-w-md">
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Set a new password for Vault unlock. Your passkey and biometric
            methods stay active.
          </DialogDescription>
          <div className="space-y-3 pt-2">
            <Input
              type="password"
              placeholder="New password (min 8 characters)"
              autoComplete="new-password"
              value={newPassphrase}
              onChange={(event) => vaultMethods.editPassword("password", event.target.value)}
            />
            <Input
              type="password"
              placeholder="Confirm password"
              autoComplete="new-password"
              value={confirmPassphrase}
              onChange={(event) => vaultMethods.editPassword("confirmation", event.target.value)}
            />
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
              <Button
                variant="none"
                effect="fade"
                size="default"
                className="w-full sm:w-auto"
                onClick={vaultMethods.closePassword}
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
                onClick={() => void vaultMethods.savePassword()}
              >
                {switchingVaultMethod ? "Saving..." : "Save new password"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(passkeyRemovalTarget) && !vaultNativeActive}
        onOpenChange={(open) => {
          if (!open) vaultMethods.cancelRemove();
        }}
      >
        <AlertDialogContent className="w-[calc(100%-1rem)] sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved passkey from One. It may still remain in
              your password manager, and password unlock will stay available.
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
                  void vaultMethods.remove();
                }
              }}
            >
              {switchingVaultMethod ? "Removing..." : "Remove passkey"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  </>;
  const page = (
    <AppPageShell
      data-testid="profile-primary"
      as="div"
      width="reading"
      fitContent
      className={cn(
        "relative isolate",
        isPanePresentation ? "profile-pane-page" : "pb-3",
        isPanePresentation &&
          activePanel !== null &&
          "profile-pane-page--inner",
      )}
      nativeTest={
        isPanePresentation
          ? undefined
          : {
              routeId: profileNativeRouteId,
              marker: "native-route-profile",
              authState: user ? "authenticated" : "pending",
              dataState: authLoading ? "loading" : "loaded",
            }
      }
    >
      <SettingsPresentationProvider density="compact">
        <ProfileStackNavigator
          rootContent={profileRootContent}
          entries={profileStackEntries}
          resetScroll={!isPanePresentation}
          onActiveEntryChange={presentation === "native-page" ? updateNativeActiveHeading : undefined}
        />
      </SettingsPresentationProvider>

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
          onOpenChange={handleVaultCreationOpenChange}
          title="Create your vault"
          description="Set up a password to secure your saved details."
          onSuccess={() => {
            vaultCreationCompletingRef.current = true;
            setShowVaultCreation(false);
            setHasVault(true);
            VaultService.setVaultCheckCache(applicationOwnerId, true);
            const returnTo = vaultReturnToRef.current;
            if (returnTo) {
              vaultReturnToRef.current = null;
              setPendingProfileTarget(null);
              router.replace(returnTo);
            } else if (pendingProfileTarget) {
              updateProfileView(
                {
                  panel: pendingProfileTarget.panel,
                  detail: pendingProfileTarget.detail,
                },
                pendingProfileTarget.mode,
              );
              setPendingProfileTarget(null);
            }
            toast.success("Vault created and unlocked.");
            setTimeout(() => {
              vaultCreationCompletingRef.current = false;
            }, 0);
          }}
        />
      )}

      {presentation !== "native-page" ? vaultOverlays : null}

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent
          className={cn(
            "w-[calc(100%-1rem)] sm:max-w-lg",
            cloudCleanupRequired && "max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain",
            !cloudCleanupRequired && accountStyles.accountDialogCompact,
            !cloudCleanupRequired && isPanePresentation && accountStyles.accountDialog,
            !cloudCleanupRequired && isPanePresentation && accountStyles.dangerDialog,
          )}
          overlayClassName={
            !cloudCleanupRequired && isPanePresentation ? accountStyles.accountDialogOverlay : undefined
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-[color:var(--app-destructive)]">
              <Icon icon={AlertTriangle} size="md" />
              {deleteDialogTitle}
            </AlertDialogTitle>
            <AlertDialogDescription className={accountStyles.accountDialogDescription}>
              {cloudCleanupRequired ? "Cloud cleanup is required before account deletion." : deleteDialogDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cloudCleanupRequired && applicationOwnerId ? <AccountCloudCleanup key={applicationOwnerId} userId={applicationOwnerId} token={vaultOwnerToken ?? null}
            onUnlock={() => { setShowDeleteConfirm(false); requestVaultUnlock("delete_account"); }}
            onFinish={handleDeleteAccount} /> : null}
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel
              className="w-full sm:w-auto"
              disabled={isDeleting}
            >
              {cloudCleanupRequired ? "Close" : "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-10 w-full px-4 py-2 text-center leading-tight sm:w-auto sm:min-w-[10rem]"
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteAccount();
              }}
              disabled={isDeleting || cloudCleanupRequired}
              hidden={cloudCleanupRequired}
            >
              {isDeleting ? "Deleting..." : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent
          className={cn(
            "w-[calc(100%-1rem)] sm:max-w-lg",
            accountStyles.accountDialogCompact,
            isPanePresentation && accountStyles.accountDialog,
          )}
          overlayClassName={
            isPanePresentation ? accountStyles.accountDialogOverlay : undefined
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Icon icon={RefreshCw} size="md" />
              {resetDialogTitle}
            </AlertDialogTitle>
            <AlertDialogDescription className={accountStyles.accountDialogDescription}>
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
              className="min-h-10 w-full px-4 py-2 text-center leading-tight sm:w-auto sm:min-w-[10rem]"
              onClick={(event) => {
                event.preventDefault();
                void handleResetAccount();
              }}
              disabled={isResetting}
            >
              {isResetting ? "Resetting..." : "Reset account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPageShell>
  );
  if (presentation !== "native-page") return page;
  const legalParent = profileLegalParentForPresentation(panePresentation?.history);
  const nativeLegal = projectNativeProfileLegal(activeDetail === "privacy" || activeDetail === "terms" ? activeDetail : null,
    (detail, mode) => updateProfileView({ panel: "legal", detail }, mode), () => router.push(ROUTES.DELETE_ACCOUNT), legalParent === true);
  const nativeAccountPage: NativeProfilePage = { id: "account", title: PROFILE_LABELS.account, sections: [
    { id: "account-portrait", rows: [
      { id: "account-photo", label: user.displayName || "Your account", detail: user.email || undefined, enabled: true, portrait: true,
        ...(nativePortrait ? { portraitData: nativePortrait } : {}) },
    ] },
    { id: "account-identity", title: "Identity", rows: [
      { id: "account-name", label: "Display name", detail: user.displayName || "Not available", enabled: true, artworkId: "account-name", trailing: "Edit" },
      { id: "account-mail", label: "Mail", detail: user.email || "Not available", enabled: true, readOnly: true, artworkId: "account-mail" },
      { id: "account-phone", label: "Phone number", detail: phoneSummaryText, enabled: !!phoneNumber || phoneNumberStatus !== "loading", artworkId: "account-phone", trailing: phoneNumber ? "Change" : phoneLookupPending ? "Retry" : "Add", chevron: true },
      { id: "account-provider", label: "Sign-in provider", detail: provider.name, enabled: true, readOnly: true },
      ...(walletCardEntryEnabled ? [{ id: "account-wallet", label: WALLET_CARD_COPY.profileEntry.title,
        detail: WALLET_CARD_COPY.profileEntry.description, enabled: true, artworkId: "account-wallet", chevron: true }] : []),
    ] },
    { id: "account-payments", title: "Payments", rows: [
      { id: "account-payments-open", label: "Payments and earnings", enabled: true, artworkId: "account-wallet", chevron: true },
    ] },
    { id: "account-email-updates", title: "Optional One email updates", rows: emailPreference.value ? [
      { id: "email-updates-choice", label: "One tips and product updates", detail: emailPreference.error ?? "Useful tips, demos and news. Unsubscribe anytime.",
        enabled: !!emailPreference.value && !emailPreference.busy, pending: emailPreference.loading || emailPreference.busy, toggle: true,
        options: [{ id: "email-updates-on", label: "On", selected: emailPreference.enabledDraft },
          { id: "email-updates-off", label: "Off", selected: !emailPreference.enabledDraft }] },
      { id: "email-updates-frequency", label: "Email frequency", enabled: !!emailPreference.value && !emailPreference.busy,
        options: [{ id: "email-updates-weekly", label: "Weekly digest", selected: emailPreference.frequencyDraft === "weekly" },
          { id: "email-updates-daily", label: "Daily tips", selected: emailPreference.frequencyDraft === "daily" },
          { id: "email-updates-news", label: "Product updates only", selected: emailPreference.frequencyDraft === "updates" }] },
      { id: "email-updates-save", label: emailPreference.busy ? "Saving…" : emailPreference.saved ? "Email preference saved" : "Save email preference", enabled: !emailPreference.busy &&
        (emailPreference.enabledDraft !== emailPreference.value.enabled || emailPreference.frequencyDraft !== emailPreference.value.frequency), pending: emailPreference.busy },
    ] : [{ id: "email-updates-retry", label: emailPreference.loading ? "Loading email preference…" : "Retry email preference",
      detail: emailPreference.error ?? undefined, enabled: !emailPreference.loading, pending: emailPreference.loading }] },
    { id: "account-operations", title: "Account actions", rows: [
      { id: "account-reset", label: "Reset account", detail: resetRowDescription, enabled: !isResetting, artworkId: "account-reset", chevron: true },
      { id: "account-delete", label: deleteButtonLabel, detail: deleteRowDescription, enabled: !isDeleting, destructive: true, artworkId: "account-delete", chevron: true },
    ] },
  ] };
  const nativeSecurityPage: NativeProfilePage = { id: "security", title: PROFILE_LABELS.security, sections: [
    { id: "security-methods", rows: [
      { id: "security-vault", label: "Vault methods", detail: "Password, passkey, and unlock method.", enabled: true, artworkId: "vault-methods", chevron: true },
    ] },
  ] };
  const nativeSessionPage: NativeProfilePage = { id: "session", title: PROFILE_LABELS.accountAccess, sections: [
    { id: "security-session", rows: [
      { id: "security-sign-out", label: "Sign out", detail: "Sign out on this device.", enabled: true, destructive: true, artworkId: "sign-out" },
    ] },
  ] };
  const accountConfirmation: NativeProfilePage | undefined = showDeleteConfirm || showResetConfirm ? {
    id: showDeleteConfirm ? "account-delete" : "account-reset",
    title: showDeleteConfirm ? deleteDialogTitle : resetDialogTitle,
    sections: [{ id: "account-confirmation", rows: [
      { id: "account-confirmation-description", label: showDeleteConfirm ? deleteDialogDescription : resetDialogDescription,
        enabled: true, readOnly: true },
      { id: "account-confirmation-submit", label: showDeleteConfirm ? isDeleting ? "Deleting…" : "Delete account" : isResetting ? "Resetting…" : "Reset account",
        enabled: !isDeleting && !isResetting, pending: isDeleting || isResetting, destructive: true },
      { id: "account-confirmation-cancel", label: "Cancel", enabled: !isDeleting && !isResetting },
    ] }],
  } : undefined;
  return <><RetainedProfileConnectors open={nativeMenuOpen && activePanel === "connectors" && vaultAccess.canMutateSecureData}
    connectorId={activeDetail?.startsWith("connector:") ? activeDetail.slice("connector:".length) : null}
    onConnectorChange={changeRetainedConnector} publish={setRetainedConnectors} />
  <NativeProfilePresentation lifetime={nativeDetailOwner} detail={!!activePanel} onVoiceCapability={setNativeVoiceAvailable} onDevicesCapability={setNativeDevicesAvailable} onVaultCapability={setNativeVaultAvailable} onPricingCapability={setNativePricingAvailable} onPayoutCapability={setNativePaymentsAvailable} onMemoryCapability={setNativeMemoryAvailable} onSharedMemoryCapability={setNativeSharedMemoryAvailable} onSecretMemoryCapability={setNativeSecretsAvailable} onFinanceCapability={setNativeFinanceAvailable} onWorldModelCapability={setNativeWorldModelAvailable} onRuntimeCapability={setNativeRuntimeAvailable} onConnectorsCapability={setNativeConnectorsAvailable}
    referrals={{ active: nativeReferralActive, pages: nativeReferrals.pages, rows: nativeReferrals.rows, editor: nativeReferrals.editor, formScene: nativeReferrals.formScene,
      root: () => updateProfileView({ panel: null, detail: null }, "replace") }}
    workspace={activePanel === "hosting" || activePanel === "software-updates" ? { kind: activePanel,
      active: agentSettingsActive && !showVaultUnlock, pages: nativeAgentSettings.pages, rows: nativeAgentSettings.rows,
      back: () => { if (nativeAgentSettings.navigationBlocked()) return false; if (!nativeAgentSettings.back()) popProfileStack(); return true; },
      ancestor: () => { if (nativeAgentSettings.root()) return true; return false; },
      root: () => { if (!nativeAgentSettings.root()) return false; updateProfileView({ panel: null, detail: null }, "replace"); return true; }
    } : activePanel === "connectors" ? { kind: "connectors", active: nativeConnectorsActive && !showVaultUnlock,
      visitKey: activeDetail ?? "catalog", pages: nativeConnectors.pages, rows: nativeConnectors.rows, editor: nativeConnectors.editor, ancestor: nativeConnectors.ancestor, formScene: nativeConnectors.formScene,
      back: () => { if (nativeConnectors.navigationBlocked()) return false; if (!nativeConnectors.back()) popProfileStack(); return true; },
      root: () => {
        if (nativeConnectors.navigationBlocked()) return false;
        retainedConnectors?.custom?.nativeEditor.cancelEditor(); retainedConnectors?.custom?.cancelRemove(); retainedConnectors?.confirmation?.cancel();
        updateProfileView({ panel: null, detail: null }, "replace"); return true;
      }
    } : activePanel === "world-model" ? { kind: "world-model", active: nativeWorldModelActive && !showVaultUnlock,
      pages: nativeWorldModel.pages, rows: nativeWorldModel.rows, ancestor: nativeWorldModel.ancestor, editor: nativeWorldModel.editor, formScene: nativeWorldModel.formScene,
      back: () => { if (nativeWorldModel.navigationBlocked()) return false; if (!nativeWorldModel.back()) popProfileStack(); return true; },
      root: () => { if (nativeWorldModel.navigationBlocked()) return false; updateProfileView({ panel: null, detail: null }, "replace"); return true; }
    } : activePanel === "my-data" ? { kind: "memory", visitKey: activeDetail ?? "root", active: nativeMemoryActive && !showVaultUnlock && !nativeMemoryWebBody,
      pages: nativeMemory.pages, rows: nativeMemory.rows, ancestor: nativeMemory.ancestor,
      formScene: nativeContextOpen && !nativeContextFailed ? "memory-financial-context" : null,
      editor: destinationId => nativeContextOpen && !nativeContextFailed ? <NativeMemoryEditor owner={nativeDetailOwner} destinationId={destinationId}
        model={{ current: contextVisit.current, draft: { category: financialContextCategory, text: financialContextText },
          inputRevision: () => financialDraft.current.revision, mutationPending: () => memoryOperations.writing("financial"),
          busy: savingFinancialContext, error: nativeContextError, canSave: !!financialContextText.trim(),
          changeDraft: (draft: NativeMemoryDraft, expected) => {
            if (!contextVisit.current() || memoryOperations.writing("financial") || !validNativeMemoryDraft(draft) || expected !== undefined && expected !== financialDraft.current.revision) return false;
            financialDraft.current = { ...financialDraft.current, ...draft, revision: financialDraft.current.revision + 1 };
            renderFinancialContextText(draft.text); renderFinancialContextCategory(draft.category); setNativeContextError(null); return true;
          }, save: handleSaveFinancialContext }}
        onClose={() => { setNativeContextOpen(false); setEditingFinancialContextId(null); setFinancialContextText(""); setFinancialContextCategory("general"); }}
        onSaved={() => setNativeContextOpen(false)} onFallback={() => { setNativeContextFailed(true); setNativeMemoryWebBody(true); }} /> : null,
      back: () => { if (nativeMemory.navigationBlocked()) return false; if (!nativeMemory.back()) popProfileStack(); return true; },
      root: () => { if (nativeMemory.navigationBlocked()) return false; updateProfileView({ panel: null, detail: null }, "replace"); return true; }
    } : activePanel === "payouts" ? { kind: "payouts", active: nativePayoutActive && !showVaultUnlock, pages: nativePayout.pages, rows: nativePayout.rows,
      onPresented: nativePayout.onPresented,
      ancestor: nativePayout.ancestor,
      formScene: nativePayout.formScene, editor: destinationId => nativePayout.editor(destinationId, () => setNativePaymentsFailed(true)),
      back: () => { if (nativePayout.busy) return false; if (!nativePayout.back()) popProfileStack(); return true; },
      root: () => { if (!nativePayout.reset()) return false; updateProfileView({ panel: null, detail: null }, "replace"); return true; } } : { kind: "request-pricing", active: nativePricingActive && !showVaultUnlock, pages: [nativePricing.page], rows: nativePricing.rows,
      root: () => updateProfileView({ panel: null, detail: null }, "replace"), formScene: nativePricingEditorOpen ? "request-price" : null,
      editor: destinationId => nativePricingEditorOpen ?
        <NativeRequestPricingEditor userId={applicationOwnerId} model={nativePricingModel} destinationId={destinationId}
          onClose={() => setNativePricingEditorOpen(false)} onFallback={() => { setNativePricingEditorOpen(false); setNativePricingFailed(true); }} /> : null }}
    detailOverlay={<>{nativeAccountException === "photo" ? <ProfileAvatarEditor openOnMount optionsOnMount
      onPresentationClose={() => setNativeAccountException(null)} /> : null}{vaultOverlays}</>}
    phone={{ active: activePanel === "account" && activeDetail === "phone" && !showVaultUnlock && nativeMenuOpen && !phoneLookupPending,
      editor: options => <NativePhoneVerificationFlow {...options} ownerKey={phoneVisit.id} isCurrent={phoneVisitIsCurrent}
        webHost={nativePhoneHost} mode={phoneNumber ? "replace" : "link"} currentPhoneNumber={phoneNumber}
        startVerification={phoneNumber ? startPhoneReplacement : startPhoneVerification}
        confirmVerification={phoneNumber ? confirmPhoneReplacement : confirmPhoneVerification}
        onCompleted={handleAccountPhoneCompleted} onBackStepChange={bindPhoneBackStep} onCancel={popProfileStack}
        confirmLabel="Save phone number" helperText={phoneNumber ? "Enter the new phone number." : "Enter your phone number."}
        className={cn("gap-5", isPanePresentation && accountStyles.phoneDetail)} /> }}
    legal={{ active: activePanel === "legal" && (!activeDetail || legalParent !== null) && !showVaultUnlock, ...nativeLegal,
      root: () => updateProfileView({ panel: null, detail: null }, "replace") }}
    support={{ active: activePanel === "support" && !showVaultUnlock, editor: (destinationId, onFallback) =>
      <NativeSupportComposer destinationId={destinationId} onFallback={onFallback} model={{
        userId: applicationOwnerId, ready: isVaultUnlocked, draft: { kind: supportKind, message: supportMessage },
        busy: sendingSupportMessage, sent: supportComposerState.status === "sent",
        error: supportMessageError ?? (supportComposerState.status === "error" ? supportComposerState.message : null),
        replyLine: supportReplyLine, placeholder: supportPresentation.placeholder, submitLabel: supportPresentation.submitLabel,
        successTitle: supportPresentation.successTitle,
        successDescription: supportKind === "support_request" && effectiveReplyEmail ? supportReplyLine : supportPresentation.successDescription,
        change: changeSupportDraft, send: () => submitSupportMessage(), close: () => {
          setSupportComposerState({ status: "editing" });
          updateProfileView({ panel: null, detail: null }, "replace");
        },
      }} /> }}
    settings={{ active: !showVaultUnlock && (activePanel === "preferences" && (!activeDetail || activeDetail === "voice" && voiceParent !== null || nativeFinanceActive || nativeRuntimeActive) ||
        activePanel === "security" && (!activeDetail || activeDetail === "session" || devicesActive && nativeDevicesAvailable && devicesParent !== null ||
          vaultNativeActive && vaultParent !== null && !nativeVaultPasswordFallback)),
      formScene: vaultNativeActive && passphraseDialogOpen ? "vault-passphrase" : nativeRuntimeActive ? nativeRuntime.formScene : nativePreferences.formScene,
      requiresVoice: activePanel === "preferences" && activeDetail === "voice",
      requiresFinance: nativeFinanceActive,
      requiresRuntime: nativeRuntimeActive,
      requiresDevices: devicesActive,
      requiresVault: vaultNativeActive,
      ...(devicesActive && devicesModel.confirmation ? { back: devicesModel.cancel } : {}),
      ...(vaultNativeActive && nativeVault.nested ? { back: () => { if (switchingVaultMethod) return false; return nativeVault.back(); } } : {}),
      ...(nativeFinanceActive ? { back: () => {
        if (nativeFinance.busy) return false;
        if (financePreferences.wizard.horizonDialogOpen) { nativeFinance.back(); return true; }
        if (financePreferences.wizard.step > 0) { nativeFinance.back(); return false; }
        popProfileStack(); return true;
      } } : {}),
      ...(nativeRuntimeActive ? { back: () => { if (runtimeSettings.operationPending()) return false; popProfileStack(); return true; } } : {}),
      ancestor: choice => {
        if (choice.rowId === "preferences" && nativeFinanceActive && voiceParent === true) {
          if (nativeFinance.busy) return false;
          financePreferences.wizard.cancelHorizon(); popProfilePaneLocation(pathname, searchParams); return true;
        }
        if (choice.rowId === "security" && vaultNativeActive && vaultParent === true) {
          if (switchingVaultMethod) return false;
          nativeVault.back(); popProfilePaneLocation(pathname, searchParams); return true;
        }
        if (choice.rowId !== "security" || !devicesActive || devicesParent !== true || devicesModel.busy) return false;
        // Consume the local confirmation once, then invoke the existing query
        // parent directly. Re-entering Back layers would consume that same
        // not-yet-committed confirmation instead of reaching Security.
        devicesModel.cancel(); popProfilePaneLocation(pathname, searchParams); return true;
      },
      pages: activePanel === "preferences" ? nativeRuntimeActive ? [...(voiceParent === true ? [nativePreferences.page] : []), nativeRuntime.page] : nativeFinanceActive ? [...(voiceParent === true ? [nativePreferences.page] : []), ...nativeFinance.pages] : activeDetail === "voice" ? [...(voiceParent === true ? [nativePreferences.page] : []), nativeVoice.page] : [nativePreferences.page] : devicesActive ? [...(devicesParent === true ? [nativeSecurityPage] : []), ...nativeDevices.pages] : vaultNativeActive ? [...(vaultParent === true ? [nativeSecurityPage] : []), ...nativeVault.pages] : [nativeSecurityPage, ...(activeDetail === "session" ? [nativeSessionPage] : [])],
      rows: new Map([...nativePreferences.rows, ...nativeVoice.rows, ...nativeDevices.rows, ...nativeVault.rows, ...nativeFinance.rows, ...nativeRuntime.rows,
        ["security-vault", () => updateProfileView({ panel: "security", detail: "vault" }, "push")] as const,
        ["security-sign-out", () => handleSignOut()] as const,
      ]), root: () => { if (switchingVaultMethod || nativeFinanceActive && nativeFinance.busy || nativeRuntimeActive && runtimeSettings.operationPending()) return false; vaultMethods.cancelRemove(); devicesModel.cancel(); updateProfileView({ panel: null, detail: null }, "replace"); return true; },
      editor: destinationId => <>{nativePreferences.editor(destinationId)}
        {nativeRuntimeActive ? nativeRuntime.editor(destinationId) : null}
        {vaultNativeActive && passphraseDialogOpen && destinationId ? <NativeVaultPasswordEditor model={vaultMethods} userId={applicationOwnerId}
          destinationId={destinationId} onFallback={() => setNativeVaultPasswordFallback(true)} /> : null}</> }}
    account={{ active: activePanel === "account" && (!activeDetail || activeDetail === "phone" && !phoneLookupPending) && !nativeAccountException && !showVaultUnlock && !cloudCleanupRequired,
      page: nativeAccountPage, confirmation: accountConfirmation, formScene: editingDisplayName && activePanel === "account" && !activeDetail ? "account-name" : null,
      root: () => {
        if (isDeleting || isResetting) return;
        dismissAccountConfirmation(); updateProfileView({ panel: null, detail: null }, "replace");
      },
      ...(accountConfirmation ? { back: dismissAccountConfirmation } : {}), rows: new Map([
        ["account-photo", () => setNativeAccountException("photo")],
        ["account-name", () => setEditingDisplayName(true)],
        ["account-phone", () => { if (phoneLookupPending) { void retryPhoneLookup(); return; } updateProfileView({ panel: "account", detail: "phone" }, "push"); }],
        ["account-wallet", () => router.push(ROUTES.ONE_WALLET_CARD)],
        ["account-payments-open", () => openVaultBackedPanel("payouts")],
        ["email-updates-on", () => emailPreference.edit(true, emailPreference.frequencyDraft)],
        ["email-updates-off", () => emailPreference.edit(false, emailPreference.frequencyDraft)],
        ["email-updates-weekly", () => emailPreference.edit(emailPreference.enabledDraft, "weekly")],
        ["email-updates-daily", () => emailPreference.edit(emailPreference.enabledDraft, "daily")],
        ["email-updates-news", () => emailPreference.edit(emailPreference.enabledDraft, "updates")],
        ["email-updates-save", () => { void emailPreference.save(emailPreference.enabledDraft, emailPreference.frequencyDraft); }],
        ["email-updates-retry", () => { void emailPreference.refresh(); }],
        ["account-reset", handleResetClick],
        ["account-delete", handleDeleteClick],
        ["account-confirmation-cancel", dismissAccountConfirmation],
        ["account-confirmation-submit", async () => {
          if (isDeleting || isResetting) return;
          if (showDeleteConfirm) await handleDeleteAccount();
          else if (showResetConfirm) await handleResetAccount();
        }],
      ]), editor: destinationId => editingDisplayName && activePanel === "account" && !activeDetail ?
        <NativeDisplayNameEditor user={user} destinationId={destinationId} portalFallback webHost={nativeNameHost}
          onWebFallback={() => setNativeAccountException("name")}
          onSaved={() => setEditingDisplayName(false)} onCancel={() => setEditingDisplayName(false)} /> : null }}
    menu={{ owner: applicationOwnerId, ready: isVaultUnlocked, open: nativeMenuOpen, surfaceOpen: nativeMenuOpen,
      ...(agentSettingsActive ? { navigationLocked: nativeAgentSettings.navigationBlocked() } : nativePayoutActive ? { navigationLocked: nativePayout.busy } : nativeConnectorsActive ? { navigationLocked: nativeConnectors.blocking } : nativeWorldModelActive ? { navigationLocked: nativeWorldModel.blocking } : nativeMemoryActive ? { navigationLocked: nativeMemory.busy } : nativeRuntimeActive ? { navigationLocked: runtimeSettings.isSaving || runtimeSettings.isRemoving || runtimeSettings.credentialValidation.status === "checking" } : {}),
      enabled: !isDeleting && !isResetting && !(devicesActive && devicesModel.busy) && !(nativeFinanceActive && nativeFinance.busy) &&
        !(vaultNativeActive && switchingVaultMethod && !passphraseDialogOpen),
      name: user.displayName || "Your account", email: user.email, portrait: nativePortrait,
      onClose: () => {
        if (agentSettingsActive && nativeAgentSettings.navigationBlocked() || nativePayoutActive && nativePayout.busy) return false;
        if (nativeConnectorsActive && nativeConnectors.navigationBlocked() || nativeWorldModelActive && nativeWorldModel.navigationBlocked() ||
            nativeMemoryActive && nativeMemory.navigationBlocked() || nativeRuntimeActive && runtimeSettings.operationPending()) return false;
        return closeNativeProfile();
      },
      groups: menuGroups, actions: menuActions }}
    page={{ pane: true, contentInset: "profile", bodyClassName: "profile-pane-scroll-root",
      title: nativeActiveHeading?.owner === nativeDetailOwner ? nativeActiveHeading.title : typeof profileStackEntries.at(-1)?.title === "string" ? String(profileStackEntries.at(-1)?.title) : "Profile",
      owner: applicationOwnerId, context: JSON.stringify([applicationOwnerId, snapshotVaultSessionEpoch(), activePanel, activeDetail]),
      onClose: closeNativeProfile, onBack: () => backProfilePane(pathname, searchParams) }}>
    {page}
  </NativeProfilePresentation></>;
}

export function ProfilePage(props: ProfilePageProps) {
  // Profile cannot depend on a feature body's hosting admission. Connectors
  // keeps its complete owner-aware React handoff until both hosting modes have
  // a qualified native model port; the other native scenes remain independent.
  return <Suspense fallback={null}><ProfilePageContent {...props} /></Suspense>;
}

export default ProfilePage;
