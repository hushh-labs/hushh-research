"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { OnboardingShell } from "@/components/ria/onboarding/onboarding-shell";
import { OnboardingStepWelcome } from "@/components/ria/onboarding/onboarding-step-welcome";
import { OnboardingStepLicense } from "@/components/ria/onboarding/onboarding-step-license";
import { OnboardingStepLicenseDetails } from "@/components/ria/onboarding/onboarding-step-license-details";
import { OnboardingStepServices } from "@/components/ria/onboarding/onboarding-step-services";
import { OnboardingStepReview } from "@/components/ria/onboarding/onboarding-step-review";
import { useAuth } from "@/hooks/use-auth";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { normalizeInternalRouteHref, ROUTES } from "@/lib/navigation/routes";
import {
  buildRiaOnboardingSteps,
  canContinueRiaOnboardingStep,
  getRiaOnboardingStepIndex,
  isRiaOnboardingStepId,
  normalizeRiaOnboardingDraft,
  resolveRiaOnboardingStepId,
  type RiaOnboardingDraft,
  type RiaOnboardingFlowOptions,
  type RiaOnboardingStepId,
} from "@/lib/ria/ria-onboarding-flow";
import {
  buildRiaOnboardingBioSuggestion,
  buildRiaLicensePrefillPatch,
  buildRiaScrapePrefillPatch,
} from "@/lib/ria/ria-onboarding-prefill";
import { RiaOnboardingDraftLocalService } from "@/lib/services/ria-onboarding-draft-local-service";
import { RiaOnboardingStatusLocalService } from "@/lib/services/ria-onboarding-status-local-service";
import { seedRiaDraftFromStatus } from "@/lib/ria/ria-profile-view-model";
import {
  isIAMSchemaNotReadyError,
  RiaApiError,
  RiaService,
  type RiaLicenseVerificationResult,
  type RiaOnboardingStatus,
} from "@/lib/services/ria-service";
import {
  buildRiaClaimRoute,
  isClaimableLookupOutcome,
  toNanpDigits,
} from "@/lib/ria/ria-claim-entry";
import { usePersonaState } from "@/lib/persona/persona-context";
import { trackEvent } from "@/lib/observability/client";
import { trackGrowthFunnelStepCompleted } from "@/lib/observability/growth";
import { resolveAppEnvironment } from "@/lib/app-env";
import { openKaiCommandBar } from "@/lib/navigation/kai-command-bar-events";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

const LICENSE_VERIFICATION_TIMEOUT_MS = 90_000;
const SCRAPE_POLL_INTERVAL_MS = 5_000;
const RIA_ENVIRONMENT_BYPASS_STATUS = "Environment bypass";

// Decorative advisor photo per onboarding step (transparent, feather-edged
// WebP under public/ria/onboarding). Every step uses the same top-right accent
// composition so the opening choice has the same compact, side-by-side header
// geometry as the rest of the RIA setup flow.
const RIA_ONBOARDING_STEP_IMAGES: Record<
  string,
  { src: string; variant: "hero" | "accent"; badge?: boolean }
> = {
  welcome: { src: "/ria/onboarding/adv4f.webp", variant: "accent" },
  license_number: { src: "/ria/onboarding/adv2f.webp", variant: "accent" },
  license_details: {
    src: "/ria/onboarding/adv3f.webp",
    variant: "accent",
    badge: true,
  },
  services: { src: "/ria/onboarding/adv1f.webp", variant: "accent" },
  review: { src: "/ria/onboarding/adv5f.webp", variant: "accent" },
};

function RiaOnboardingJourney({
  showIntro,
  children,
}: {
  showIntro: boolean;
  children: ReactNode;
}) {
  if (!showIntro) return <>{children}</>;

  return (
    <CapabilityCinematicIntroGate capabilityId="ria" embedded>
      {children}
    </CapabilityCinematicIntroGate>
  );
}

const REGULATOR_PREFILL_RESET: Partial<RiaOnboardingDraft> = {
  advisorName: "",
  firmName: "",
  regulatorStatus: "",
  licenseExpiry: "",
  certifications: [],
  city: "",
  pinZip: "",
  crdNumber: "",
  secNumber: "",
  areaLocality: "",
  fullStreetAddress: "",
  latitude: null,
  longitude: null,
  bio: "",
  scrapeJobId: null,
  displayName: "",
  individualLegalName: "",
  individualCrd: "",
  advisoryFirmName: "",
  advisoryFirmIapdNumber: "",
  brokerFirmName: "",
  brokerFirmCrd: "",
  headline: "",
  strategySummary: "",
  verifiedLicensePrefillKey: "",
};

function isEnvironmentRiaVerificationBypassEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  return resolveAppEnvironment() !== "production";
}

function isRiaVerificationBypassedDraft(draft: RiaOnboardingDraft): boolean {
  return draft.regulatorStatus === RIA_ENVIRONMENT_BYPASS_STATUS;
}

function resolveRiaSubmitErrorMessage(
  error: unknown,
  options: { localVerificationBypassEnabled: boolean },
): string {
  const message =
    error instanceof Error ? error.message : "Failed to submit onboarding.";
  if (/ria intelligence verification provider unavailable/i.test(message)) {
    return options.localVerificationBypassEnabled
      ? "Live RIA verification is unavailable. For UAT or fake-license testing, go back to the licence step and use Bypass for dev/UAT."
      : "Live RIA verification is unavailable. Please try again later with a regulator-backed CRD or licence.";
  }
  if (/verification provider unavailable/i.test(message)) {
    return options.localVerificationBypassEnabled
      ? "Live verification is unavailable. For UAT testing, go back to the licence step and use Bypass for dev/UAT."
      : "Live verification is unavailable. Please try again later.";
  }
  return message;
}

