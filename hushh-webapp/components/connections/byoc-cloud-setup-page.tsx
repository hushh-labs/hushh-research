"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { ByocSetupFailedCard } from "@/components/connections/byoc-setup-failed-card";
import { GeminiRuntimeConfigurationPage } from "@/components/connections/gemini-runtime-configuration-page";
import { AzureFreeTrialNote, SetupStageChecklist } from "@/components/connections/byoc-setup-stage-checklist";
import { HostingChoiceCards, type HostingChoice } from "@/components/connections/hosting-choice-cards";
import {
  azureConnected,
  AttachBlockedCard,
  ConnectingToAgentCard,
  ConsentPendingCard,
  DirectIngressBlockedCard,
  HusshPodsPausedCard,
  hostingOptionsFor,
} from "@/components/connections/hosting-placement-cards";
import {
  HusshPodsActiveCard,
  HusshPodsMigrationCard,
  PooledSandboxSwitchCard,
} from "@/components/connections/hussh-pods-cloud-card";
import { OwnerCloudProviderChoice } from "@/components/connections/owner-cloud-provider-choice";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { Button } from "@/components/ui/button";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { notifyGeminiRuntimeConfigurationChanged } from "@/lib/connections/gemini-runtime-configuration";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionPrincipal,
} from "@/lib/auth/session-owner";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import {
  azureSubscriptionFromRef,
  useAzureSetupStartedSignal,
  useAzureSignIn,
} from "@/lib/one/azure-sign-in";
import {
  setupChecklistFor,
  setupJobProvider,
  setupRetryFor,
} from "@/lib/one/cloud-setup-stages";
import {
  consentPendingEntry,
  directIngressBlocker,
  readHostingMode,
  retryDirectIngress,
  retryOwnerCloudAttach,
  type DirectIngressBlocker,
  type HostingMode,
} from "@/lib/one/hosting-placement";
import {
  hostedPodProvider,
  isAzureHomeSelectable,
  isHostedAzureMigrationAvailable,
  isHostedPodTierUnderMaintenance,
  isOwnerCloudTarget,
  isPooledSandboxSwitchAvailable,
  ownerCloudProvider,
  type OwnerCloudProvider,
} from "@/lib/one/owner-cloud";
import { hasStoredAiKey } from "@/lib/one/setup-runtime-readiness";
import { ApiService } from "@/lib/services/api-service";
import { FinanceSetupDraftService } from "@/lib/services/finance-setup-draft-service";
import { acknowledgeOneSetupExit } from "@/lib/services/one-setup-exit-service";
import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { useBackLayer } from "@/lib/navigation/back-layers";
import {
  buildOneSetupFinanceImportRoute,
  buildOneSetupRoute,
  isOneSetupSurfaceRoute,
  resolveOneSetupReturnTo,
  ROUTES,
} from "@/lib/navigation/routes";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { VaultContext } from "@/lib/vault/vault-context";
import { useCloudSetupManagementReturn } from "./use-cloud-setup-management-return";

/**
 * `/one/setup/cloud` — where a person's private agent gets somewhere to live.
 *
 * This step chooses the hosting placement independently of AI provider access.
 * Nothing is a default: a person with no placement (`unplaced`) picks a tier, and
 * Shared is recorded only when chosen. An own cloud runs to "Connecting" until direct.
 *
 * The owner signs in to their cloud once: Google for a Google Cloud project,
 * Microsoft for an Azure subscription. The server creates or verifies the home,
 * proves authorization, and only then records the cloud assignment.
 */

/** How long "Checking your cloud..." may stay on screen before the form shows. */
export const CLOUD_CHECK_TIMEOUT_MS = 15_000;

export function ByocCloudSetupPage() {
  const { user } = useAuth();
  const owner = snapshotValidatedAuthSessionPrincipal();
  return <OwnerCloudSetupPage key={`${user?.uid ?? "signed-out"}:${owner?.generation ?? "unresolved"}`} user={user} owner={owner} />;
}

