"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { OnboardingShell } from "@/components/ria/onboarding/onboarding-shell";
import { OnboardingStepWelcome } from "@/components/ria/onboarding/onboarding-step-welcome";
import { OnboardingStepLicense } from "@/components/ria/onboarding/onboarding-step-license";
import { OnboardingStepLicenseDetails } from "@/components/ria/onboarding/onboarding-step-license-details";
import { OnboardingStepServices } from "@/components/ria/onboarding/onboarding-step-services";
import { OnboardingStepReview } from "@/components/ria/onboarding/onboarding-step-review";
import { useAuth } from "@/hooks/use-auth";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import {
  buildRiaOnboardingSteps,
  canContinueRiaOnboardingStep,
  getRiaOnboardingStepIndex,
  normalizeRiaOnboardingDraft,
  resolveRiaOnboardingStepId,
  type RiaOnboardingDraft,
  type RiaOnboardingFlowOptions,
  type RiaOnboardingStepId,
} from "@/lib/ria/ria-onboarding-flow";
import {
  buildRiaLicensePrefillPatch,
  buildRiaScrapePrefillPatch,
} from "@/lib/ria/ria-onboarding-prefill";
import { RiaOnboardingDraftLocalService } from "@/lib/services/ria-onboarding-draft-local-service";
import {
  isIAMSchemaNotReadyError,
  RiaApiError,
  RiaService,
  type RiaLicenseVerificationResult,
  type RiaOnboardingStatus,
} from "@/lib/services/ria-service";
import { usePersonaState } from "@/lib/persona/persona-context";
import { trackEvent } from "@/lib/observability/client";
import { trackGrowthFunnelStepCompleted } from "@/lib/observability/growth";
import { resolveAppEnvironment } from "@/lib/app-env";

const LICENSE_VERIFICATION_TIMEOUT_MS = 90_000;
const SCRAPE_POLL_INTERVAL_MS = 5_000;
const RIA_ENVIRONMENT_BYPASS_STATUS = "Environment bypass";
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

export default function RiaOnboardingPage() {
  const router = useRouter();
  const { user, phoneNumber } = useAuth();
  const { refresh: refreshPersonaState } = usePersonaState();

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

  const verificationAbortRef = useRef<AbortController | null>(null);
  const scrapePollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stalePrefillRepairRef = useRef<{
    inFlight: boolean;
    lastKey: string | null;
  }>({ inFlight: false, lastKey: null });

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
    setLocalVerificationBypassEnabled(isEnvironmentRiaVerificationBypassEnabled());
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

        const currentStepId = localDraft?.currentStepId
          ? resolveRiaOnboardingStepId(
              resolvedDraft,
              localDraft.currentStepId,
              {
                licenseVerificationSatisfied:
                  alreadyVerified ||
                  resolvedDraft.licenseVerificationStatus === "found",
              },
            )
          : "welcome";

        setStatus(nextStatus);
        setDraft({ ...resolvedDraft, currentStepId });
        setShouldPersistDraft(true);
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
  }, [phoneNumber, user]);

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
    if (!canContinue || saving) return;
    if (currentStep.id === "review") {
      void handleSubmit();
      return;
    }
    moveToStep(steps[currentStepIndex + 1]?.id ?? currentStep.id);
  }

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
          { signal: controller.signal },
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
          { signal: controller.signal },
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
    if (advisoryAccessReady) {
      router.push(ROUTES.RIA_HOME);
      return;
    }

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
        toast.info("Verification submitted", {
          description: "Your profile is pending verification.",
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

      moveToStep("review");
    } catch (submitError) {
      if (isIAMSchemaNotReadyError(submitError)) {
        setIamUnavailable(true);
      }
      trackEvent("ria_onboarding_submitted", { result: "error" });
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to submit onboarding.",
      );
      toast.error("Could not submit verification", {
        description:
          submitError instanceof Error
            ? submitError.message
            : "Failed to submit onboarding.",
      });
    } finally {
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

  const isEnriching = Boolean(draft.scrapeJobId && scrapePollingRef.current);
  const nativeTestDataState = loading || !draftReady
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
          />
        );
      default:
        return null;
    }
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
      </FullscreenFlowShell>
    </>
  );
}