function isAdvisoryAccessReady(status?: string | null): boolean {
  return status === "active" || status === "verified";
}

function shouldRepairVerifiedPrefill(draft: RiaOnboardingDraft): boolean {
  if (draft.licenseVerificationStatus !== "found") return false;
  if (!draft.licenseNumber.trim() || !draft.advisorName.trim()) return false;
  return draft.verifiedLicensePrefillKey !== buildVerifiedPrefillKey(draft);
}

function buildVerifiedPrefillKey(
  draft: Pick<RiaOnboardingDraft, "regulator" | "licenseNumber">,
): string {
  const regulator = draft.regulator.trim().toLowerCase() || "auto";
  return `${regulator}:${draft.licenseNumber.trim()}`;
}

function buildVerifiedLicensePrefillPatch(
  current: RiaOnboardingDraft,
  result: RiaLicenseVerificationResult,
  licenseNumber: string,
): Partial<RiaOnboardingDraft> {
  const patch = buildRiaLicensePrefillPatch(current, result, licenseNumber);
  return {
    ...patch,
    verifiedLicensePrefillKey:
      result.status === "found"
        ? buildVerifiedPrefillKey({
            regulator: patch.regulator || current.regulator,
            licenseNumber,
          })
        : current.verifiedLicensePrefillKey,
  };
}

