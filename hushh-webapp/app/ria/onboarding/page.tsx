"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";

import { PopupTextEditorField } from "@/components/app-ui/command-fields";
import { SurfaceCard, SurfaceCardContent, SurfaceCardHeader, SurfaceInset } from "@/components/app-ui/surfaces";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { RiaCompatibilityState, RiaPageShell } from "@/components/ria/ria-page-shell";
import { useAuth } from "@/hooks/use-auth";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import {
  buildRiaOnboardingSteps,
  canContinueRiaOnboardingStep,
  getRequestedCapabilityLabels,
  type RiaOnboardingFlowOptions,
  getRiaOnboardingStepIndex,
  normalizeRiaOnboardingDraft,
  resolveRiaOnboardingStepId,
  type RiaCapability,
  type RiaOnboardingDraft,
  type RiaOnboardingStep,
  type RiaOnboardingStepId,
} from "@/lib/ria/ria-onboarding-flow";
import { RiaOnboardingDraftLocalService } from "@/lib/services/ria-onboarding-draft-local-service";
import {
  isIAMSchemaNotReadyError,
  RiaApiError,
  RiaService,
  type MarketplaceRia,
  type RiaNameVerificationResult,
  type RiaOnboardingStatus,
} from "@/lib/services/ria-service";
import { usePersonaState } from "@/lib/persona/persona-context";
import { trackEvent } from "@/lib/observability/client";
import {
  trackGrowthFunnelStepCompleted,
  trackRiaActivationCompleted,
} from "@/lib/observability/growth";

function formatVerificationStatus(
  status?: string | null,
  loading?: boolean,
  lane: "advisory" | "brokerage" = "advisory"
) {
  if (loading) return "Loading";
  switch (status) {
    case "verified":
      return lane === "brokerage" ? "Broker verified" : "IAPD verified";
    case "active":
      return "Active";
    case "bypassed":
      return "Bypassed";
    case "submitted":
      return "Submitted";
    case "rejected":
      return "Rejected";
    case "draft":
    default:
      return "Draft";
  }
}

function compactDate(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}

type NameVerificationState =
  | "idle"
  | "verifying"
  | "verified"
  | "not_verified"
  | "provider_unavailable";

const NAME_VERIFICATION_VISIBLE_TIMEOUT_MS = 90_000;

const FALLBACK_STEP: RiaOnboardingStep = {
  id: "capabilities",
  eyebrow: "Capability",
  title: "Which professional lane are you activating first?",
  description:
    "Choose the trust lane Kai should verify. Advisory unlocks the current RIA workflow. Brokerage stays tracked separately.",
};

function draftFromStatus(
  status: RiaOnboardingStatus | null,
  publicProfile: MarketplaceRia | null
): Partial<RiaOnboardingDraft> {
  const requestedCapabilities = Array.isArray(status?.requested_capabilities)
    ? (status?.requested_capabilities.filter(
        (value): value is RiaCapability => value === "advisory" || value === "brokerage"
      ) as RiaCapability[])
    : [];

  return {
    requestedCapabilities,
    displayName: status?.display_name || "",
    individualLegalName: status?.individual_legal_name || status?.legal_name || "",
    individualCrd: status?.individual_crd || status?.finra_crd || "",
    advisoryFirmName: status?.advisory_firm_legal_name || "",
    advisoryFirmIapdNumber: status?.advisory_firm_iapd_number || status?.sec_iard || "",
    brokerFirmName: status?.broker_firm_legal_name || "",
    brokerFirmCrd: status?.broker_firm_crd || "",
    headline: publicProfile?.headline || "",
    strategySummary: publicProfile?.strategy_summary || "",
  };
}

function buildSubmitPayload(draft: RiaOnboardingDraft) {
  const advisoryEnabled = draft.requestedCapabilities.includes("advisory");
  const brokerageEnabled = draft.requestedCapabilities.includes("brokerage");

  return {
    display_name: draft.displayName.trim(),
    requested_capabilities: draft.requestedCapabilities,
    individual_legal_name: draft.individualLegalName.trim() || undefined,
    individual_crd: draft.individualCrd.trim() || undefined,
    advisory_firm_legal_name:
      advisoryEnabled ? draft.advisoryFirmName.trim() || undefined : undefined,
    advisory_firm_iapd_number:
      advisoryEnabled ? draft.advisoryFirmIapdNumber.trim() || undefined : undefined,
    broker_firm_legal_name: brokerageEnabled ? draft.brokerFirmName.trim() || undefined : undefined,
    broker_firm_crd: brokerageEnabled ? draft.brokerFirmCrd.trim() || undefined : undefined,
    strategy: draft.strategySummary.trim() || undefined,
  };
}

function latestVerificationCopy(status: RiaOnboardingStatus | null): string {
  const latest = status?.latest_advisory_event || status?.latest_verification_event;
  if (!latest) return "Verification starts after you submit this trust profile.";
  const outcome = latest.outcome || "latest check";
  const checkedAt = compactDate(latest.checked_at);
  return checkedAt ? `${outcome} on ${checkedAt}` : outcome;
}

function isAdvisoryAccessReady(status?: string | null): boolean {
  return status === "active" || status === "verified" || status === "bypassed";
}