function OwnerCloudSetupPage({ user, owner }: {
  user: ReturnType<typeof useAuth>["user"];
  owner: ReturnType<typeof snapshotValidatedAuthSessionPrincipal>;
}) {
  const ownerId = owner?.ownerId ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const migrationRequested = searchParams.get("intent") === "migrate";
  const vaultContext = useContext(VaultContext);
  const vaultKey = vaultContext?.vaultKey ?? null;
  const vaultOwnerToken = vaultContext?.vaultOwnerToken ?? null;
  const isVaultUnlocked = vaultContext?.isVaultUnlocked ?? false;
  const queueEntryWelcome = useOneConversationSession((state) => state.queueEntryWelcome);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [pendingDirectVaultFinish, setPendingDirectVaultFinish] = useState(false);
  const [finalizingSetup, setFinalizingSetup] = useState(false);
  const finalizationInFlightRef = useRef<Promise<string | null> | null>(null);
  const ownerCurrent = useCallback(() => Boolean(owner && owner.firebaseUid === user?.uid && isValidatedAuthSessionOwnerCurrent(owner)), [owner, user?.uid]);
  useCloudSetupManagementReturn(ownerId ?? undefined, ownerCurrent);
  const [saving, setSaving] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const authorizationStarting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // The already-connected state, resolved on mount. This page used to hold all
  // connection truth in per-session state, so a person whose cloud was fully
  // recorded came back to a blank form with a dead Finish button (audit
  // finding, 2026-08-21). The durable cloud marker follows proof, so the
  // owner's registry assignment is the source for this revisit state.
  const [existing, setExisting] = useState<{
    projectId: string;
    rationale: string;
  } | null>(null);
  // Which hosting card is picked. Null falls back to the confirmed Shared state.
  const [choice, setChoice] = useState<HostingChoice | null>(() =>
    searchParams.get("intent") === "own" ? "own" : null,
  );
  // The hosted door stays paused outside Dev unless NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE=0;
  // on Dev (`NEXT_PUBLIC_APP_ENV=dev`) it opens for fixed-cohort pilot owners.
  const hostedUnderMaintenance = isHostedPodTierUnderMaintenance();
  const [hostedSaving, setHostedSaving] = useState(false);
  const [hosted, setHosted] = useState<Awaited<
    ReturnType<typeof ApiService.selectHostedCloud>
  > | null>(null);
  const [sharedChosen, setSharedChosen] = useState(false);
  const [sharedSaving, setSharedSaving] = useState(false);
  const [hostingMode, setHostingMode] = useState<HostingMode | null>(null);
  // Lifecycle state and the hub's typed org-policy blocker, for the direct path.
  const [agentState, setAgentState] = useState<string | null>(null);
  const [agentTarget, setAgentTarget] = useState<string | null>(null);
  const [directBlocker, setDirectBlocker] = useState<DirectIngressBlocker | null>(null);
  const [hostingStatusChecked, setHostingStatusChecked] = useState(false);
  const [ownCloudAvailable, setOwnCloudAvailable] = useState(false);
  const [reservedProjectId, setReservedProjectId] = useState<string | null>(null);
  // Which owner cloud the registry names, so a reserved or assigned Azure home
  // is never sent down the Google authorization path.
  const [ownerProvider, setOwnerProvider] = useState<OwnerCloudProvider | null>(null);
  const azureSignIn = useAzureSignIn({ isCurrent: ownerCurrent });
  const { start: startAzureSignIn } = azureSignIn;
  // The live stage record of the background setup job. Fetched on mount (a
  // person can leave and come back mid-job) and polled every 2s while running.
  // A setup's popup finished and the hub started the job: read it now, not in 2s.
  const [setupPollNonce, setSetupPollNonce] = useState(0);
  useAzureSetupStartedSignal(() => setSetupPollNonce((value) => value + 1), "setup");
  // Where the agent lives is read once on mount; a job this page watched run
  // to recorded re-reads it, or the screen stays on "still in progress".
  const [agentStatusNonce, setAgentStatusNonce] = useState(0);
  const watchedRunningJob = useRef(false);
  const [job, setJob] = useState<Awaited<
    ReturnType<typeof ApiService.getByocSetupStatus>
  > | null>(null);
  // The first answer from the job store has not arrived yet. Until it has,
  // the page must not show the tier choice: on the return from Google the
  // choice flashed for a beat before the "connected" state replaced it
  // (founder-hit, 2026-09-02). Failed polls give up into the form, never hang.
  const [checked, setChecked] = useState(false);
  const [setupStatusReadOk, setSetupStatusReadOk] = useState(false);
  const [checkTimedOut, setCheckTimedOut] = useState(false);

  // "Checking your agent home..." must end. If placement or setup state cannot
  // be read, the page offers refresh and keeps every existing assignment intact.
  useEffect(() => {
    if (!ownerId) return;
    if (checked && hostingStatusChecked) {
      setCheckTimedOut(false);
      return;
    }
    const ceiling = setTimeout(() => {
      setCheckTimedOut(true);
      setChecked(true);
    }, CLOUD_CHECK_TIMEOUT_MS);
    return () => clearTimeout(ceiling);
  }, [ownerId, checked, hostingStatusChecked]);

  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    void ApiService.getPersonalAgentStatus()
      .then((status) => {
        if (cancelled || !ownerCurrent()) return;
        const mode = readHostingMode(status.hostingMode);
        const provider = ownerCloudProvider(status.deploymentTarget);
        setHostingMode(mode);
        setOwnCloudAvailable(status.featureEnabled === true);
        setAgentState(status.state ?? null);
        setAgentTarget(status.deploymentTarget ?? null);
        setDirectBlocker(directIngressBlocker(status));
        setOwnerProvider(provider);
        setHostingStatusChecked(true);
        const unassignedByoc =
          (mode === "pending" || mode === "byoc") &&
          status.state === "reserved" &&
          isOwnerCloudTarget(status.deploymentTarget) &&
          Boolean(status.cloudProject);
        const byocState = status.state ?? null;
        const byocUnavailableState =
          byocState === "connecting" ||
          byocState === "provisioning" ||
          byocState === "failed";
        setReservedProjectId(
          unassignedByoc ? status.cloudProject ?? null : null,
        );
        if (
          mode === "hussh_pods" &&
          (status.deploymentTarget === "ace" || status.state === "active") &&
          typeof PreVaultUserStateService.markOneRuntimeChoice === "function" &&
          !PreVaultUserStateService.hasOneRuntimeChoice(
            PreVaultUserStateService.getCachedBootstrapState(ownerId),
          )
        ) {
          void PreVaultUserStateService.markOneRuntimeChoice(
            ownerId,
            "hushh_managed_vertex",
          ).catch(() => undefined);
        }
        if (mode === "byoc" && provider === "azure" && !unassignedByoc && !byocUnavailableState) {
          setExisting(azureConnected(status.cloudProject));
        } else if (mode === "byoc" && status.cloudProject && !unassignedByoc && !byocUnavailableState) {
          setExisting({
            projectId: status.cloudProject,
            rationale: "Your own-cloud agent is still assigned.",
          });
        } else {
          setExisting(null);
          if (mode === "byoc" && !unassignedByoc && !byocUnavailableState) {
            setChoice("own");
          }
        }
      })
      .catch(() => {
        if (!cancelled && ownerCurrent()) {
          setHostingMode("unknown");
          setOwnCloudAvailable(false);
          setReservedProjectId(null);
          setHostingStatusChecked(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, agentStatusNonce, ownerCurrent]);
  const refreshAgent = useCallback(() => setAgentStatusNonce((value) => value + 1), []);
  // A recorded job is read once; an attach outcome (attachBlocked) needs both re-read.
  const refreshAttach = useCallback(() => {
    refreshAgent();
    setSetupPollNonce((value) => value + 1);
  }, [refreshAgent]);

  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const status = await ApiService.getByocSetupStatus();
        if (cancelled) return;
        setJob(status.status === "none" ? null : status);
        setChecked(true);
        setSetupStatusReadOk(true);
        if (status.status === "running") watchedRunningJob.current = true;
        if (status.status === "recorded" && watchedRunningJob.current) {
          watchedRunningJob.current = false;
          setAgentStatusNonce((value) => value + 1);
        }
        const byocReadyState =
          agentState !== "connecting" &&
          agentState !== "provisioning" &&
          agentState !== "failed";
        if (status.status === "recorded") {
          // Only a Google job restores its project from the Google suggestion;
          // an Azure home is already named by the registry status above.
          if (hostingMode === "byoc" && byocReadyState && setupJobProvider(status) === "gcp") {
            // The durable marker just landed server-side; refresh the shared
            // bootstrap and restore the BYOC project shown to the person.
            await PreVaultUserStateService.bootstrapState(ownerId, {
              force: true,
            }).catch(() => undefined);
            if (cancelled) return;
            const suggestion = await ApiService.suggestByocProject().catch(
              () => null,
            );
            if (cancelled) return;
            if (suggestion) {
              setExisting({
                projectId: suggestion.projectId,
                rationale: suggestion.rationale ?? "",
              });
            }
          }
          return;
        }
        if (status.status === "running" && !status.stale) {
          timer = setTimeout(() => void poll(), 2000);
        }
      } catch {
        // A missed poll is not a verdict; retry a few times, then stop rather
        // than hammering a deployment that has no job store (the naming form
        // below is always a truthful fallback).
        failures += 1;
        if (!cancelled && failures < 3) {
          timer = setTimeout(() => void poll(), 4000);
        } else {
          setChecked(true);
        }
      }
    };
    let failures = 0;

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ownerId, hostingMode, agentState, setupPollNonce]);

  useEffect(() => {
    if (
      !ownerId ||
      (hostingMode !== "shared" &&
        (hostingMode !== "byoc" ||
          ownerProvider === "azure" ||
          agentState === "connecting" ||
          agentState === "provisioning" ||
          agentState === "failed"))
    )
      return;
    // A saved Shared choice cannot conceal an interrupted own-cloud setup.
    if (hostingMode === "shared" && (!setupStatusReadOk || job !== null)) return;
    let cancelled = false;
    void (async () => {
      try {
        const state =
          PreVaultUserStateService.getCachedBootstrapState(ownerId) ??
          (await PreVaultUserStateService.bootstrapState(ownerId));
        if (cancelled || !PreVaultUserStateService.hasOneCloudProject(state)) {
          return;
        }
        if (hostingMode === "shared") {
          setSharedChosen(true);
          return;
        }
        const suggestion = await ApiService.suggestByocProject();
        if (cancelled) return;
        setExisting({
          projectId: suggestion.projectId,
          rationale: suggestion.rationale ?? "",
        });
      } catch {
        // Resolving the connected state is best-effort; the naming form is
        // always a truthful fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerId, hostingMode, ownerProvider, agentState, setupStatusReadOk, job]);

  usePublishVoiceSurfaceMetadata({ screenId: "one_setup_cloud" });

  // The OAuth return route lands back here with the server's refusal when the
  // one-click flow could not finish (no billing account, name taken, ...).
  // Surfacing it verbatim is the whole point: it names the person's next move.
  useEffect(() => {
    const reason = searchParams.get("authorize_error");
    if (reason) setError(reason);
  }, [searchParams]);

  // Someone arriving from "Move it to my cloud" has already chosen; showing them
  // the choice again would ask a question they just answered. Their agent keeps
  // running on the hosted tier until their own project is proven, so this is the
  // first half of the move, not a switch that strands them mid-way.
  useEffect(() => {
    if (migrationRequested) setChoice("own");
  }, [migrationRequested]);

  const handleProjectNamed = useCallback(async (projectId: string) => {
    if (!ownerCurrent() || authorizationStarting.current) return;
    if (!ownCloudAvailable) return;
    authorizationStarting.current = true;
    setSaving(true);
    setError(null);
    try {
      // A transient suggestion failure must not strand someone who entered
      // an existing project. The backend alone admits Files to this setup.
      const suggestion = await ApiService.suggestByocProject().catch(() => null);
      if (!ownerCurrent()) return;
      const begun = await ApiService.beginByocAuthorize({
        projectId,
        filesEnabled: suggestion?.filesAvailable === true,
      });
      if (ownerCurrent()) window.location.assign(begun.authUrl);
      return;
    } catch (err) {
      const serverReason =
        err instanceof Error &&
        err.message &&
        err.message !== "BYOC_AUTHORIZE_BEGIN_FAILED" &&
        err.message !== "BYOC_SUGGESTION_UNAVAILABLE"
          ? err.message
          : null;
      if (!ownerCurrent()) return;
      setError(
        serverReason ??
          "We could not start cloud setup. Your existing setup is unchanged; try again in a moment.",
      );
    } finally {
      authorizationStarting.current = false;
      setSaving(false);
    }
  }, [ownerCurrent, ownCloudAvailable]);

  // Azure's one-click setup: the Microsoft sign-in (in a popup), then the return
  // route. A retry names the failed job's subscription, which goes straight to its directory.
  const startAzureSetup = useCallback(
    (subscriptionId?: string | null) => {
      if (!ownerCurrent() || !ownCloudAvailable) return Promise.resolve();
      setError(null);
      const filesEnabled = job && azureSubscriptionFromRef(job.projectId)
        ? job.stages.some((entry) => entry.stage === "files_selection" && entry.enabled === true)
        : true;
      return startAzureSignIn("setup", subscriptionId ?? undefined, filesEnabled);
    },
    [startAzureSignIn, job, ownerCurrent, ownCloudAvailable],
  );

  const chooseHosted = useCallback(async () => {
    if (!ownerCurrent()) return;
    setError(null);
    setHostedSaving(true);
    try {
      if (
        isPooledSandboxSwitchAvailable() &&
        typeof ApiService.adoptPooledSandbox === "function"
      ) {
        const adopted = await ApiService.adoptPooledSandbox({
          allowCleanSlate: true,
          isEffectCurrent: ownerCurrent,
        });
        if (!ownerCurrent()) return;
        if (typeof ApiService.reconnectOwnerPod === "function") {
          await ApiService.reconnectOwnerPod().catch(() => undefined);
        }
        setHostingMode("hussh_pods");
        setAgentState("active");
        setAgentTarget(adopted.deploymentTarget || "ace");
        if (ownerId) {
          await PreVaultUserStateService.bootstrapState(ownerId, {
            force: true,
          }).catch(() => undefined);
        }
        return;
      }
      const result = await ApiService.selectHostedCloud();
      if (!ownerCurrent()) return;
      setHosted(result);
      if (ownerId) {
        // The server just wrote the durable `cloud` marker; refresh the shared
        // bootstrap so the hub and every other surface flip to the truth
        // without a reload — the same refresh the BYOC path does on its proof.
        await PreVaultUserStateService.bootstrapState(ownerId, {
          force: true,
        }).catch(() => undefined);
      }
    } catch (err) {
      // The server's reason verbatim. "Verify your phone number first" is a
      // normal step of this journey, and replacing it with a generic apology
      // strands the person with no next move.
      const reason =
        err instanceof Error &&
        err.message &&
        err.message !== "HOSTED_SELECT_FAILED"
          ? err.message
          : null;
      setError(
        reason ?? "We could not set that up just now. Try again in a moment.",
      );
    } finally {
      setHostedSaving(false);
    }
  }, [ownerCurrent, ownerId]);

  const chooseShared = useCallback(async () => {
    if (!ownerCurrent()) return;
    setError(null);
    setSharedSaving(true);
    try {
      const result = await ApiService.selectSharedHosting();
      if (!ownerCurrent()) return;
      setHostingMode(result.hostingMode);
      setSharedChosen(true);
      setJob(null); // a begun setup's intent is cleared by the choice
      if (ownerId) {
        await PreVaultUserStateService.bootstrapState(ownerId, {
          force: true,
        }).catch(() => undefined);
      }
    } catch {
      setError(
        "We could not switch you to Hussh Shared. Your existing setup is unchanged; refresh and try again.",
      );
    } finally {
      setSharedSaving(false);
    }
  }, [ownerCurrent, ownerId]);

  // A durable connected project or a selected hosting mode completes this step.
  const byocAssignedConnecting =
    hostingMode === "byoc" &&
    reservedProjectId === null &&
    (agentState === "connecting" || agentState === "provisioning");
  const byocAssignedFailed =
    hostingMode === "byoc" &&
    reservedProjectId === null &&
    agentState === "failed";
  const connectedBefore = existing !== null && reservedProjectId === null;
  const hostedChosen = hosted !== null;
  const recordedReservedProject = Boolean(
    reservedProjectId && setupStatusReadOk && job?.status === "recorded" &&
      job.projectId === reservedProjectId,
  );
  const pooledSwitchAvailable = isPooledSandboxSwitchAvailable();
  // Shared is the confirmed default when the server says so or this session chose it (outside cutover lanes).
  const sharedConfirmed =
    !pooledSwitchAvailable && (hostingMode === "shared" || sharedChosen);
  const selectedHosting: HostingChoice | null =
    choice ?? (sharedConfirmed ? "shared" : null);
  const selectedSandboxHosting: HostingChoice = choice === "own" ? "own" : "hosted";
  const authorized =
    connectedBefore ||
    recordedReservedProject ||
    hostedChosen ||
    (!pooledSwitchAvailable && sharedChosen && selectedHosting === "shared" && hostingMode === "shared" && job === null) ||
    (hostingMode === "hussh_pods" && !(pooledSwitchAvailable && choice === "own"));
  const hostingSaving = saving || sharedSaving || hostedSaving || azureSignIn.starting || finalizingSetup;
  // One alert, whichever cloud's authorization refused.
  const shownError = error ?? azureSignIn.error;
  // Azure is named only on a build where it can actually be chosen.
  const azureSelectable = isAzureHomeSelectable();
  const hostingOptions = hostingOptionsFor({ azureSelectable, hostedUnderMaintenance, ownCloudAvailable });
  const consentIntent = consentPendingEntry(job);
  const attachBlocked = (job as { attachBlocked?: string | null } | null)?.attachBlocked ?? null;
  const ownerCloudSourceLabel =
    ownerProvider === "azure"
      ? "Microsoft Azure"
      : ownerProvider === "gcp"
        ? "Google Cloud"
        : null;
  const hostedPodSourceLabel =
    hostedPodProvider(agentTarget) === "azure"
      ? "Microsoft Azure"
      : hostedPodProvider(agentTarget) === "gcp"
        ? "Google Cloud"
        : null;
  const openHomeFallback =
    pooledSwitchAvailable && !aiReady ? (
      <div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          data-testid="byoc-open-home-fallback"
          onClick={() => {
            const requested = requestInternalAppNavigation({
              href: ROUTES.ONE_HOME,
              replace: true,
              scroll: false,
              source: "programmatic",
              transitionMode: "full",
            });
            if (!requested) router.replace(ROUTES.ONE_HOME);
          }}
        >
          Open Home
        </Button>
      </div>
    ) : null;
  // The one commit under the cards. Shared keeps its two ids: the confirm on a
  // confirmed Shared state, and the plain pick where Shared is not yet the default.
  const hostingCommit =
    selectedHosting === "shared" && !pooledSwitchAvailable
      ? {
          label: sharedChosen
            ? "Hussh Shared selected"
            : sharedSaving
              ? "Saving…"
              : "Continue with Hussh Shared",
          onClick: () => void chooseShared(),
          disabled: sharedSaving || sharedChosen,
          testId: sharedConfirmed ? "cloud-tier-shared-continue" : "cloud-tier-shared",
        }
      : selectedHosting === "hosted" && !hostedUnderMaintenance
        ? {
            label: hostedSaving
              ? "Setting that up…"
              : pooledSwitchAvailable
                ? "Start Hussh Confidential Sandbox"
                : "Set up Hussh Pods",
            onClick: () => void chooseHosted(),
            disabled: hostedSaving,
            testId: "cloud-tier-hosted-continue",
          }
        : null;

  // Guard mid-provisioning / mid-save transitions so accidental Back taps or
  // edge swipes cannot strand the owner before hosting placement commits.
  useBackLayer(ROUTES.ONE_SETUP_CLOUD, saving || hostingSaving ? 2 : 0, () => true);

  const rawReturnToParam = searchParams.get("return_to");
  const isProfilePaneHostingReturn =
    typeof rawReturnToParam === "string" &&
    rawReturnToParam.startsWith("/") &&
    !rawReturnToParam.startsWith("//") &&
    rawReturnToParam.includes("profile_panel=hosting");
  const resolvedReturnTo = resolveOneSetupReturnTo(rawReturnToParam);
  const isAlreadyCompletedSetup =
    Boolean(ownerId) &&
    (OneSetupCompletionHintService.isResolved(ownerId!) ||
      PreVaultUserStateService.getCachedBootstrapState(ownerId!)?.setupCompleted === true);
  const isSettingsHostingVisit =
    isProfilePaneHostingReturn ||
    resolvedReturnTo === ROUTES.PROFILE_HOSTING ||
    (!resolvedReturnTo && isAlreadyCompletedSetup);
  const resolveDirectOnboardingHref = useCallback(() => {
    if (ownerId && PreVaultSensitiveDraftService.hasFinanceIntent(ownerId)) {
      return buildOneSetupFinanceImportRoute(resolvedReturnTo);
    }
    if (resolvedReturnTo) {
      const pathOnly = resolvedReturnTo.split(/[?#]/)[0] ?? resolvedReturnTo;
      if (!isOneSetupSurfaceRoute(pathOnly)) {
        return resolvedReturnTo;
      }
    }
    return ROUTES.HOME;
  }, [ownerId, resolvedReturnTo]);

  const completeDirectOnboarding = useCallback(async (): Promise<string | null> => {
    if (!ownerId || !ownerCurrent()) return null;
    if (!vaultKey || !vaultOwnerToken) {
      throw new Error("Not ready yet. Try again.");
    }
    if (finalizationInFlightRef.current) {
      return finalizationInFlightRef.current;
    }
    const run = (async () => {
      setError(null);
      await PreVaultSensitiveDraftService.finalizeForVault({
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
      });
      const bootstrap =
        PreVaultUserStateService.getCachedBootstrapState(ownerId) ??
        (await PreVaultUserStateService.bootstrapState(ownerId, { force: true }));
      if (
        bootstrap?.oneRuntimeSetupChoice === "byok_pending_vault" &&
        !(await hasStoredAiKey(ownerId, vaultKey, vaultOwnerToken))
      ) {
        throw new Error("Your selected AI key was not saved. Choose your AI again.");
      }
      await PostUnlockSyncService.run({
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
      });
      await FinanceSetupDraftService.finalizeForVault({
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
      });
      notifyGeminiRuntimeConfigurationChanged(ownerId);
      const completion = acknowledgeOneSetupExit({
        userId: ownerId,
        skipped: false,
        isVaultUnlocked: true,
        vaultKey,
        vaultOwnerToken,
      });
      queueEntryWelcome(ownerId);
      await completion;
      setVaultDialogOpen(false);
      setPendingDirectVaultFinish(false);
      const targetHref = resolveDirectOnboardingHref();
      const requested = requestInternalAppNavigation({
        href: targetHref,
        replace: true,
        scroll: false,
        source: "programmatic",
        transitionMode: "full",
      });
      if (!requested) router.replace(targetHref);
      return targetHref;
    })();
    finalizationInFlightRef.current = run;
    setFinalizingSetup(true);
    try {
      return await run;
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not save your setup. Try again.",
      );
      throw err;
    } finally {
      if (finalizationInFlightRef.current === run) {
        finalizationInFlightRef.current = null;
      }
      setFinalizingSetup(false);
    }
  }, [
    ownerCurrent,
    ownerId,
    queueEntryWelcome,
    resolveDirectOnboardingHref,
    router,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (
      !pendingDirectVaultFinish ||
      !isVaultUnlocked ||
      !vaultKey ||
      !vaultOwnerToken ||
      !ownerId ||
      finalizationInFlightRef.current
    ) {
      return;
    }
    void completeDirectOnboarding().catch(() => undefined);
  }, [
    completeDirectOnboarding,
    isVaultUnlocked,
    ownerId,
    pendingDirectVaultFinish,
    vaultKey,
    vaultOwnerToken,
  ]);

  const finish = useCallback(async () => {
    if (!ownerCurrent() || !authorized || !aiReady || hostingSaving) {
      return { status: "blocked" as const, summary: "Finish your hosting and AI selection first." };
    }
    if (
      ownerId &&
      typeof PreVaultUserStateService.markOneRuntimeChoice === "function" &&
      !PreVaultUserStateService.hasOneRuntimeChoice(
        PreVaultUserStateService.getCachedBootstrapState(ownerId),
      )
    ) {
      await PreVaultUserStateService.markOneRuntimeChoice(
        ownerId,
        "hushh_managed_vertex",
      ).catch(() => undefined);
      if (!ownerCurrent()) {
        return { status: "blocked" as const, summary: "Session changed." };
      }
    }
    if (pooledSwitchAvailable && !isSettingsHostingVisit) {
      if (vaultContext !== null) {
        if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
          setPendingDirectVaultFinish(true);
          setVaultDialogOpen(true);
          return {
            status: "started" as const,
            summary: "One step left: set a lock.",
          };
        }
        try {
          const targetHref = await completeDirectOnboarding();
          if (!targetHref) {
            return { status: "blocked" as const, summary: "Session changed." };
          }
          return {
            status: "started" as const,
            summary: "Setup complete. Continuing.",
            routeAfter: targetHref,
          };
        } catch {
          return {
            status: "blocked" as const,
            summary: "Could not save your setup. Try again.",
          };
        }
      }
      const fallbackHref = resolveDirectOnboardingHref();
      const requestedDirect = requestInternalAppNavigation({
        href: fallbackHref,
        replace: true,
        scroll: false,
        source: "programmatic",
        transitionMode: "full",
      });
      if (!requestedDirect) router.replace(fallbackHref);
      return { status: "started" as const, summary: "Setup complete. Continuing.", routeAfter: fallbackHref };
    }
    const href = isProfilePaneHostingReturn
      ? rawReturnToParam!
      : resolvedReturnTo === ROUTES.PROFILE_HOSTING || (!resolvedReturnTo && isAlreadyCompletedSetup)
        ? ROUTES.PROFILE_HOSTING
        : buildOneSetupRoute({ returnTo: resolvedReturnTo });
    const requested = requestInternalAppNavigation({
      href,
      replace: true,
      scroll: false,
      source: "programmatic",
      transitionMode: "full",
    });
    if (!requested) router.replace(href);
    return { status: "started" as const, summary: "Your agent setup is saved.", routeAfter: href };
  }, [
    aiReady,
    authorized,
    completeDirectOnboarding,
    hostingSaving,
    isAlreadyCompletedSetup,
    isProfilePaneHostingReturn,
    isSettingsHostingVisit,
    isVaultUnlocked,
    ownerCurrent,
    ownerId,
    pooledSwitchAvailable,
    rawReturnToParam,
    resolveDirectOnboardingHref,
    resolvedReturnTo,
    router,
    vaultContext,
    vaultKey,
    vaultOwnerToken,
  ]);
  useLocalOnboardingActionHandler("setup.finish_cloud", finish);

  return (
    <AppPageShell
      as="main"
      width="reading"
      nativeTest={{
        routeId: "/one/setup/cloud",
        marker: "native-route-one-setup-cloud",
        authState: "authenticated",
        dataState: saving ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Where your agent lives"
          description="Choose where Agent One runs. Your existing setup stays in place."
          accent="neutral"
        />
        {checkTimedOut && !authorized ? (
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            data-testid="byoc-cloud-check-timed-out"
            aria-live="polite"
          >
            We couldn&rsquo;t confirm your agent home. Your existing setup is unchanged;
            refresh to check before choosing a hosting option.
          </p>
        ) : null}
      </AppPageHeaderRegion>
      <AppPageContentRegion className="space-y-6">
        {hostingStatusChecked && !ownCloudAvailable && hostingMode !== "unknown" ? (
          <p role="status" className="text-sm text-[var(--app-text-secondary)]" data-testid="byoc-setup-unavailable">
            Cloud setup is unavailable in this environment. Your existing setup is unchanged.
            {!pooledSwitchAvailable && (hostingMode === "shared" || hostingMode === "unplaced")
              ? " You can continue with Hussh Shared."
              : " Your saved progress is kept."}
          </p>
        ) : null}
        {reservedProjectId && job && job.projectId !== reservedProjectId ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-reserved-project-mismatch"
            role="alert"
          >
            <p className="text-sm font-semibold">Your cloud setup needs a fresh check</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              The saved project and setup record do not match. Refresh before continuing.
            </p>
            <button
              type="button"
              className="min-h-11 self-start text-sm underline underline-offset-4"
              onClick={() => window.location.reload()}
            >
              Refresh status
            </button>
          </div>
        ) : job && job.status === "running" && !job.stale ? (
          // The live checklist owns the screen while the job runs. Nothing
          // else competes with it: no form, no dead buttons, no guessing.
          <SetupStageChecklist {...setupChecklistFor(job, ownerProvider)} job={job} />
        ) : job && (job.status === "failed" || job.stale) && !authorized ? (
          <div className="space-y-4">
            <ByocSetupFailedCard
              job={job}
              retry={setupRetryFor(job, ownerProvider)}
              busy={!ownCloudAvailable || saving || azureSignIn.starting}
              onRetry={(retry) =>
                void (retry.provider === "azure"
                  ? startAzureSetup(azureSubscriptionFromRef(job.projectId))
                  : handleProjectNamed(retry.projectId))
              }
            />
            {pooledSwitchAvailable ? (
              <PooledSandboxSwitchCard
                hasAssignedCloudPod={false}
                sourceCloudLabel={
                  setupJobProvider(job) === "azure"
                    ? "Microsoft Azure"
                    : setupJobProvider(job) === "gcp"
                      ? "Google Cloud"
                      : null
                }
                onSwitched={refreshAttach}
                owningRoute={ROUTES.ONE_SETUP_CLOUD}
              />
            ) : null}
            {openHomeFallback}
          </div>
        ) : consentIntent && !authorized ? (
          <ConsentPendingCard
            entry={consentIntent}
            busy={saving || azureSignIn.starting || sharedSaving || hostedSaving}
            onContinue={!ownCloudAvailable ? null : consentIntent.provider === "azure" ? () => void startAzureSetup()
              : consentIntent.project ? () => void handleProjectNamed(consentIntent.project) : null}
            onChooseShared={pooledSwitchAvailable ? null : () => void chooseShared()}
            onChooseSandbox={pooledSwitchAvailable ? () => void chooseHosted() : null}
          />
        ) : (!checked || !hostingStatusChecked) && !checkTimedOut && !authorized ? (
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            data-testid="byoc-cloud-checking"
            aria-live="polite"
          >
            Checking your agent home…
          </p>
        ) : hostingMode === "byoc" && directBlocker ? (
          <div className="space-y-4">
            <DirectIngressBlockedCard
              blocker={directBlocker}
              onRetry={ownCloudAvailable ? () => {
                if (ownerCurrent()) void retryDirectIngress().finally(refreshAgent);
              } : null}
            />
            {pooledSwitchAvailable ? (
              <PooledSandboxSwitchCard
                hasAssignedCloudPod
                isOwnerCloud
                sourceCloudLabel={ownerCloudSourceLabel}
                onSwitched={refreshAttach}
                owningRoute={ROUTES.ONE_SETUP_CLOUD}
              />
            ) : null}
          </div>
        ) : byocAssignedConnecting ? (
          <div className="space-y-4">
            <ConnectingToAgentCard onRefresh={refreshAttach} />
            {pooledSwitchAvailable ? (
              <PooledSandboxSwitchCard
                hasAssignedCloudPod
                isOwnerCloud
                sourceCloudLabel={ownerCloudSourceLabel}
                onSwitched={refreshAttach}
                owningRoute={ROUTES.ONE_SETUP_CLOUD}
              />
            ) : null}
          </div>
        ) : byocAssignedFailed ? (
          <div className="space-y-4">
            <div
              className="space-y-3 rounded-2xl border border-[var(--app-border)] p-4"
              role="alert"
              data-testid="byoc-agent-failed"
            >
              <p className="text-sm font-semibold">We couldn&rsquo;t reach your agent</p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                {ownerProvider === "azure"
                  ? "Your agent in Microsoft Azure is paused or unreachable. Check the connection again or open Hosting settings to repair or move your agent."
                  : "Your agent in Google Cloud is paused or unreachable. Check the connection again or open Hosting settings to repair or move your agent."}
              </p>
              <div className="flex flex-wrap gap-4">
                <button
                  type="button"
                  className="min-h-11 self-start text-sm underline underline-offset-4"
                  onClick={refreshAttach}
                  data-testid="byoc-agent-failed-refresh"
                >
                  Check connection again
                </button>
                <button
                  type="button"
                  className="min-h-11 self-start text-sm underline underline-offset-4"
                  onClick={() => {
                    const rawReturnTo = searchParams.get("return_to");
                    const hostingHref =
                      typeof rawReturnTo === "string" &&
                      rawReturnTo.startsWith("/") &&
                      !rawReturnTo.startsWith("//") &&
                      rawReturnTo.includes("profile_panel=hosting")
                        ? rawReturnTo
                        : ROUTES.PROFILE_HOSTING;
                    const requested = requestInternalAppNavigation({
                      href: hostingHref,
                      replace: true,
                      scroll: false,
                      source: "programmatic",
                      transitionMode: "full",
                    });
                    if (!requested) router.replace(hostingHref);
                  }}
                  data-testid="byoc-agent-failed-hosting"
                >
                  Open Hosting settings
                </button>
              </div>
            </div>
            {pooledSwitchAvailable ? (
              <PooledSandboxSwitchCard
                hasAssignedCloudPod
                isOwnerCloud
                sourceCloudLabel={ownerCloudSourceLabel}
                onSwitched={refreshAttach}
                owningRoute={ROUTES.ONE_SETUP_CLOUD}
              />
            ) : null}
            {openHomeFallback}
          </div>
        ) : connectedBefore ? (
          // Revisit: the cloud is recorded and proven; first-time setup cannot move an assigned pod.
          <div className="space-y-4">
            <div
              className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
              data-testid="byoc-cloud-connected"
            >
              <p className="text-sm font-semibold">
                Connected: {existing.projectId}
              </p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                {existing.rationale || "Agent One remains assigned to this project."}
              </p>
              <AzureFreeTrialNote stages={job?.stages} />
            </div>
            {pooledSwitchAvailable ? (
              <PooledSandboxSwitchCard
                hasAssignedCloudPod
                isOwnerCloud
                sourceCloudLabel={existing.projectId}
                onSwitched={refreshAgent}
                owningRoute={ROUTES.ONE_SETUP_CLOUD}
              />
            ) : isHostedAzureMigrationAvailable() && agentState === "active" ? (
              <HusshPodsMigrationCard
                sourceMode="byoc"
                sourceTarget={agentTarget}
                sourceProject={existing.projectId}
                onMigrated={refreshAgent}
                owningRoute={ROUTES.ONE_SETUP_CLOUD}
                subtleAction
              />
            ) : null}
            {openHomeFallback}
          </div>
        ) : recordedReservedProject ? (
          // The recorded home attaches by itself; a stop is shown with its typed reason.
          attachBlocked ? (
            <div className="space-y-4">
              <AttachBlockedCard code={attachBlocked}
                onRetry={ownCloudAvailable ? () => {
                  if (ownerCurrent()) void retryOwnerCloudAttach().finally(refreshAttach);
                } : null} />
              {pooledSwitchAvailable ? (
                <PooledSandboxSwitchCard
                  hasAssignedCloudPod
                  isOwnerCloud
                  sourceCloudLabel={ownerCloudSourceLabel ?? reservedProjectId}
                  onSwitched={refreshAttach}
                  owningRoute={ROUTES.ONE_SETUP_CLOUD}
                />
              ) : null}
            </div>
          ) : (
            <ConnectingToAgentCard onRefresh={refreshAttach} />
          )
        ) : reservedProjectId && setupStatusReadOk && job === null ? (
          <div
            className="space-y-3 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-reserved-project"
          >
            <p className="text-sm font-semibold">Your cloud project is saved</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Finish setup in {reservedProjectId} to start Agent One.
            </p>
            <button
              type="button"
              disabled={!ownCloudAvailable || saving || azureSignIn.starting}
              className="min-h-11 rounded-full border border-[var(--app-border)] px-4 text-sm font-medium disabled:opacity-60"
              onClick={() =>
                void (ownerProvider === "azure"
                  ? startAzureSetup(azureSubscriptionFromRef(reservedProjectId))
                  : handleProjectNamed(reservedProjectId))
              }
              data-testid="byoc-reserved-project-deploy"
            >
              {saving ? "Starting…" : "Deploy to your cloud"}
            </button>
          </div>
        ) : reservedProjectId ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-reserved-project-unverified"
          >
            <p className="text-sm font-semibold">Your cloud setup could not be confirmed</p>
            <button
              type="button"
              className="min-h-11 self-start text-sm underline underline-offset-4"
              onClick={() => window.location.reload()}
            >
              Refresh status
            </button>
          </div>
        ) : hostingMode === "pending" && (agentState === "provisioning" || agentState === "connecting") ? (
          <ConnectingToAgentCard onRefresh={refreshAttach} />
        ) : hostingMode === "pending" ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="hosting-mode-pending"
            aria-live="polite"
          >
            <p className="text-sm font-semibold">Your pod setup is still in progress</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Keep the current setup. We will show the available choice after its status is confirmed.
            </p>
          </div>
        ) : hostingMode === "hussh_pods" ? (
          hostedUnderMaintenance ? (
            <HusshPodsPausedCard deploymentTarget={agentTarget} />
          ) : pooledSwitchAvailable ? (
            <div className="space-y-4" data-testid="cloud-tier-choice">
              <HostingChoiceCards
                label="Where your agent runs"
                options={hostingOptions}
                value={selectedSandboxHosting}
                onChange={setChoice}
                busy={saving || hostedSaving || azureSignIn.starting}
              />
              {selectedSandboxHosting === "own" ? (
                ownCloudAvailable ? (
                  <OwnerCloudProviderChoice
                    onProjectNamed={handleProjectNamed}
                    projectBusy={saving}
                    onConnectAzure={startAzureSetup}
                    azureBusy={azureSignIn.starting}
                  />
                ) : null
              ) : (
                <>
                  <HusshPodsActiveCard deploymentTarget={agentTarget} compactBelowPicker />
                  {agentTarget !== "ace" ? (
                    <PooledSandboxSwitchCard
                      hasAssignedCloudPod
                      sourceCloudLabel={hostedPodSourceLabel}
                      onSwitched={refreshAgent}
                      owningRoute={ROUTES.ONE_SETUP_CLOUD}
                    />
                  ) : null}
                  {openHomeFallback}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <HusshPodsActiveCard deploymentTarget={agentTarget} />
              {isHostedAzureMigrationAvailable() &&
              agentState === "active" &&
              hostedPodProvider(agentTarget) === "gcp" ? (
                <HusshPodsMigrationCard
                  sourceMode="hussh_pods"
                  sourceTarget={agentTarget}
                  onMigrated={refreshAgent}
                  owningRoute={ROUTES.ONE_SETUP_CLOUD}
                  subtleAction
                />
              ) : null}
              {openHomeFallback}
            </div>
          )
        ) : hostingMode === "unknown" || hostingMode === null ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="hosting-mode-unknown"
            aria-live="polite"
          >
            <p className="text-sm font-semibold">We couldn&rsquo;t confirm your agent home</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Your existing or in-progress setup is unchanged. Refresh to check its status before choosing a hosting option.
            </p>
            <button
              type="button"
              className="text-sm underline underline-offset-4"
              onClick={() => window.location.reload()}
              data-testid="hosting-mode-refresh"
            >
              Refresh status
            </button>
          </div>
        ) : hostedChosen ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="hosted-cloud-chosen"
          >
            <p className="text-sm font-semibold">Hosted by Hussh</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              {hosted.assurance}
            </p>
            <button
              type="button"
              className="text-sm underline underline-offset-4"
              onClick={() => {
                setHosted(null);
                setChoice("own");
              }}
              data-testid="hosted-cloud-switch"
            >
              Use my own cloud instead
            </button>
          </div>
        ) : (
          // Offer a hosting choice only when the server confirms no pod is
          // assigned or being provisioned. Existing and in-progress placements
          // render above and are never switched by this selection UI. Picking a
          // card only moves the selection; what that pick needs next appears
          // below it, so nothing is committed by a tap or an arrow key alone.
          <div
            className="space-y-4"
            data-testid={sharedConfirmed ? "shared-hosting-selected" : "cloud-tier-choice"}
          >
            <HostingChoiceCards
              label="Where your agent runs"
              options={hostingOptions}
              value={selectedHosting}
              onChange={setChoice}
              busy={sharedSaving || hostedSaving}
            />
            {selectedHosting === "own" && ownCloudAvailable ? (
              <OwnerCloudProviderChoice
                onProjectNamed={handleProjectNamed}
                projectBusy={saving}
                onConnectAzure={startAzureSetup}
                azureBusy={azureSignIn.starting}
              />
            ) : hostingCommit ? (
              <Button
                type="button"
                className="w-full"
                onClick={hostingCommit.onClick}
                disabled={hostingCommit.disabled}
                data-testid={hostingCommit.testId}
              >
                {hostingCommit.label}
              </Button>
            ) : null}
          </div>
        )}

        {saving ? (
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            data-testid="byoc-cloud-saving"
          >
            Checking whether we can reach that project…
          </p>
        ) : null}

        {shownError && !(job && job.status === "running" && !job.stale) ? (
          // A refusal must be impossible to miss and must name the next MOVE.
          // The plain one-line rendering read as body copy and the founder
          // scrolled past it (2026-08-21); this is the app's standing alert
          // shape (one-setup-hub's finalization alert), headline plus the
          // server's reason verbatim.
          <div
            role="alert"
            className="flex flex-col gap-1.5 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3"
            data-testid="byoc-cloud-error"
          >
            <p className="text-sm font-semibold text-destructive">
              Your cloud is not set up yet
            </p>
            <p className="text-sm text-destructive">{shownError}</p>
            {/phone/i.test(shownError) ? (
              <a
                className="self-start text-sm underline underline-offset-4 text-destructive"
                href={ROUTES.PHONE_MANDATE}
                data-testid="byoc-cloud-verify-phone"
              >
                Verify your phone number
              </a>
            ) : null}
          </div>
        ) : null}

        {azureSignIn.notice && !shownError && !(job && job.status === "running") ? (
          // Not a refusal: the person (or Microsoft's own page) closed the sign-in window.
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            role="status"
            data-testid="azure-sign-in-notice"
          >
            {azureSignIn.notice}
          </p>
        ) : null}

        {authorized ? (
          <GeminiRuntimeConfigurationPage
            key={ownerId}
            setupMode
            embeddedInCloudSetup
            onSetupReadyChange={setAiReady}
          />
        ) : null}
      </AppPageContentRegion>
      {authorized && aiReady ? <SetupCompletionFooter
        label={pooledSwitchAvailable && !isSettingsHostingVisit ? "Finish setup" : "Finish agent setup"}
        onComplete={() => void finish()}
        busy={hostingSaving}
        // The existing AI selector acknowledges only a saved, verified choice.
        // Keeping both prerequisites here avoids a second setup trip from the hub.
        disabled={!authorized || !aiReady || hostingSaving || !ownerCurrent()}
        controlId="one-setup-cloud-terminal"
        actionId="setup.finish_cloud"
        purpose="Keep the verified hosting and AI choice, then continue."
      /> : null}
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={(open) => {
            setVaultDialogOpen(open);
            if (!open && !finalizationInFlightRef.current) {
              setPendingDirectVaultFinish(false);
            }
          }}
          dismissible={false}
          enableGeneratedDefault
          title="Set a lock"
          description="Only you can open what you save. Not even we can read it."
          onSuccess={() => undefined}
        />
      ) : null}
    </AppPageShell>
  );
}