export default function RiaOnboardingPage({
  setupMode = false,
  onSetupReadinessChange,
  onSetupSkip,
}: {
  setupMode?: boolean;
  onSetupReadinessChange?: (ready: boolean) => void;
  onSetupSkip?: () => void | Promise<void>;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, phoneNumber } = useAuth();
  const {
    refresh: refreshPersonaState,
    riaCapability,
    riaOnboardingStatus: personaRiaOnboardingStatus,
    loading: personaLoading,
    refreshing: personaRefreshing,
  } = usePersonaState();

  // The RIA profile deep-links here for two intents, both of which must bypass
  // the "established advisor → /ria/profile" guard below:
  //   ?edit=license   → re-run licence verification (start at the licence step)
  //   ?reinitiate=1   → re-run the whole 5-step wizard (start at welcome)
  // A generic ?step= is also honoured.
  const editParam = searchParams?.get("edit") ?? null;
  const setupOrigin =
    setupMode ||
    normalizeInternalRouteHref(searchParams?.get("from")) === ROUTES.ONE_SETUP;
  const stepParam = searchParams?.get("step") ?? null;
  const reinitiateIntent = (searchParams?.get("reinitiate") ?? null) === "1";
  const requestedStepId: RiaOnboardingStepId | null =
    editParam === "license"
      ? "license_number"
      : reinitiateIntent
        ? "welcome"
        : isRiaOnboardingStepId(stepParam)
          ? stepParam
          : null;
  const hasEditIntent = requestedStepId !== null;

  const [status, setStatus] = useState<RiaOnboardingStatus | null>(null);
  const [draft, setDraft] = useState<RiaOnboardingDraft>(
    normalizeRiaOnboardingDraft(undefined),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iamUnavailable, setIamUnavailable] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [shouldPersistDraft, setShouldPersistDraft] = useState(false);
  const [localVerificationBypassEnabled, setLocalVerificationBypassEnabled] =
    useState(false);
  // Bumped each time the user taps Continue on the services step while a
  // required field (services / fees) is empty. The services step reacts by
  // scrolling to the first missing field and surfacing an inline hint.
  const [servicesValidateTick, setServicesValidateTick] = useState(0);

  // Entry-mode gate — decide onboarding-vs-profile from synchronously-available
  // signals BEFORE painting the wizard, so an established advisor never sees the
  // "2/5" onboarding flash. Latches once decided, so a fresh advisor whose
  // capability flips to "switch" after submitting is NOT yanked out mid-review.
  //   "wizard"      → render the onboarding wizard (fresh setup / edit / setup hub)
  //   "established" → redirect to the regulatory profile (skeleton meanwhile)
  //   null          → undecided (cold cache, persona still loading) → skeleton
  const [entryMode, setEntryMode] = useState<"wizard" | "established" | null>(
    () => {
      if (hasEditIntent || setupMode || setupOrigin) return "wizard";
      if (
        riaCapability === "switch" ||
        personaRiaOnboardingStatus?.exists === true
      ) {
        return "established";
      }
      return null;
    },
  );

  const verificationAbortRef = useRef<AbortController | null>(null);
  const scrapePollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stalePrefillRepairRef = useRef<{
    inFlight: boolean;
    lastKey: string | null;
  }>({ inFlight: false, lastKey: null });
  const submitInFlightRef = useRef(false);
  // Guards the one-time entry redirect for already-established advisors so a
  // fresh advisor who completes onboarding in-session is not hijacked mid-flow.
  const onboardingEntryHandledRef = useRef(false);
  // Mirror the current edit-intent step for use inside the mount-only loader.
  const requestedStepIdRef = useRef<RiaOnboardingStepId | null>(
    requestedStepId,
  );
  requestedStepIdRef.current = requestedStepId;
  // Mirror the reinitiate intent for use inside the mount-only loader.
  const reinitiateIntentRef = useRef(reinitiateIntent);
  reinitiateIntentRef.current = reinitiateIntent;

  const advisoryVerificationStatus =
    status?.advisory_status || status?.verification_status || "draft";
  const advisoryAccessReady = isAdvisoryAccessReady(advisoryVerificationStatus);

  const licenseVerificationSatisfied =
    draft.licenseVerificationStatus === "found" &&
    draft.licenseNumber.trim().length > 0 &&
    draft.advisorName.trim().length > 0;

  const flowOptions = useMemo<RiaOnboardingFlowOptions>(
    () => ({ licenseVerificationSatisfied }),
    [licenseVerificationSatisfied],
  );

  useEffect(() => {
    setLocalVerificationBypassEnabled(
      isEnvironmentRiaVerificationBypassEnabled(),
    );
  }, []);

  const steps = useMemo(
    () => buildRiaOnboardingSteps(draft, flowOptions),
    [draft, flowOptions],
  );
  const currentStepIndex = useMemo(
    () => getRiaOnboardingStepIndex(draft, draft.currentStepId, flowOptions),
    [draft, flowOptions],
  );
  const currentStep = (steps[currentStepIndex] ?? steps[0])!;
  const canContinue = canContinueRiaOnboardingStep(
    currentStep.id,
    draft,
    flowOptions,
  );

  useEffect(() => {
    let cancelled = false;

    async function loadState() {
      if (!user) {
        if (!cancelled) {
          setLoading(false);
          setDraftReady(true);
        }
        return;
      }

      setLoading(true);
      setError(null);
      setIamUnavailable(false);

      try {
        const idToken = await user.getIdToken();
        const localDraft = await RiaOnboardingDraftLocalService.load(user.uid);
        const nextStatus = await RiaService.getOnboardingStatus(idToken, {
          userId: user.uid,
        });

        if (cancelled) return;

        const seeded = normalizeRiaOnboardingDraft({
          ...localDraft,
          contactEmail: localDraft?.contactEmail?.trim() || user.email || "",
          contactPhone:
            localDraft?.contactPhone?.trim() ||
            phoneNumber ||
            user.phoneNumber ||
            "",
        });

        const alreadyVerified =
          isAdvisoryAccessReady(
            nextStatus?.advisory_status || nextStatus?.verification_status,
          ) && Boolean(nextStatus?.individual_crd || nextStatus?.finra_crd);

        let resolvedDraft = seeded;
        if (alreadyVerified && nextStatus) {
          resolvedDraft = normalizeRiaOnboardingDraft({
            ...seeded,
            advisorName:
              seeded.advisorName ||
              nextStatus.display_name ||
              nextStatus.individual_legal_name ||
              "",
            crdNumber:
              seeded.crdNumber ||
              nextStatus.individual_crd ||
              nextStatus.finra_crd ||
              "",
            firmName:
              seeded.firmName || nextStatus.advisory_firm_legal_name || "",
            licenseVerificationStatus: "found",
          });
        }

        // Re-initiate: seed the wizard from the FULL server profile (services,
        // fees, bio, location, licence-found) so a redo starts prefilled rather
        // than blank (the local draft was cleared on the prior submit). Keeps the
        // contact overlay.
        if (reinitiateIntentRef.current && nextStatus) {
          resolvedDraft = normalizeRiaOnboardingDraft({
            ...seedRiaDraftFromStatus(nextStatus),
            contactEmail: seeded.contactEmail,
            contactPhone: seeded.contactPhone,
          });
        }

        // Opening RIA setup always lands on step 1. The saved draft still
        // prefills every field, but its step pointer is deliberately ignored so
        // entering the flow never drops the user mid-wizard (and never skips the
        // welcome step's cinematic intro). Only an explicit
        // ?edit=license / ?step= / ?reinitiate deep-link may land elsewhere.
        const preferredStepId = requestedStepIdRef.current;
        const currentStepId = preferredStepId
          ? resolveRiaOnboardingStepId(resolvedDraft, preferredStepId, {
              licenseVerificationSatisfied:
                alreadyVerified ||
                resolvedDraft.licenseVerificationStatus === "found",
            })
          : "welcome";

        setStatus(nextStatus);
        setDraft({ ...resolvedDraft, currentStepId });
        setShouldPersistDraft(true);
        if (setupMode && nextStatus?.exists === true) {
          const effectiveStatus = String(
            nextStatus.advisory_status ||
              nextStatus.verification_status ||
              "pending",
          ).toLowerCase();
          onSetupReadinessChange?.(effectiveStatus !== "rejected");
        }
      } catch (loadError) {
        if (!cancelled) {
          if (isIAMSchemaNotReadyError(loadError)) {
            setIamUnavailable(true);
          } else {
            setError(
              loadError instanceof Error
                ? loadError.message
                : "Failed to load RIA onboarding.",
            );
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setDraftReady(true);
        }
      }
    }

    void loadState();
    return () => {
      cancelled = true;
    };
  }, [onSetupReadinessChange, phoneNumber, setupMode, user]);

  // Already-established advisors (riaCapability "switch" = RIA persona provisioned
  // / profile built) don't belong in the onboarding wizard — route them to their
  // RIA profile to view/edit. Captured once on entry so a fresh advisor who
  // finishes onboarding in-session (capability flips to "switch" after submit) is
  // not hijacked out of the review step. Skipped for an explicit edit intent
  // (e.g. re-verifying a licence from the profile).
  // Resolve the entry mode once (cold-cache path): if the synchronous lazy-init
  // couldn't decide, wait for persona to settle, then latch. Force flows
  // (edit / reinitiate / setup) always resolve to the wizard.
  useEffect(() => {
    if (entryMode !== null) return;
    if (hasEditIntent || setupMode || setupOrigin) {
      setEntryMode("wizard");
      return;
    }
    if (
      riaCapability === "switch" ||
      personaRiaOnboardingStatus?.exists === true
    ) {
      setEntryMode("established");
      return;
    }
    if (!personaLoading && !personaRefreshing) {
      setEntryMode("wizard");
      return;
    }
    // Persona still resolving (cold start). Consult the native persistent hint
    // so an established advisor is redirected without waiting for the network.
    // Only a positive "exists" acts (never forces the wizard); if the hint is
    // cross-device stale the profile page's own guard self-corrects.
    if (user?.uid) {
      let active = true;
      void RiaOnboardingStatusLocalService.load(user.uid).then((hint) => {
        if (active && hint?.exists === true) {
          setEntryMode("established");
        }
      });
      return () => {
        active = false;
      };
    }
    return undefined;
  }, [
    entryMode,
    hasEditIntent,
    setupMode,
    setupOrigin,
    riaCapability,
    personaRiaOnboardingStatus,
    personaLoading,
    personaRefreshing,
    user,
  ]);

  // Established advisors don't belong in the wizard — send them to their RIA
  // regulatory profile. Fires once; the skeleton renders meanwhile so the
  // onboarding chrome never paints.
  useEffect(() => {
    if (entryMode !== "established") return;
    if (onboardingEntryHandledRef.current) return;
    onboardingEntryHandledRef.current = true;
    router.replace(ROUTES.RIA_PROFILE);
  }, [entryMode, router]);

  // Recognise before asking. An adviser opening RIA setup has usually already
  // given us the number the SEC lists them at, so check it before showing a
  // blank wizard. Fails open: any miss, error or timeout leaves the wizard
  // exactly as it was.
  const claimProbeRef = useRef(false);
  useEffect(() => {
    if (entryMode !== "wizard" || claimProbeRef.current || !user) return;
    // The account's verified number lives on the auth context; the Firebase
    // user object is null here for anyone who signed in with Google and for
    // native sessions that rehydrate before the phone hydrates.
    const phone = toNanpDigits(phoneNumber || user.phoneNumber);
    if (!phone) return;
    claimProbeRef.current = true;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        const lookup = await RiaService.claimLookup(
          idToken,
          { phone },
          { signal: controller.signal },
        ).finally(() => clearTimeout(timer));
        if (isClaimableLookupOutcome(lookup)) {
          router.replace(buildRiaClaimRoute(phone));
        }
      } catch {
        /* stay in the wizard */
      }
    })();
    // phoneNumber is in the deps so the probe re-runs once the backend phone
    // hydrates, which happens after the first render for a Google sign-in.
  }, [entryMode, user, phoneNumber, router]);

  useEffect(() => {
    if (!user || !draftReady || iamUnavailable || !shouldPersistDraft) return;
    void RiaOnboardingDraftLocalService.save(user.uid, draft);
  }, [draft, draftReady, iamUnavailable, shouldPersistDraft, user]);

  useEffect(
    () => () => {
      verificationAbortRef.current?.abort();
      if (scrapePollingRef.current) {
        clearInterval(scrapePollingRef.current);
      }
    },
    [],
  );

  const updateDraft = useCallback(
    (patch: Partial<RiaOnboardingDraft>) => {
      setError(null);
      setShouldPersistDraft(true);
      setDraft((current) => {
        const next = normalizeRiaOnboardingDraft({ ...current, ...patch });
        return {
          ...next,
          currentStepId: resolveRiaOnboardingStepId(
            next,
            next.currentStepId,
            flowOptions,
          ),
        };
      });
    },
    [flowOptions],
  );

  const applyPrefill = useCallback(
    (
      buildPatch: (current: RiaOnboardingDraft) => Partial<RiaOnboardingDraft>,
    ) => {
      setError(null);
      setShouldPersistDraft(true);
      setDraft((current) => {
        const patch = buildPatch(current);
        const next = normalizeRiaOnboardingDraft({ ...current, ...patch });
        return {
          ...next,
          currentStepId: resolveRiaOnboardingStepId(
            next,
            next.currentStepId,
            flowOptions,
          ),
        };
      });
    },
    [flowOptions],
  );

  function moveToStep(stepId: RiaOnboardingStepId) {
    setDraft((current) => ({
      ...current,
      currentStepId: resolveRiaOnboardingStepId(current, stepId, flowOptions),
    }));
  }

  function handleBack() {
    if (saving || currentStepIndex <= 0) return;
    moveToStep(steps[currentStepIndex - 1]?.id ?? steps[0]?.id ?? "welcome");
  }

  function handleContinue() {
    if (saving) return;
    if (!canContinue) {
      // The services step keeps Continue pressable (allowInvalidPress) so we can
      // run field-level validation instead of a silently disabled button.
      if (currentStep.id === "services") {
        setServicesValidateTick((tick) => tick + 1);
      }
      return;
    }
    if (currentStep.id === "review") {
      void handleSubmit();
      return;
    }
    moveToStep(steps[currentStepIndex + 1]?.id ?? currentStep.id);
  }

  // Horizontal swipe on the onboarding content pages the wizard steps (emitted
  // by the pinned-chrome RiaSwipePager). Forward = Continue, back = previous.
  const swipeNavRef = useRef({ next: () => {}, back: () => {} });
  swipeNavRef.current = { next: handleContinue, back: handleBack };
  useEffect(() => {
    const onSwipe = (event: Event) => {
      const dir = (event as CustomEvent<{ direction?: number }>).detail
        ?.direction;
      if (dir === 1) swipeNavRef.current.next();
      else if (dir === -1) swipeNavRef.current.back();
    };
    window.addEventListener("ria-onboarding-swipe", onSwipe);
    return () => window.removeEventListener("ria-onboarding-swipe", onSwipe);
  }, []);

  const startScrapePolling = useCallback(
    (jobId: string) => {
      if (scrapePollingRef.current) {
        clearInterval(scrapePollingRef.current);
      }
      scrapePollingRef.current = setInterval(async () => {
        try {
          const result = await RiaService.getCrdScrapeJobStatus(jobId);
          if (result.status === "completed" || result.status === "partial") {
            if (scrapePollingRef.current) {
              clearInterval(scrapePollingRef.current);
              scrapePollingRef.current = null;
            }
            if (result.report) {
              applyPrefill((current) =>
                buildRiaScrapePrefillPatch(current, result),
              );
            }
          } else if (result.status === "failed") {
            if (scrapePollingRef.current) {
              clearInterval(scrapePollingRef.current);
              scrapePollingRef.current = null;
            }
          }
        } catch {
          if (scrapePollingRef.current) {
            clearInterval(scrapePollingRef.current);
            scrapePollingRef.current = null;
          }
        }
      }, SCRAPE_POLL_INTERVAL_MS);
    },
    [applyPrefill],
  );

  useEffect(() => {
    if (!user || !draftReady || iamUnavailable || loading) return;
    if (!shouldRepairVerifiedPrefill(draft)) return;

    const currentUser = user;
    const licenseNumber = draft.licenseNumber.trim();
    const regulator = draft.regulator.trim();
    const repairKey = buildVerifiedPrefillKey(draft);
    if (
      stalePrefillRepairRef.current.inFlight ||
      stalePrefillRepairRef.current.lastKey === repairKey
    ) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      LICENSE_VERIFICATION_TIMEOUT_MS,
    );

    stalePrefillRepairRef.current = {
      inFlight: true,
      lastKey: repairKey,
    };

    async function repairStalePrefill() {
      try {
        const idToken = await currentUser.getIdToken();
        const result = await RiaService.verifyOnboardingLicense(
          idToken,
          {
            license_number: licenseNumber,
            regulator: regulator || undefined,
          },
          // Cache-aware (force omitted → false): a fresh cached "found" returns
          // instantly, so a reopen no longer re-scrapes the regulator.
          { signal: controller.signal, userId: currentUser.uid },
        );

        if (cancelled || controller.signal.aborted) return;

        if (result.status === "found") {
          applyPrefill((current) =>
            buildVerifiedLicensePrefillPatch(current, result, licenseNumber),
          );

          if (result.scrape_job_id) {
            startScrapePolling(result.scrape_job_id);
          }
        }
      } catch {
        // Background repair is best-effort; the user can still edit or re-verify.
      } finally {
        clearTimeout(timeoutId);
        stalePrefillRepairRef.current.inFlight = false;
      }
    }

    void repairStalePrefill();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [
    applyPrefill,
    draft,
    draftReady,
    iamUnavailable,
    loading,
    startScrapePolling,
    user,
  ]);

  async function handleVerifyLicense() {
    if (!user || !draft.licenseNumber.trim()) return;

    verificationAbortRef.current?.abort();
    const controller = new AbortController();
    verificationAbortRef.current = controller;

    setError(null);
    updateDraft({
      ...REGULATOR_PREFILL_RESET,
      licenseVerificationStatus: "verifying",
    });

    try {
      const idToken = await user.getIdToken();
      const timeoutId = setTimeout(
        () => controller.abort(),
        LICENSE_VERIFICATION_TIMEOUT_MS,
      );

      const result: RiaLicenseVerificationResult =
        await RiaService.verifyOnboardingLicense(
          idToken,
          {
            license_number: draft.licenseNumber.trim(),
            regulator: draft.regulator || undefined,
          },
          // Explicit user tap → force:true bypasses the client verify cache and
          // writes the fresh result through for later reopens.
          { signal: controller.signal, userId: user.uid, force: true },
        );

      clearTimeout(timeoutId);
      if (controller.signal.aborted) return;

      if (result.status === "found") {
        applyPrefill((current) =>
          buildVerifiedLicensePrefillPatch(
            current,
            result,
            draft.licenseNumber.trim(),
          ),
        );

        if (result.scrape_job_id) {
          startScrapePolling(result.scrape_job_id);
        }

        setTimeout(() => {
          moveToStep("license_details");
        }, 600);
      } else if (result.status === "pending" && result.scrape_job_id) {
        applyPrefill((current) =>
          buildVerifiedLicensePrefillPatch(
            current,
            result,
            draft.licenseNumber.trim(),
          ),
        );
        startScrapePolling(result.scrape_job_id);
      } else {
        updateDraft({ licenseVerificationStatus: "not_found" });
      }
    } catch (verifyError) {
      if (
        controller.signal.aborted ||
        (verifyError &&
          typeof verifyError === "object" &&
          "name" in verifyError &&
          verifyError.name === "AbortError")
      ) {
        return;
      }
      if (verifyError instanceof RiaApiError && verifyError.status === 429) {
        updateDraft({ licenseVerificationStatus: "idle" });
        setError("Too many verification attempts. Please wait a moment.");
        return;
      }
      updateDraft({ licenseVerificationStatus: "error" });
      setError(
        verifyError instanceof Error
          ? verifyError.message
          : "License verification failed.",
      );
    } finally {
      if (!controller.signal.aborted) {
        verificationAbortRef.current = null;
      }
    }
  }

  function handleBypassLicenseVerification() {
    if (!localVerificationBypassEnabled || !draft.licenseNumber.trim()) return;

    updateDraft({
      licenseVerificationStatus: "found",
      advisorName: draft.advisorName || "Dev/UAT RIA",
      firmName: draft.firmName || "Dev/UAT Advisory Practice",
      regulator: draft.regulator || "DEV_UAT",
      regulatorStatus: RIA_ENVIRONMENT_BYPASS_STATUS,
      crdNumber: draft.crdNumber || draft.licenseNumber.trim(),
      displayName: draft.displayName || draft.advisorName || "Dev/UAT RIA",
      individualLegalName:
        draft.individualLegalName || draft.advisorName || "Dev/UAT RIA",
      individualCrd: draft.individualCrd || draft.licenseNumber.trim(),
      advisoryFirmName:
        draft.advisoryFirmName || draft.firmName || "Dev/UAT Advisory Practice",
    });
    setTimeout(() => {
      moveToStep("license_details");
    }, 200);
  }

  async function handleSubmit() {
    if (!user) return;
    if (submitInFlightRef.current) return;
    // A verified advisor normally can't re-submit — but on a re-initiate they
    // MUST, so the idempotent submitOnboarding re-runs and updates the profile.
    if (advisoryAccessReady && !reinitiateIntent) {
      if (setupOrigin) {
        if (setupMode) {
          onSetupReadinessChange?.(true);
        } else {
          router.replace(ROUTES.ONE_SETUP_RIA);
        }
        return;
      }
      router.push(ROUTES.RIA_PROFILE);
      return;
    }

    submitInFlightRef.current = true;
    setSaving(true);
    setError(null);

    try {
      const idToken = await user.getIdToken();
      const shouldForceLiveVerification = !licenseVerificationSatisfied;
      const result = await RiaService.submitOnboarding(idToken, {
        display_name: draft.advisorName.trim() || draft.displayName.trim(),
        requested_capabilities: draft.requestedCapabilities,
        individual_legal_name:
          draft.individualLegalName.trim() ||
          draft.advisorName.trim() ||
          undefined,
        individual_crd:
          draft.individualCrd.trim() || draft.crdNumber.trim() || undefined,
        advisory_firm_legal_name:
          draft.advisoryFirmName.trim() || draft.firmName.trim() || undefined,
        advisory_firm_iapd_number:
          draft.advisoryFirmIapdNumber.trim() || undefined,
        bio: draft.bio.trim() || undefined,
        strategy: draft.strategySummary.trim() || undefined,
        force_live_verification:
          shouldForceLiveVerification && !isRiaVerificationBypassedDraft(draft),
        license_number: draft.licenseNumber.trim() || undefined,
        regulator: draft.regulator.trim() || undefined,
        onboarding_type: draft.onboardingType,
        services_offered: draft.servicesOffered,
        fee_structure: draft.feeStructure,
        min_engagement_amount: draft.minEngagementAmount
          ? parseFloat(draft.minEngagementAmount.replace(/[^0-9.]/g, ""))
          : undefined,
        certifications: draft.certifications,
        contact_email: draft.contactEmail.trim() || undefined,
        contact_phone: draft.contactPhone.trim() || undefined,
        business_city: draft.city.trim() || undefined,
        business_area: draft.areaLocality.trim() || undefined,
        business_address: draft.fullStreetAddress.trim() || undefined,
        business_pin_zip: draft.pinZip.trim() || undefined,
        business_latitude: draft.latitude ?? undefined,
        business_longitude: draft.longitude ?? undefined,
      });

      trackEvent("ria_onboarding_submitted", { result: "success" });
      trackGrowthFunnelStepCompleted({
        journey: "ria",
        step: "profile_submitted",
        entrySurface: "ria_onboarding",
        dedupeKey: "growth:ria:profile_submitted",
        dedupeWindowMs: 5_000,
      });

      const advisoryOutcome = (
        result.advisory_status ||
        result.verification_status ||
        ""
      ).toLowerCase();

      await RiaService.setRiaMarketplaceDiscoverability(idToken, {
        enabled: advisoryOutcome === "verified" || advisoryOutcome === "active",
        headline: draft.headline.trim() || undefined,
        strategy_summary:
          draft.strategySummary.trim() || draft.bio.trim() || undefined,
      }).catch(() => null);

      await refreshPersonaState({ force: true });

      // Durably mark the RIA setup step complete so the /one dashboard "N of 6"
      // count includes it (and updates live via the pre-vault bootstrap-cache
      // "set" event the dashboard hook subscribes to). Only for the standalone
      // path — in setupMode the setup-hub coordinator writes this on "Finish",
      // so we avoid racing it. Best-effort + idempotent: enrichRia still
      // reconciles the dashboard count on the next load if this write fails.
      if (!setupMode) {
        try {
          const current = await PreVaultUserStateService.bootstrapState(
            user.uid,
          );
          if (!current.setupCapabilityIds.includes("ria")) {
            const next = Array.from(
              new Set([...current.setupCapabilityIds, "ria"]),
            ).sort();
            // syncSetupCapabilities REPLACES the stored set, so pass the union.
            await PreVaultUserStateService.syncSetupCapabilities(
              user.uid,
              next,
            );
          }
        } catch {
          // best-effort; dashboard enrichRia reconciles the count on next load.
        }
      }

      if (advisoryOutcome === "verified" || advisoryOutcome === "active") {
        await RiaOnboardingDraftLocalService.clear(user.uid);
        setShouldPersistDraft(false);
        toast.success("Credentials verified", {
          description: "Your advisor profile is now live in the RIA directory.",
        });
      } else if (advisoryOutcome === "rejected") {
        toast.error("Verification failed", {
          description:
            result.verification_message || "The license could not be verified.",
        });
        setError(result.verification_message || "Verification was rejected.");
      } else {
        // Onboarding is complete; the verified badge is a separate layer that
        // unlocks after live/manual verification succeeds. Do not block here.
        await RiaOnboardingDraftLocalService.clear(user.uid);
        setShouldPersistDraft(false);
        toast.success("Profile created", {
          description:
            "Your RIA profile is live as pending verification. The verified badge unlocks once your licence is confirmed.",
        });
      }

      setStatus((current) => ({
        ...(current || { exists: true }),
        display_name: draft.advisorName.trim(),
        requested_capabilities: result.requested_capabilities,
        verification_status: result.verification_status,
        advisory_status: result.advisory_status,
        brokerage_status: result.brokerage_status,
        individual_legal_name: result.individual_legal_name || undefined,
        individual_crd: result.individual_crd || undefined,
        advisory_firm_legal_name: result.advisory_firm_legal_name || undefined,
        advisory_firm_iapd_number:
          result.advisory_firm_iapd_number || undefined,
      }));

      if (advisoryOutcome === "rejected") {
        moveToStep("review");
      } else {
        // A setup-originated journey always settles through its explicit
        // capability terminal before returning to the setup hub. Ordinary RIA
        // onboarding keeps its established profile destination.
        if (setupOrigin) {
          if (setupMode) {
            onSetupReadinessChange?.(true);
          } else {
            router.replace(ROUTES.ONE_SETUP_RIA);
          }
        } else {
          router.replace(ROUTES.RIA_PROFILE);
        }
      }
    } catch (submitError) {
      if (isIAMSchemaNotReadyError(submitError)) {
        setIamUnavailable(true);
      }
      trackEvent("ria_onboarding_submitted", { result: "error" });
      const submitErrorMessage = resolveRiaSubmitErrorMessage(submitError, {
        localVerificationBypassEnabled,
      });
      setError(submitErrorMessage);
      toast.error("Could not submit verification", {
        description: submitErrorMessage,
      });
    } finally {
      submitInFlightRef.current = false;
      setSaving(false);
    }
  }

  function handleEditSection(section: "license" | "services") {
    switch (section) {
      case "license":
        moveToStep("license_details");
        break;
      case "services":
        moveToStep("services");
        break;
    }
  }

  function handleDraftBio() {
    const suggestion = buildRiaOnboardingBioSuggestion(draft);
    if (!suggestion) {
      toast.info("Verify your licence first", {
        description:
          "Kai needs regulator-backed details before drafting a bio.",
      });
      return;
    }
    updateDraft({
      bio: suggestion,
      strategySummary: draft.strategySummary.trim()
        ? draft.strategySummary
        : suggestion,
    });
    toast.success("Bio drafted", {
      description: "Review the draft before submitting your profile.",
    });
  }

  function handleAskKaiUpdateAnything() {
    openKaiCommandBar();
    toast.info("Kai command opened", {
      description:
        "Ask Kai what to update, or use Edit on any section for direct changes.",
    });
  }

  const isEnriching = Boolean(draft.scrapeJobId && scrapePollingRef.current);
  const nativeTestDataState =
    loading || !draftReady
      ? "loading"
      : iamUnavailable
        ? "unavailable-valid"
        : error
          ? "error"
          : "loaded";

  function renderStep() {
    if (loading) {
      return (
        <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      );
    }

    if (!user) {
      return (
        <div className="rounded-[24px] border border-dashed px-4 py-6 text-sm text-muted-foreground">
          Sign in to continue the RIA onboarding flow.
        </div>
      );
    }

    if (iamUnavailable) {
      return (
        <div className="rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-6 text-sm text-foreground">
          RIA onboarding is unavailable in this environment. The backend IAM
          schema has not been activated yet.
        </div>
      );
    }

    switch (currentStep.id) {
      case "welcome":
        return (
          <OnboardingStepWelcome
            onboardingType={draft.onboardingType}
            onSelect={(type: "individual" | "firm") =>
              updateDraft({ onboardingType: type })
            }
          />
        );
      case "license_number":
        return (
          <OnboardingStepLicense
            licenseNumber={draft.licenseNumber}
            onLicenseNumberChange={(value: string) =>
              updateDraft({
                licenseNumber: value,
                licenseVerificationStatus: "idle",
              })
            }
            verificationStatus={draft.licenseVerificationStatus}
            onVerify={handleVerifyLicense}
            onBypassVerification={handleBypassLicenseVerification}
            verificationBypassEnabled={localVerificationBypassEnabled}
          />
        );
      case "license_details":
        return (
          <OnboardingStepLicenseDetails
            advisorName={draft.advisorName}
            firmName={draft.firmName}
            regulator={draft.regulator}
            regulatorStatus={draft.regulatorStatus}
            licenseExpiry={draft.licenseExpiry}
            certifications={draft.certifications}
            city={draft.city}
            pinZip={draft.pinZip}
            crdNumber={draft.crdNumber}
            onAdvisorNameChange={(value: string) =>
              updateDraft({ advisorName: value, displayName: value })
            }
            onCityChange={(value: string) => updateDraft({ city: value })}
            onPinZipChange={(value: string) => updateDraft({ pinZip: value })}
            isEnriching={isEnriching}
          />
        );
      case "services":
        return (
          <OnboardingStepServices
            servicesOffered={draft.servicesOffered}
            feeStructure={draft.feeStructure}
            minEngagementAmount={draft.minEngagementAmount}
            bio={draft.bio}
            city={draft.city}
            areaLocality={draft.areaLocality}
            fullStreetAddress={draft.fullStreetAddress}
            pinZip={draft.pinZip}
            onServicesChange={(services: string[]) =>
              updateDraft({ servicesOffered: services })
            }
            onFeeStructureChange={(fees: string[]) =>
              updateDraft({ feeStructure: fees })
            }
            onMinEngagementChange={(value: string) =>
              updateDraft({ minEngagementAmount: value })
            }
            onBioChange={(value: string) => updateDraft({ bio: value })}
            onCityChange={(value: string) => updateDraft({ city: value })}
            onAreaLocalityChange={(value: string) =>
              updateDraft({ areaLocality: value })
            }
            onFullStreetAddressChange={(value: string) =>
              updateDraft({ fullStreetAddress: value })
            }
            onPinZipChange={(value: string) => updateDraft({ pinZip: value })}
            onDraftBio={handleDraftBio}
            validateTick={servicesValidateTick}
          />
        );
      case "review":
        return (
          <OnboardingStepReview
            advisorName={draft.advisorName}
            firmName={draft.firmName}
            crdNumber={draft.crdNumber}
            regulator={draft.regulator}
            regulatorStatus={draft.regulatorStatus}
            certifications={draft.certifications}
            servicesOffered={draft.servicesOffered}
            feeStructure={draft.feeStructure}
            minEngagementAmount={draft.minEngagementAmount}
            bio={draft.bio}
            city={draft.city}
            pinZip={draft.pinZip}
            areaLocality={draft.areaLocality}
            fullStreetAddress={draft.fullStreetAddress}
            advisoryAccessReady={advisoryAccessReady}
            onEditSection={handleEditSection}
            onAskKaiUpdateAnything={handleAskKaiUpdateAnything}
          />
        );
      default:
        return null;
    }
  }

  // No-flash gate: while the entry decision is pending (cold cache) or the user
  // is an established advisor being redirected to their profile, render a neutral
  // skeleton — NEVER the onboarding wizard — so an advisor with an existing
  // profile sees no "2/5 Enter your licence" flash.
  if (entryMode !== "wizard") {
    return (
      <>
        <NativeTestBeacon
          routeId="/ria/onboarding"
          marker="native-route-ria-onboarding"
          authState={user ? "authenticated" : "anonymous"}
          dataState={nativeTestDataState}
          errorCode={null}
          errorMessage={null}
        />
        <FullscreenFlowShell width="reading" className="px-0">
          <div
            className="flex min-h-[40vh] items-center justify-center"
            data-ria-onboarding-gate="pending"
          >
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </FullscreenFlowShell>
      </>
    );
  }

  return (
    <>
      <NativeTestBeacon
        routeId="/ria/onboarding"
        marker="native-route-ria-onboarding"
        authState={user ? "authenticated" : "anonymous"}
        dataState={nativeTestDataState}
        errorCode={error ? "ria_onboarding" : null}
        errorMessage={error}
      />
      <FullscreenFlowShell width="reading" className="px-0">
        <RiaOnboardingJourney showIntro={currentStep.id === "welcome"}>
          <OnboardingShell
            currentStepIndex={currentStepIndex}
            totalSteps={steps.length}
            eyebrow={currentStep.eyebrow}
            title={currentStep.title}
            description={currentStep.description}
            canContinue={canContinue}
            saving={saving}
            isFirstStep={currentStepIndex === 0}
            isLastStep={currentStep.id === "review"}
            advisoryAccessReady={advisoryAccessReady}
            hideTerminal={setupMode && advisoryAccessReady}
            onSkip={setupMode && !advisoryAccessReady ? onSetupSkip : undefined}
            allowInvalidPress={currentStep.id === "services"}
            heroImage={RIA_ONBOARDING_STEP_IMAGES[currentStep.id]}
            onBack={handleBack}
            onContinue={handleContinue}
          >
            {renderStep()}

            {error ? (
              <div className="mt-4 rounded-[24px] border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/20 dark:text-red-400">
                {error}
              </div>
            ) : null}
          </OnboardingShell>
        </RiaOnboardingJourney>
      </FullscreenFlowShell>
    </>
  );
}