async function waitForNameVerificationResult<T>(
  promise: Promise<T | null>,
  options: { timeoutMs: number; onTimeout?: () => void }
): Promise<{ timedOut: boolean; value: T | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      options.onTimeout?.();
      resolve({ timedOut: true, value: null });
    }, options.timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function resolvedVerifiedIdentity(
  status: RiaOnboardingStatus | null,
  result: RiaNameVerificationResult | null,
  draft: RiaOnboardingDraft
) {
  return {
    matchedName:
      result?.matched_name ||
      status?.individual_legal_name ||
      status?.legal_name ||
      draft.displayName.trim() ||
      null,
    crdNumber: result?.crd_number || status?.individual_crd || status?.finra_crd || null,
    currentFirm: result?.current_firm || status?.advisory_firm_legal_name || null,
    secNumber:
      result?.sec_number || status?.advisory_firm_iapd_number || status?.sec_iard || null,
  };
}

function StepChoice({
  active,
  label,
  description,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-[24px] border px-4 py-4 text-left transition-colors",
        active
          ? "border-foreground/15 bg-foreground text-background shadow-[0_18px_36px_rgba(15,23,42,0.12)]"
          : "border-border/70 bg-background/75 hover:border-border hover:bg-background"
      )}
    >
      <div className="space-y-1">
        <p className={cn("text-sm font-semibold", active ? "text-background" : "text-foreground")}>
          {label}
        </p>
        <p className={cn("text-sm leading-6", active ? "text-background/78" : "text-muted-foreground")}>
          {description}
        </p>
      </div>
    </button>
  );
}

function TextField({
  label,
  placeholder,
  value,
  onChange,
  inputMode,
  onKeyDown,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
  onKeyDown?: InputHTMLAttributes<HTMLInputElement>["onKeyDown"];
}) {
  return (
    <label className="space-y-2">
      <span className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        onKeyDown={onKeyDown}
        className="min-h-12 w-full rounded-[22px] border border-border/70 bg-background/90 px-4 text-sm outline-none transition-[border-color,box-shadow] focus:border-foreground/30 focus:shadow-[0_0_0_4px_rgba(15,23,42,0.06)]"
        placeholder={placeholder}
      />
    </label>
  );
}

function ReviewField({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper?: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </p>
      <p className="text-sm font-medium text-foreground">{value}</p>
      {helper ? <p className="text-sm text-muted-foreground">{helper}</p> : null}
    </div>
  );
}

export default function RiaOnboardingPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { devRiaBypassAllowed, refresh: refreshPersonaState } = usePersonaState();

  const [status, setStatus] = useState<RiaOnboardingStatus | null>(null);
  const [draft, setDraft] = useState<RiaOnboardingDraft>(
    normalizeRiaOnboardingDraft(undefined)
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [iamUnavailable, setIamUnavailable] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [shouldPersistDraft, setShouldPersistDraft] = useState(false);
  const [nameVerificationStatus, setNameVerificationStatus] = useState<NameVerificationState>("idle");
  const [nameVerificationResult, setNameVerificationResult] = useState<RiaNameVerificationResult | null>(null);
  const [lastVerifiedQuery, setLastVerifiedQuery] = useState<string | null>(null);
  const verificationRequestIdRef = useRef(0);
  const verificationAbortRef = useRef<AbortController | null>(null);
  const latestDisplayNameRef = useRef("");

  useEffect(() => {
    let cancelled = false;

    async function loadState() {
      if (!user) {
        if (!cancelled) {
          setLoading(false);
          setDraftReady(true);
          setShouldPersistDraft(false);
          setNameVerificationStatus("idle");
          setNameVerificationResult(null);
          setLastVerifiedQuery(null);
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
        const publicProfile = nextStatus?.ria_profile_id
          ? await RiaService.getRiaPublicProfile(nextStatus.ria_profile_id).catch(() => null)
          : null;
        if (cancelled) return;

        const seeded = normalizeRiaOnboardingDraft({
          ...draftFromStatus(nextStatus, publicProfile),
          ...localDraft,
        });
        const seededIdentity = resolvedVerifiedIdentity(nextStatus, null, seeded);
        const persistedDisplayName = nextStatus?.display_name?.trim() || "";
        const seededVerified =
          isAdvisoryAccessReady(nextStatus?.advisory_status || nextStatus?.verification_status) &&
          Boolean(seededIdentity.crdNumber) &&
          Boolean(persistedDisplayName) &&
          persistedDisplayName === seeded.displayName.trim();
        const currentStepId = resolveRiaOnboardingStepId(seeded, localDraft?.currentStepId, {
          nameVerificationSatisfied: seededVerified,
        });

        setStatus(nextStatus);
        setDraft({ ...seeded, currentStepId });
        if (seededVerified) {
          setNameVerificationStatus("verified");
          setNameVerificationResult({
            status: "verified",
            matched_name: seededIdentity.matchedName,
            crd_number: seededIdentity.crdNumber,
            current_firm: seededIdentity.currentFirm,
            sec_number: seededIdentity.secNumber,
            provider: nextStatus?.verification_provider || "ria_intelligence_stage1",
            suggested_names: [],
          });
          setLastVerifiedQuery(seeded.displayName.trim() || seededIdentity.matchedName);
        } else {
          setNameVerificationStatus("idle");
          setNameVerificationResult(null);
          setLastVerifiedQuery(null);
        }
        setShouldPersistDraft(true);
      } catch (loadError) {
        if (!cancelled) {
          if (isIAMSchemaNotReadyError(loadError)) {
            setIamUnavailable(true);
          } else {
            setError(
              loadError instanceof Error
                ? loadError.message
                : "Failed to load RIA onboarding."
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
  }, [user]);

  useEffect(() => {
    if (!user || !draftReady || iamUnavailable || !shouldPersistDraft) return;
    void RiaOnboardingDraftLocalService.save(user.uid, draft);
  }, [draft, draftReady, iamUnavailable, shouldPersistDraft, user]);

  useEffect(
    () => () => {
      verificationAbortRef.current?.abort();
    },
    []
  );

  const advisoryVerificationStatus = status?.advisory_status || status?.verification_status || "draft";
  const brokerageVerificationStatus = status?.brokerage_status || "draft";
  const advisoryAccessReady = isAdvisoryAccessReady(advisoryVerificationStatus);
  const brokerageAccessReady =
    brokerageVerificationStatus === "active" ||
    brokerageVerificationStatus === "verified" ||
    brokerageVerificationStatus === "bypassed";
  const displayNameQuery = draft.displayName.trim();
  latestDisplayNameRef.current = displayNameQuery;
  const persistedVerifiedDisplayName = status?.display_name?.trim() || "";
  const persistedVerificationSatisfied =
    isAdvisoryAccessReady(status?.advisory_status || status?.verification_status) &&
    Boolean(status?.individual_crd || status?.finra_crd) &&
    Boolean(persistedVerifiedDisplayName) &&
    persistedVerifiedDisplayName === displayNameQuery;
  const nameVerificationSatisfied =
    persistedVerificationSatisfied ||
    (nameVerificationStatus === "verified" &&
      Boolean(nameVerificationResult?.crd_number) &&
      Boolean(displayNameQuery) &&
      lastVerifiedQuery === displayNameQuery);
  const flowOptions = useMemo<RiaOnboardingFlowOptions>(
    () => ({ nameVerificationSatisfied }),
    [nameVerificationSatisfied]
  );
  const verifiedIdentity = useMemo(
    () => resolvedVerifiedIdentity(status, nameVerificationResult, draft),
    [draft, nameVerificationResult, status]
  );
  const canVerifyName =
    Boolean(user) &&
    displayNameQuery.length > 0 &&
    nameVerificationStatus !== "verifying" &&
    !(nameVerificationStatus === "verified" && lastVerifiedQuery === displayNameQuery);
  const isBroadNameQuery =
    nameVerificationStatus === "not_verified" &&
    nameVerificationResult?.reason_code === "query_too_broad";
  const steps = useMemo(() => buildRiaOnboardingSteps(draft, flowOptions), [draft, flowOptions]);
  const currentStepIndex = useMemo(
    () => getRiaOnboardingStepIndex(draft, draft.currentStepId, flowOptions),
    [draft, flowOptions]
  );
  const currentStep = steps[currentStepIndex] ?? steps[0] ?? FALLBACK_STEP;
  const canContinue = canContinueRiaOnboardingStep(currentStep.id, draft, flowOptions);
  const capabilityLabels = getRequestedCapabilityLabels(draft);
  const progressValue = Math.round(((currentStepIndex + 1) / Math.max(steps.length, 1)) * 100);

  useEffect(() => {
    setDraft((current) => {
      const nextStepId = resolveRiaOnboardingStepId(current, current.currentStepId, flowOptions);
      if (nextStepId === current.currentStepId) {
        return current;
      }
      return {
        ...current,
        currentStepId: nextStepId,
      };
    });
  }, [flowOptions]);

  function cancelActiveVerification() {
    verificationRequestIdRef.current += 1;
    verificationAbortRef.current?.abort();
    verificationAbortRef.current = null;
  }

  function applyVerifiedIdentityToDraft(result: RiaNameVerificationResult) {
    setShouldPersistDraft(true);
    setDraft((current) => ({
      ...current,
      individualLegalName: result.matched_name || "",
      individualCrd: result.crd_number || "",
      advisoryFirmName: result.current_firm || "",
      advisoryFirmIapdNumber: result.sec_number || "",
    }));
  }

  function handleDisplayNameChange(value: string) {
    cancelActiveVerification();
    setNameVerificationStatus("idle");
    setNameVerificationResult(null);
    setLastVerifiedQuery(null);
    latestDisplayNameRef.current = value.trim();
    updateDraft({
      displayName: value,
      individualLegalName: "",
      individualCrd: "",
      advisoryFirmName: "",
      advisoryFirmIapdNumber: "",
    });
  }

  function handleSuggestedNameSelect(value: string) {
    handleDisplayNameChange(value);
    window.setTimeout(() => {
      void handleVerifyName(value);
    }, 0);
  }

  async function handleVerifyName(overrideQuery?: string) {
    if (!user) return;
    const normalizedQuery = (overrideQuery || draft.displayName).trim();
    if (!normalizedQuery) return;

    cancelActiveVerification();
    const requestId = verificationRequestIdRef.current;
    const controller = new AbortController();
    verificationAbortRef.current = controller;

    setNotice(null);
    setError(null);
    setNameVerificationStatus("verifying");
    setNameVerificationResult(null);
    setLastVerifiedQuery(null);

    try {
      const idToken = await user.getIdToken();
      const initialResolution = await waitForNameVerificationResult(
        RiaService.verifyOnboardingName(
          idToken,
          { query: normalizedQuery },
          { signal: controller.signal }
        ),
        {
          timeoutMs: NAME_VERIFICATION_VISIBLE_TIMEOUT_MS,
          onTimeout: () => {
            controller.abort();
          },
        }
      );
      if (initialResolution.timedOut || !initialResolution.value) {
        setNameVerificationResult({
          status: "provider_unavailable",
          reason:
            "This advisor lookup is taking longer than expected. Retry in a moment.",
          provider: "ria_intelligence_stage1",
          suggested_names: [],
        });
        setNameVerificationStatus("provider_unavailable");
        setLastVerifiedQuery(null);
        return;
      }

      const result = initialResolution.value;
      if (
        controller.signal.aborted ||
        requestId !== verificationRequestIdRef.current ||
        latestDisplayNameRef.current !== normalizedQuery
      ) {
        return;
      }
      setNameVerificationResult(result);
      setNameVerificationStatus(result.status);
      if (result.status === "verified") {
        applyVerifiedIdentityToDraft(result);
        setLastVerifiedQuery(normalizedQuery);
      } else {
        setLastVerifiedQuery(null);
      }
    } catch (verificationError) {
      if (
        controller.signal.aborted ||
        (verificationError &&
          typeof verificationError === "object" &&
          "name" in verificationError &&
          verificationError.name === "AbortError")
      ) {
        return;
      }
      if (verificationError instanceof RiaApiError && verificationError.status === 429) {
        setError(verificationError.message);
        setNameVerificationStatus("idle");
        setNameVerificationResult(null);
        setLastVerifiedQuery(null);
        return;
      }
      setNameVerificationResult({
        status: "provider_unavailable",
        reason:
          verificationError instanceof Error
            ? verificationError.message
            : "Could not verify this RIA name right now.",
        provider: "ria_intelligence_stage1",
        suggested_names: [],
      });
      setNameVerificationStatus("provider_unavailable");
      setLastVerifiedQuery(null);
    } finally {
      if (requestId === verificationRequestIdRef.current) {
        verificationAbortRef.current = null;
      }
    }
  }

  function updateDraft(patch: Partial<RiaOnboardingDraft>) {
    setNotice(null);
    setError(null);
    setShouldPersistDraft(true);
    setDraft((current) => {
      const next = normalizeRiaOnboardingDraft({
        ...current,
        ...patch,
      });
      return {
        ...next,
        currentStepId: resolveRiaOnboardingStepId(next, next.currentStepId, flowOptions),
      };
    });
  }

  function moveToStep(stepId: RiaOnboardingStepId) {
    setDraft((current) => ({
      ...current,
      currentStepId: resolveRiaOnboardingStepId(current, stepId, flowOptions),
    }));
  }

  function handleBack() {
    if (saving || currentStepIndex <= 0) return;
    moveToStep(steps[currentStepIndex - 1]?.id ?? steps[0]?.id ?? FALLBACK_STEP.id);
  }

  function handleContinue() {
    if (!canContinue || saving) return;
    if (currentStep.id === "review") {
      void handleSubmit();
      return;
    }
    moveToStep(steps[currentStepIndex + 1]?.id ?? currentStep.id);
  }

  async function finalizeSubmission(mode: "submit" | "dev_activate") {
    if (!user) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const idToken = await user.getIdToken();
      if (mode === "submit" && !nameVerificationSatisfied) {
        throw new Error("Verify the advisor name and wait for a CRD-backed result before continuing.");
      }
      const payload = buildSubmitPayload(draft);
      const result =
        mode === "submit"
          ? await RiaService.submitOnboarding(idToken, { ...payload, force_live_verification: true })
          : await RiaService.activateDevRia(idToken, payload);

      setStatus((current) => ({
        ...(current || { exists: true }),
        display_name: draft.displayName.trim(),
        requested_capabilities: result.requested_capabilities,
        individual_legal_name: result.individual_legal_name || undefined,
        individual_crd: result.individual_crd || undefined,
        advisory_firm_legal_name: result.advisory_firm_legal_name || undefined,
        advisory_firm_iapd_number: result.advisory_firm_iapd_number || undefined,
        broker_firm_legal_name: result.broker_firm_legal_name || draft.brokerFirmName.trim() || undefined,
        broker_firm_crd: result.broker_firm_crd || draft.brokerFirmCrd.trim() || undefined,
        verification_status: result.verification_status,
        advisory_status: result.advisory_status,
        brokerage_status: result.brokerage_status,
        dev_ria_bypass_allowed: mode === "dev_activate" ? true : current?.dev_ria_bypass_allowed,
      }));
      if (mode === "submit" && result.advisory_status === "verified") {
        setNameVerificationStatus("verified");
        setNameVerificationResult({
          status: "verified",
          matched_name: result.individual_legal_name || draft.displayName.trim() || null,
          crd_number: result.individual_crd || null,
          current_firm: result.advisory_firm_legal_name || null,
          sec_number: result.advisory_firm_iapd_number || null,
          provider: result.verification_provider || "ria_intelligence_stage1",
          suggested_names: [],
        });
        setLastVerifiedQuery(draft.displayName.trim());
      }
      trackEvent("ria_onboarding_submitted", {
        result: "success",
      });
      trackGrowthFunnelStepCompleted({
        journey: "ria",
        step: "profile_submitted",
        entrySurface: "ria_onboarding",
        dedupeKey: "growth:ria:profile_submitted",
        dedupeWindowMs: 5_000,
      });

      const advisoryOutcome = (result.advisory_status || result.verification_status || "").toLowerCase();
      const verificationOutcome = (result.verification_outcome || "").toLowerCase();
      const canActivateDiscoverability =
        mode === "dev_activate" ||
        advisoryOutcome === "verified" ||
        advisoryOutcome === "active" ||
        advisoryOutcome === "bypassed";

      await RiaService.setRiaMarketplaceDiscoverability(idToken, {
        enabled: canActivateDiscoverability,
        headline: draft.headline.trim() || undefined,
        strategy_summary: draft.strategySummary.trim() || undefined,
      }).catch(() => null);
      await refreshPersonaState({ force: true });
      if (canActivateDiscoverability) {
        await RiaOnboardingDraftLocalService.clear(user.uid);
        setShouldPersistDraft(false);
      }

      if (mode === "dev_activate") {
        trackEvent("ria_verification_status_changed", {
          action: "bypassed",
          result: "success",
        });
        trackGrowthFunnelStepCompleted({
          journey: "ria",
          step: "workspace_ready",
          entrySurface: "ria_onboarding",
          workspaceSource: "developer_activation",
          dedupeKey: "growth:ria:workspace_ready:developer_activation",
          dedupeWindowMs: 5_000,
        });
        trackRiaActivationCompleted({
          entrySurface: "ria_onboarding",
          workspaceSource: "developer_activation",
          dedupeKey: "growth:ria:activation:developer_activation",
          dedupeWindowMs: 10_000,
        });
        toast.success("Developer activation completed", {
          description: "The RIA workspace is ready in this environment.",
        });
        setNotice("Developer activation completed. The RIA workspace is ready in this environment.");
      } else if (advisoryOutcome === "rejected") {
        trackEvent("ria_verification_status_changed", {
          action: "rejected",
          result: "error",
        });
        toast.error("Verification failed", {
          description:
            result.verification_message ||
            "The advisor name could not be verified against a CRD-backed registration.",
        });
        setNotice(
          result.verification_message ||
            "Verification was rejected. Retry the advisor name."
        );
      } else if (advisoryOutcome === "verified" || advisoryOutcome === "active") {
        trackEvent("ria_verification_status_changed", {
          action: advisoryOutcome === "active" ? "active" : "verified",
          result: "success",
        });
        toast.success("Credentials verified", {
          description:
            result.verification_message ||
            "Your advisor name resolved to a verified CRD-backed RIA record.",
        });
        setNotice("Verification passed. Your RIA workspace is ready.");
      } else if (advisoryOutcome === "bypassed") {
        trackEvent("ria_verification_status_changed", {
          action: "bypassed",
          result: "success",
        });
        toast.warning("Verification bypass active", {
          description:
            result.verification_message ||
            "This non-production environment is using the advisory verification bypass.",
        });
        setNotice(
          result.verification_message ||
            "Verification bypass is active in this environment. Your RIA workspace is ready for flow testing."
        );
      } else if (verificationOutcome === "provider_unavailable") {
        trackEvent("ria_verification_status_changed", {
          action: "submitted",
          result: "error",
        });
        toast.error("Verification service unavailable", {
          description:
            result.verification_message ||
            "This environment is missing regulatory verification provider configuration.",
        });
        setNotice(
          result.verification_message ||
            "Regulatory verification is unavailable in this environment. Onboarding stays blocked until the verification provider is healthy."
        );
      } else {
        trackEvent("ria_verification_status_changed", {
          action: "submitted",
          result: "success",
        });
        toast.info("Verification submitted", {
          description:
            result.verification_message ||
            "Kai is still validating the advisor name.",
        });
        setNotice(
          "Onboarding submitted. Kai will keep this profile locked until verification clears."
        );
      }
      moveToStep("review");
    } catch (submitError) {
      if (isIAMSchemaNotReadyError(submitError)) {
        setIamUnavailable(true);
      }
      trackEvent("ria_onboarding_submitted", {
        result: "error",
      });
      setError(
        submitError instanceof Error ? submitError.message : "Failed to submit onboarding."
      );
      toast.error("Could not submit verification", {
        description:
          submitError instanceof Error ? submitError.message : "Failed to submit onboarding.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    if (advisoryAccessReady) {
      router.push(ROUTES.RIA_HOME);
      return;
    }
    await finalizeSubmission("submit");
  }

  async function handleDevActivate() {
    await finalizeSubmission("dev_activate");
  }

  function renderQuestion(step: RiaOnboardingStep) {
    switch (step.id) {
      case "capabilities":
        return (
          <div className="space-y-4">
            <div className="grid gap-3">
              <StepChoice
                active={draft.requestedCapabilities.includes("advisory")}
                label="Advisory"
                description="Unlock the current RIA workflow once the advisor name is verified."
                onClick={() => {
                  const next: RiaCapability[] = draft.requestedCapabilities.includes("advisory")
                    ? draft.requestedCapabilities.filter((value) => value !== "advisory")
                    : [...draft.requestedCapabilities, "advisory"];
                  updateDraft({ requestedCapabilities: next.length > 0 ? next : ["advisory"] });
                }}
              />
              <StepChoice
                active={draft.requestedCapabilities.includes("brokerage")}
                label="Brokerage"
                description="Track broker capability separately without implying advisory approval."
                onClick={() => {
                  const next: RiaCapability[] = draft.requestedCapabilities.includes("brokerage")
                    ? draft.requestedCapabilities.filter((value) => value !== "brokerage")
                    : [...draft.requestedCapabilities, "brokerage"];
                  updateDraft({ requestedCapabilities: next.length > 0 ? next : ["advisory"] });
                }}
              />
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              Start with the lane that matters first. Kai will only surface the workflow once the
              relevant verification clears.
            </p>
          </div>
        );
      case "display_name":
        return (
          <div className="space-y-4">
            <TextField
              label="Advisor name"
              placeholder="Ana Roumenova Carter"
              value={draft.displayName}
              onChange={handleDisplayNameChange}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void handleVerifyName();
              }}
            />
            {nameVerificationStatus === "idle" ? (
              <p className="text-sm leading-6 text-muted-foreground">
                Kai verifies your identity against FINRA and SEC records before unlocking the advisory workflow.
              </p>
            ) : null}
            {nameVerificationStatus !== "idle" ? (
            <div
              className={cn(
                "rounded-[24px] border px-4 py-4 text-sm",
                nameVerificationStatus === "verified"
                  ? "border-emerald-500/20 bg-emerald-500/8"
                  : nameVerificationStatus === "not_verified"
                    ? "border-amber-500/20 bg-amber-500/8"
                    : nameVerificationStatus === "provider_unavailable"
                      ? "border-rose-500/20 bg-rose-500/8"
                      : "border-border/70 bg-background/70"
              )}
            >
              {displayNameQuery.length > 0 && nameVerificationStatus === "verifying" ? (
                  <div className="flex items-start gap-3">
                    <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-muted-foreground" />
                    <div className="space-y-1">
                      <p className="leading-6 text-muted-foreground">
                        Verifying this advisor name now.
                      </p>
                      <p className="text-sm leading-6 text-muted-foreground">
                        This can take a few moments the first time.
                      </p>
                    </div>
                  </div>
                ) : null}
              {nameVerificationStatus === "verified" && verifiedIdentity.crdNumber ? (
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">
                        RIA verified: {verifiedIdentity.matchedName || draft.displayName.trim()}
                      </p>
                      <p className="leading-6 text-muted-foreground">
                        CRD {verifiedIdentity.crdNumber}
                        {verifiedIdentity.currentFirm ? ` · ${verifiedIdentity.currentFirm}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ReviewField
                      label="Verified name"
                      value={verifiedIdentity.matchedName || "Not returned"}
                    />
                    <ReviewField
                      label="CRD"
                      value={verifiedIdentity.crdNumber || "Not returned"}
                    />
                    <ReviewField
                      label="Advisory firm"
                      value={verifiedIdentity.currentFirm || "Not returned"}
                    />
                    <ReviewField
                      label="IAPD / IARD"
                      value={verifiedIdentity.secNumber || "Not returned"}
                    />
                  </div>
                </div>
              ) : null}
              {nameVerificationStatus === "not_verified" ? (
                <div className="space-y-2">
                  <p className="font-medium text-foreground">
                    {isBroadNameQuery
                      ? "Kai needs a more specific advisor name before verification can continue."
                      : "Kai could not verify this advisor name yet."}
                  </p>
                  <p className="leading-6 text-muted-foreground">
                    {isBroadNameQuery
                      ? "Try the advisor's full legal name so Kai can narrow to one registered professional."
                      : nameVerificationResult?.reason ||
                        "No confident FINRA or SEC match was found for the query."}
                  </p>
                  {isBroadNameQuery && nameVerificationResult?.reason ? (
                    <p className="leading-6 text-muted-foreground">{nameVerificationResult.reason}</p>
                  ) : null}
                  {nameVerificationResult?.suggested_names?.length ? (
                    <div className="space-y-2">
                      <p className="leading-6 text-muted-foreground">
                        {isBroadNameQuery
                          ? "Try one of these fuller names:"
                          : "Suggested matches:"}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {nameVerificationResult.suggested_names.map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            onClick={() => handleSuggestedNameSelect(suggestion)}
                            className="inline-flex min-h-9 items-center rounded-full border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted/40"
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {nameVerificationStatus === "provider_unavailable" ? (
                <div className="space-y-2">
                  <p className="font-medium text-foreground">
                    Kai could not complete verification right now.
                  </p>
                  <p className="leading-6 text-muted-foreground">
                    {nameVerificationResult?.reason ||
                      "The verification service is unavailable right now."}
                  </p>
                </div>
              ) : null}
            </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {nameVerificationStatus !== "verified" ? (
                <button
                  type="button"
                  onClick={() => void handleVerifyName()}
                  disabled={!canVerifyName}
                  className="inline-flex min-h-10 items-center rounded-full bg-foreground px-4 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {nameVerificationStatus === "verifying"
                    ? "Verifying..."
                    : nameVerificationStatus === "not_verified" ||
                        nameVerificationStatus === "provider_unavailable"
                      ? "Retry verification"
                      : "Verify"}
                </button>
              ) : null}
            </div>

            <p className="text-sm leading-6 text-muted-foreground">
              Advisory access requires a verified CRD-backed identity. If the name does not resolve to a unique registration, update it and retry verification.
            </p>
          </div>
        );
      case "legal_identity":
        return (
          <div className="space-y-4">
            <div className="rounded-[20px] border border-border/70 bg-background/70 px-4 py-4 text-sm text-muted-foreground">
              Manual fallback is only for cases where the name-first Stage 1 lookup cannot verify the advisor cleanly.
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Individual legal name"
                placeholder="Full legal adviser or broker name"
                value={draft.individualLegalName}
                onChange={(value) => updateDraft({ individualLegalName: value })}
              />
              <TextField
                label="Individual CRD"
                placeholder="CRD number"
                value={draft.individualCrd}
                inputMode="numeric"
                onChange={(value) => updateDraft({ individualCrd: value })}
              />
            </div>
          </div>
        );
      case "advisory_firm":
        return (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              Kai only asks for firm IAPD / IARD when you explicitly choose the manual fallback path.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Advisory firm name"
                placeholder="Registered advisory firm name"
                value={draft.advisoryFirmName}
                onChange={(value) => updateDraft({ advisoryFirmName: value })}
              />
              <TextField
                label="Firm IAPD / IARD"
                placeholder="IAPD / IARD number"
                value={draft.advisoryFirmIapdNumber}
                inputMode="numeric"
                onChange={(value) => updateDraft({ advisoryFirmIapdNumber: value })}
              />
            </div>
          </div>
        );
      case "broker_firm":
        return (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Broker firm name"
              placeholder="Registered broker-dealer name"
              value={draft.brokerFirmName}
              onChange={(value) => updateDraft({ brokerFirmName: value })}
            />
            <TextField
              label="Firm CRD"
              placeholder="Broker-dealer firm CRD"
              value={draft.brokerFirmCrd}
              inputMode="numeric"
              onChange={(value) => updateDraft({ brokerFirmCrd: value })}
            />
          </div>
        );
      case "public_profile":
        return (
          <div className="space-y-4">
            <TextField
              label="Headline"
              placeholder="Tax-aware wealth planning for cross-border founders"
              value={draft.headline}
              onChange={(value) => updateDraft({ headline: value })}
            />
            <label className="space-y-2">
              <span className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Short strategy summary
              </span>
              <PopupTextEditorField
                title="Short strategy summary"
                description="Describe the style and specialization investors should understand in one calm, credible paragraph."
                value={draft.strategySummary}
                placeholder="Describe the style and specialization investors should understand in one calm, credible paragraph."
                previewPlaceholder="Add the short strategy summary"
                onSave={(value) => updateDraft({ strategySummary: value })}
                triggerClassName="min-h-[112px] rounded-[22px]"
              />
            </label>
          </div>
        );
      case "review":
        return (
          <div className="space-y-5">
            {notice ? (
              <div className="rounded-[24px] border border-emerald-500/20 bg-emerald-500/8 px-4 py-4 text-sm text-foreground">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-500" />
                  <p className="leading-6">{notice}</p>
                </div>
              </div>
            ) : null}

            <SettingsGroup
              embedded
              eyebrow="Capabilities"
              title="The professional lanes Kai will activate"
            >
              <SettingsRow
                title={capabilityLabels.length > 0 ? capabilityLabels.join(" + ") : "None selected"}
                description="Advisory unlocks the current workspace. Brokerage remains a separate trust lane."
              />
            </SettingsGroup>

            <SettingsGroup
              embedded
              eyebrow="Verification"
              title="Regulatory identity Kai will verify"
            >
              <SettingsRow
                title={verifiedIdentity.matchedName || draft.displayName.trim() || "Display name missing"}
                description="Investor-facing professional identity"
              />
              <SettingsRow
                title={verifiedIdentity.matchedName || "Name verification pending"}
                description={`CRD ${verifiedIdentity.crdNumber || "not verified yet"}`}
              />
              {draft.requestedCapabilities.includes("advisory") && verifiedIdentity.currentFirm ? (
                <SettingsRow
                  title={verifiedIdentity.currentFirm || "Advisory firm not returned"}
                  description={`IAPD / IARD ${verifiedIdentity.secNumber || "not returned"}`}
                />
              ) : null}
              {draft.requestedCapabilities.includes("brokerage") ? (
                <SettingsRow
                  title={draft.brokerFirmName.trim() || "Broker firm missing"}
                  description={`Firm CRD ${draft.brokerFirmCrd.trim() || "not provided yet"}`}
                />
              ) : null}
            </SettingsGroup>

            <SettingsGroup
              embedded
              eyebrow="Trust Surface"
              title="What investors will see first"
            >
              <SettingsRow
                title={draft.headline.trim() || "Headline still missing"}
                description="Marketplace and invite headline"
              />
              <SettingsRow
                title={draft.strategySummary.trim() || "Short strategy summary still missing"}
                description="A short, credible summary is enough for onboarding v1."
              />
            </SettingsGroup>

            {advisoryAccessReady ? (
              <div className="rounded-[24px] border border-foreground/10 bg-foreground text-background px-4 py-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4" />
                  <div className="space-y-2">
                    <p className="text-sm font-semibold">Verification passed. Your RIA workspace is ready.</p>
                    <p className="text-sm text-background/78">
                      The trust surface is active, and you can move into investor connections and consent flows.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={ROUTES.RIA_HOME}
                        className="inline-flex min-h-10 items-center justify-center rounded-full bg-background px-4 text-sm font-medium text-foreground"
                      >
                        Open RIA Home
                      </Link>
                      <Link
                        href={ROUTES.RIA_CLIENTS}
                        className="inline-flex min-h-10 items-center justify-center rounded-full border border-background/20 px-4 text-sm font-medium text-background"
                      >
                        Open Clients
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <RiaPageShell
      eyebrow="Professional Onboarding"
      title="Build the advisor trust surface before Kai unlocks the workflow"
      description="A calmer onboarding interview for trust-critical identity, verification records, and the short public profile investors see first."
      nativeTest={{
        routeId: "/ria/onboarding",
        marker: "native-route-ria-onboarding",
        authState: user ? "authenticated" : "pending",
        dataState: loading
          ? "loading"
          : iamUnavailable
            ? "unavailable-valid"
            : "loaded",
        errorCode: error ? "ria_onboarding" : null,
        errorMessage: error,
      }}
    >
      {iamUnavailable ? (
        <RiaCompatibilityState
          title="RIA onboarding is unavailable in this environment"
          description="The UI is ready, but backend activation still requires the IAM migrations and verification tables."
        />
      ) : null}

      {!iamUnavailable ? (
        <div className="space-y-5">
          <SurfaceInset className="space-y-4 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">
                  Trust summary
                </p>
                <h2 className="text-sm font-semibold">Keep the verification state visible, not heavy</h2>
                <p className="max-w-3xl text-sm text-muted-foreground">
                  This summary stays persistent while the wizard keeps attention on one decision at a time.
                </p>
              </div>
              {loading ? (
                <Badge variant="secondary">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Loading
                </Badge>
              ) : (
                <Badge variant="secondary">
                  {formatVerificationStatus(advisoryVerificationStatus, false)}
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {capabilityLabels.length > 0 ? capabilityLabels.join(" + ") : "No capabilities selected"}
              </Badge>
              <Badge variant="secondary">
                {advisoryAccessReady
                  ? "RIA workspace ready"
                  : brokerageAccessReady
                    ? "Broker lane verified"
                    : "Activation still gated"}
              </Badge>
              {draft.displayName.trim() ? (
                <Badge variant="secondary">{draft.displayName.trim()}</Badge>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <ReviewField
                label="Verification"
                value={formatVerificationStatus(advisoryVerificationStatus, loading)}
                helper={latestVerificationCopy(status)}
              />
              {draft.requestedCapabilities.includes("brokerage") ? (
                <ReviewField
                  label="Brokerage"
                  value={formatVerificationStatus(brokerageVerificationStatus, false, "brokerage")}
                  helper="Broker capability stays isolated from advisory access."
                />
              ) : null}
              <ReviewField
                label="Current focus"
                value={`Step ${currentStepIndex + 1} of ${steps.length}`}
                helper={currentStep?.title}
              />
              <ReviewField
                label="Investor identity"
                value={draft.displayName.trim() || user?.displayName || user?.email || "Not set yet"}
                helper="The name carried into invites and consent prompts."
              />
            </div>
          </SurfaceInset>

          <SurfaceCard className="mx-auto w-full max-w-3xl">
            <SurfaceCardHeader className="space-y-4 border-b border-border/60">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">
                  {currentStep?.eyebrow}
                </p>
                <Badge variant="secondary">
                  {currentStepIndex + 1} / {steps.length}
                </Badge>
              </div>
              <div className="space-y-2">
                <h2 className="text-[clamp(1.3rem,3vw,2rem)] font-semibold tracking-tight text-foreground">
                  {currentStep?.title}
                </h2>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  {currentStep?.description}
                </p>
              </div>
              <Progress value={progressValue} className="h-1.5 rounded-full bg-muted" />
            </SurfaceCardHeader>

            <SurfaceCardContent className="space-y-6 pt-6">
              {loading ? (
                <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading RIA onboarding...
                </div>
              ) : !user ? (
                <div className="rounded-[24px] border border-dashed px-4 py-6 text-sm text-muted-foreground">
                  Sign in to continue the RIA onboarding flow.
                </div>
              ) : (
                renderQuestion(currentStep)
              )}

              {error ? (
                <div className="rounded-[24px] border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700">
                  {error}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-5">
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={saving || currentStepIndex === 0}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium transition-colors",
                    currentStepIndex === 0
                      ? "invisible pointer-events-none"
                      : "border border-border bg-background text-foreground hover:bg-muted/40 disabled:opacity-60"
                  )}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </button>

                <div className="flex flex-wrap gap-2">
                  {currentStep.id === "review" && devRiaBypassAllowed && !advisoryAccessReady ? (
                    <button
                      type="button"
                      onClick={() => void handleDevActivate()}
                      disabled={saving}
                      className="inline-flex min-h-11 items-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted/40 disabled:opacity-60"
                    >
                      {saving ? "Activating..." : "Bypass in Dev / UAT"}
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={handleContinue}
                    disabled={loading || !user || !canContinue || saving}
                    className="inline-flex min-h-11 items-center rounded-full bg-foreground px-5 text-sm font-medium text-background disabled:opacity-60"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {currentStep.id === "review" && !advisoryAccessReady
                          ? "Submitting..."
                          : "Saving..."}
                      </>
                    ) : currentStep.id === "review" ? (
                      advisoryAccessReady ? (
                        "Open RIA Home"
                      ) : (
                        "Submit for verification"
                      )
                    ) : (
                      <>
                        Continue
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </SurfaceCardContent>
          </SurfaceCard>

          <SurfaceInset className="space-y-3 px-4 py-4">
            <div className="flex items-start gap-3">
              <ShieldQuestion className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Deferred for later settings</p>
                <p className="text-sm text-muted-foreground">
                  Long bio, disclosures URL, firm role, communication style, and alert cadence now stay out of onboarding so activation feels shorter and clearer.
                </p>
              </div>
            </div>
          </SurfaceInset>
        </div>
      ) : null}
    </RiaPageShell>
  );
}
