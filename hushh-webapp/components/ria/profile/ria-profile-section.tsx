"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  MessageCircle,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  RiaCompatibilityState,
  isRiaVerified,
} from "@/components/ria/ria-page-shell";
import {
  RiaSecRecordSection,
  type RiaSecAdvisorRecord,
  type RiaSecFirmRecord,
} from "@/components/ria/profile/ria-sec-record-section";
import { OnboardingStepServices } from "@/components/ria/onboarding/onboarding-step-services";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProseMarkdown } from "@/components/research/prose-markdown";
import { useAuth } from "@/hooks/use-auth";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { usePersonaState } from "@/lib/persona/persona-context";
import {
  RiaService,
  type RiaDossier,
  type RiaOnboardingStatus,
} from "@/lib/services/ria-service";
import { RiaOnboardingDraftLocalService } from "@/lib/services/ria-onboarding-draft-local-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { DeviceResourceCacheService } from "@/lib/services/device-resource-cache-service";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import {
  mapRiaStatusToReviewProps,
  seedRiaDraftFromStatus,
} from "@/lib/ria/ria-profile-view-model";
import { getProfileRiaRefreshLicenseNumber } from "@/lib/profile/profile-ria-regulatory-row";
import {
  normalizeRiaOnboardingDraft,
  type RiaOnboardingDraft,
} from "@/lib/ria/ria-onboarding-flow";
import { buildRiaOnboardingBioSuggestion } from "@/lib/ria/ria-onboarding-prefill";
import { openKaiCommandBar } from "@/lib/navigation/kai-command-bar-events";
import { cn } from "@/lib/utils";

export interface RiaProfileSectionProps {
  /** RIA onboarding status (fetched by the host — e.g. the /one/profile workspace). */
  status: RiaOnboardingStatus | null;
  /** True while the host is (re)loading the status. */
  loading?: boolean;
  /** Re-pull the RIA onboarding status from the host after a mutation. */
  onRefresh: (force?: boolean) => unknown;
}

type RiaProfileReviewSummary = ReturnType<typeof mapRiaStatusToReviewProps>;

function formatRiaDisplayValue(value: string | number | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized || "Not provided";
}

function formatRiaListValue(values: readonly string[] | null | undefined) {
  const normalized = (values || [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized.join(", ") : "Not provided";
}

function ProfileSummaryValue({
  children,
  muted = false,
}: {
  children: string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        // Mobile values stack below labels, so wrapped text should align left.
        "block max-w-full text-left text-[14px] leading-snug tracking-normal [overflow-wrap:anywhere] sm:max-w-[20rem] sm:text-right",
        muted ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {children}
    </span>
  );
}

function RiaProfileSummaryRow({
  title,
  value,
  testId,
}: {
  title: string;
  value: string;
  testId: string;
}) {
  const displayValue = formatRiaDisplayValue(value);
  return (
    <SettingsRow
      title={title}
      trailing={
        <ProfileSummaryValue muted={displayValue === "Not provided"}>
          {displayValue}
        </ProfileSummaryValue>
      }
      stackTrailingOnMobile
      testId={testId}
    />
  );
}

function RiaRegulatoryProfileSummary({
  reviewProps,
  onEditSection,
  onAskKaiUpdateAnything,
}: {
  reviewProps: RiaProfileReviewSummary;
  onEditSection: (section: "license" | "services") => void;
  onAskKaiUpdateAnything: () => void;
}) {
  const certifications = formatRiaListValue(reviewProps.certifications);
  const services = formatRiaListValue(reviewProps.servicesOffered);
  const fees = formatRiaListValue(reviewProps.feeStructure);
  const advisorAccess = reviewProps.advisoryAccessReady ? "Ready" : "Pending";

  return (
    <div className="space-y-4">
      <SettingsGroup testId="ria-profile-assistant">
        <SettingsRow
          icon={MessageCircle}
          iconTone="blue"
          title="Ask Kai to update anything"
          description="Open Kai and describe what should change in this profile."
          onClick={onAskKaiUpdateAnything}
          chevron
          testId="ria-profile-ask-kai"
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Profile" title="Licence" testId="ria-profile-licence-summary">
        <RiaProfileSummaryRow
          title="Advisor"
          value={reviewProps.advisorName}
          testId="ria-profile-summary-advisor"
        />
        <RiaProfileSummaryRow
          title="Firm"
          value={reviewProps.firmName}
          testId="ria-profile-summary-firm"
        />
        <RiaProfileSummaryRow
          title="CRD"
          value={reviewProps.crdNumber}
          testId="ria-profile-summary-crd"
        />
        <RiaProfileSummaryRow
          title="Regulator"
          value={reviewProps.regulator}
          testId="ria-profile-summary-regulator"
        />
        <RiaProfileSummaryRow
          title="Status"
          value={reviewProps.regulatorStatus || advisorAccess}
          testId="ria-profile-summary-status"
        />
        <RiaProfileSummaryRow
          title="Certifications"
          value={certifications}
          testId="ria-profile-summary-certifications"
        />
        <SettingsRow
          icon={Pencil}
          title="Edit licence information"
          description="Re-run licence verification from onboarding."
          onClick={() => onEditSection("license")}
          chevron
          testId="ria-profile-edit-license"
        />
      </SettingsGroup>

      <SettingsGroup title="Services" testId="ria-profile-services-summary">
        <RiaProfileSummaryRow
          title="Services"
          value={services}
          testId="ria-profile-summary-services"
        />
        <RiaProfileSummaryRow
          title="Fees"
          value={fees}
          testId="ria-profile-summary-fees"
        />
        <RiaProfileSummaryRow
          title="Min engagement"
          value={reviewProps.minEngagementAmount}
          testId="ria-profile-summary-min-engagement"
        />
        <SettingsRow
          title="Bio"
          description={formatRiaDisplayValue(reviewProps.bio)}
          testId="ria-profile-summary-bio"
        />
        <SettingsRow
          icon={Pencil}
          title="Edit services"
          description="Update services, fees, bio, and minimum engagement."
          onClick={() => onEditSection("services")}
          chevron
          testId="ria-profile-edit-services"
        />
      </SettingsGroup>

      <SettingsGroup title="Location" testId="ria-profile-location-summary">
        <RiaProfileSummaryRow
          title="City"
          value={reviewProps.city}
          testId="ria-profile-summary-city"
        />
        <RiaProfileSummaryRow
          title="Area"
          value={reviewProps.areaLocality}
          testId="ria-profile-summary-area"
        />
        <RiaProfileSummaryRow
          title="Address"
          value={reviewProps.fullStreetAddress}
          testId="ria-profile-summary-address"
        />
        <RiaProfileSummaryRow
          title="PIN / ZIP"
          value={reviewProps.pinZip}
          testId="ria-profile-summary-pin-zip"
        />
        <SettingsRow
          icon={Pencil}
          title="Edit location"
          description="Update your public business location."
          onClick={() => onEditSection("services")}
          chevron
          testId="ria-profile-edit-location"
        />
      </SettingsGroup>
    </div>
  );
}

function asRecord<T>(value: unknown): T | null {
  return value && typeof value === "object" ? (value as T) : null;
}

function hasSecRecords(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(metadata && (metadata.firm_record || metadata.advisor_record));
}

/**
 * The metadata snapshot the SEC record section renders from. The durable claim
 * event wins; the generic verification event only qualifies when it actually
 * carries the firm/adviser records (older rows can be a bare license check).
 */
function resolveSecRecordMetadata(
  status: RiaOnboardingStatus | null,
): Record<string, unknown> | null {
  const claimMetadata = status?.latest_claim_event?.reference_metadata;
  if (hasSecRecords(claimMetadata)) return claimMetadata ?? null;
  const verificationMetadata =
    status?.latest_verification_event?.reference_metadata;
  if (hasSecRecords(verificationMetadata)) return verificationMetadata ?? null;
  return null;
}

function RiaVerificationChip({ verified }: { verified: boolean }) {
  return (
    <span
      data-testid="ria-profile-verification-chip"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] font-medium",
        verified
          ? "border-[rgba(18,161,80,0.35)] bg-[rgba(18,161,80,0.08)] text-[#12A150]"
          : "border-[rgba(201,139,46,0.3)] bg-[rgba(201,139,46,0.08)] text-[color:var(--ria-gold,#C8923A)]",
      )}
    >
      {verified ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <ShieldCheck className="h-3.5 w-3.5" />
      )}
      {verified ? "Verified" : "Not verified"}
    </span>
  );
}

/**
 * The "finish verification" nudge: type the work email once, get a code, type
 * the code. Success flips the chip via the host refresh; a mail-queue failure
 * is retryable (best-effort transport never blocks); a profile without a claim
 * snapshot (409 CLAIM_CONTEXT_MISSING) hides the card entirely.
 */
function RiaEmailVerifyCard({ onVerified }: { onVerified: () => Promise<void> }) {
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  const handleSend = useCallback(async () => {
    if (!user || busy) return;
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    setSendFailed(false);
    try {
      const idToken = await user.getIdToken();
      const result = await RiaService.claimEmailStart(idToken, {
        email: address,
      });
      if (result.status === "send_failed") {
        setSendFailed(true);
        return;
      }
      setPhase("code");
    } catch (err) {
      if ((err as { code?: unknown })?.code === "CLAIM_CONTEXT_MISSING") {
        setHidden(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, email, user]);

  const handleVerify = useCallback(async () => {
    if (!user || busy) return;
    const trimmed = code.trim();
    if (trimmed.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const result = await RiaService.claimEmailConfirm(idToken, {
        email: email.trim(),
        code: trimmed,
      });
      if (result.verified) {
        toast.success("Email verified");
        await onVerified();
        return;
      }
      setError("Not verified yet.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, code, email, onVerified, user]);

  if (hidden) return null;

  return (
    <div
      data-testid="ria-email-verify-card"
      className="space-y-3 rounded-[22px] border border-[color:var(--border)] bg-[color:var(--card)] p-4 shadow-[0_8px_24px_rgba(62,48,30,0.05)]"
    >
      <div>
        <p className="text-[15px] font-semibold">Verify with your work email</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          We&apos;ll send a code.
        </p>
      </div>
      {phase === "email" ? (
        <div className="flex items-center gap-2">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@yourfirm.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            data-testid="ria-email-verify-input"
          />
          <Button
            disabled={busy || !email.trim()}
            onClick={() => void handleSend()}
            data-testid="ria-email-verify-send"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : sendFailed ? (
              "Retry"
            ) : (
              "Send code"
            )}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6-digit code"
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            data-testid="ria-email-verify-code"
          />
          <Button
            disabled={busy || code.trim().length !== 6}
            onClick={() => void handleVerify()}
            data-testid="ria-email-verify-confirm"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
          </Button>
        </div>
      )}
      {sendFailed ? (
        <p className="text-[13px] text-destructive">Couldn&apos;t send.</p>
      ) : null}
      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * The background-dossier row. Claiming dispatches a fire-and-forget scan+mail
 * pipeline whose outcome lands in one durable row (`GET /ria/dossier`); this
 * card renders that row's state machine: preparing → open-in-app markdown →
 * retryable failure. The in-app artifact is the record and the mail is a copy
 * ("sent" only means handed to Gmail), so `generated` and `sent` render the
 * same. No row (404) or an unreadable row ⇒ nothing renders; a failed send is
 * always visible with Retry, never silent — same contract as the email card
 * above. `blocked_no_email` is visible but not retryable (there is no address
 * to retry against until the user signs in with one).
 */
function RiaDossierCard() {
  const { user } = useAuth();
  const [dossier, setDossier] = useState<RiaDossier | null>(null);
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const row = await RiaService.getDossier(idToken);
        if (!cancelled) setDossier(row);
      } catch {
        // Best-effort surface: an unreadable row renders nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleRetry = useCallback(async () => {
    if (!user || retrying) return;
    setRetrying(true);
    try {
      const idToken = await user.getIdToken();
      setDossier(await RiaService.retryDossier(idToken));
    } catch {
      // The row keeps its failed status; Retry stays available.
    } finally {
      setRetrying(false);
    }
  }, [retrying, user]);

  if (!dossier) return null;

  const preparing =
    dossier.status === "queued" || dossier.status === "scanning";
  const ready = dossier.status === "generated" || dossier.status === "sent";
  const retryable =
    dossier.status === "scan_failed" ||
    dossier.status === "send_failed" ||
    dossier.status === "send_blocked_test_unset";
  const blocked = dossier.status === "blocked_no_email";
  if (!preparing && !ready && !retryable && !blocked) return null;

  return (
    <div
      data-testid="ria-dossier-card"
      className="space-y-3 rounded-[22px] border border-[color:var(--border)] bg-[color:var(--card)] p-4 shadow-[0_8px_24px_rgba(62,48,30,0.05)]"
    >
      {preparing ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <p className="text-[15px] font-semibold">Preparing your dossier…</p>
        </div>
      ) : null}
      {ready ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px] font-semibold">Your dossier</p>
            <Button
              disabled={!dossier.markdown}
              onClick={() => setOpen((current) => !current)}
              data-testid="ria-dossier-toggle"
            >
              {open ? "Close" : "Open"}
            </Button>
          </div>
          {open && dossier.markdown ? (
            <ProseMarkdown className="text-[14px]">
              {dossier.markdown}
            </ProseMarkdown>
          ) : null}
        </>
      ) : null}
      {retryable || blocked ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">Your dossier</p>
            <p className="mt-0.5 text-[13px] text-destructive">
              Couldn&apos;t send.
            </p>
          </div>
          {retryable ? (
            <Button
              disabled={retrying}
              onClick={() => void handleRetry()}
              data-testid="ria-dossier-retry"
            >
              {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Retry"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The unified RIA profile management section. Re-homed verbatim from the former
 * `/ria/profile` page so the SAME view / edit / re-initiate / delete / license
 * logic renders inside the main `/one/profile` "Regulatory profile" panel. The host
 * owns the status retrieval (so it works on `/one/profile` regardless of active persona)
 * and passes it in; this component owns all the RIA mutations.
 */
export function RiaProfileSection({
  status,
  loading = false,
  onRefresh,
}: RiaProfileSectionProps) {
  const router = useRouter();
  const { user } = useAuth();
  const {
    riaCapability,
    loading: personaLoading,
    refreshing: personaRefreshing,
    refresh,
    switchPersona,
  } = usePersonaState();

  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<RiaOnboardingDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // License-refresh ("Update license data") — folded in from the old /one/profile
  // inline modal so the quick official-field re-sync is not lost in the merge.
  const [showLicense, setShowLicense] = useState(false);
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseRegulator, setLicenseRegulator] = useState("SEC");
  const [refreshingLicense, setRefreshingLicense] = useState(false);
  const [licenseMessage, setLicenseMessage] = useState<string | null>(null);

  // No RIA profile to show → route to onboarding for a clean new-user experience.
  // Covers "setup" (never onboarded) AND the split-brain case where the persona
  // still reports 'ria' but the profile row is gone (exists:false). Skipped while
  // a delete is in flight (that navigates to One home itself) and while loading.
  //
  // ONE attempt only. The onboarding page redirects an established adviser
  // straight back here, so when the two disagree — a stale cached status against
  // a correct persona — an unbounded redirect becomes an infinite bounce that
  // renders as a permanent "Loading profile..." with no network traffic and no
  // console error. After one try we stop redirecting and show the real screen.
  const onboardingRedirectAttemptedRef = useRef(false);
  const [redirectSettled, setRedirectSettled] = useState(false);
  useEffect(() => {
    if (personaLoading || personaRefreshing || deleting || loading) return;
    if (riaCapability !== "setup" && status?.exists !== false) return;
    if (onboardingRedirectAttemptedRef.current) return;
    onboardingRedirectAttemptedRef.current = true;
    router.replace(ROUTES.RIA_ONBOARDING);
    // If the navigation lands, this component unmounts and the timer dies with
    // it. If it bounces back, this fires and the screen stops waiting.
    const timer = window.setTimeout(() => setRedirectSettled(true), 1500);
    return () => window.clearTimeout(timer);
  }, [
    personaLoading,
    personaRefreshing,
    deleting,
    loading,
    riaCapability,
    status,
    router,
  ]);

  const reviewProps = useMemo(
    () => mapRiaStatusToReviewProps(status),
    [status],
  );

  const updateDraft = useCallback((patch: Partial<RiaOnboardingDraft>) => {
    setDraft((current) =>
      current ? normalizeRiaOnboardingDraft({ ...current, ...patch }) : current,
    );
  }, []);

  const openServicesEdit = useCallback(() => {
    setDraft(seedRiaDraftFromStatus(status));
    setEditOpen(true);
  }, [status]);

  const handleEditSection = useCallback(
    (section: "license" | "services") => {
      if (section === "license") {
        // Regulatory/identity fields are verification-derived and read-only here.
        // Re-verification happens in the wizard's licence step.
        router.push(`${ROUTES.RIA_ONBOARDING}?edit=license`);
        return;
      }
      openServicesEdit();
    },
    [openServicesEdit, router],
  );

  const handleAskKai = useCallback(() => {
    openKaiCommandBar();
    toast.info("Kai command opened", {
      description: "Ask Kai what to update, or use Edit on any section.",
    });
  }, []);

  const handleDraftBio = useCallback(() => {
    setDraft((current) => {
      if (!current) return current;
      const suggestion = buildRiaOnboardingBioSuggestion(current);
      if (!suggestion) {
        toast.info("Add more details first", {
          description: "Kai needs services or firm details to draft a bio.",
        });
        return current;
      }
      toast.success("Bio drafted", {
        description: "Review the draft before saving.",
      });
      return normalizeRiaOnboardingDraft({ ...current, bio: suggestion });
    });
  }, []);

  const handleSaveProfile = useCallback(async () => {
    if (!user || !draft || saving) return;
    setSaving(true);
    try {
      const idToken = await user.getIdToken();
      const parsedMin = draft.minEngagementAmount.trim()
        ? Number.parseFloat(draft.minEngagementAmount.replace(/[^0-9.]/g, ""))
        : null;
      await RiaService.updateProfile(idToken, {
        display_name: draft.advisorName.trim() || draft.displayName.trim(),
        bio: draft.bio.trim(),
        strategy: draft.strategySummary.trim(),
        services_offered: draft.servicesOffered,
        fee_structure: draft.feeStructure,
        min_engagement_amount:
          parsedMin != null && Number.isFinite(parsedMin) ? parsedMin : null,
        certifications: draft.certifications,
        contact_email: draft.contactEmail.trim(),
        contact_phone: draft.contactPhone.trim(),
        business_city: draft.city.trim(),
        business_area: draft.areaLocality.trim(),
        business_address: draft.fullStreetAddress.trim(),
        business_pin_zip: draft.pinZip.trim(),
        business_latitude: draft.latitude ?? undefined,
        business_longitude: draft.longitude ?? undefined,
      });
      await onRefresh(true);
      await refresh({ force: true });
      setEditOpen(false);
      toast.success("Profile updated", {
        description: "Your advisor profile changes are saved.",
      });
    } catch (error) {
      toast.error("Could not save profile", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }, [draft, onRefresh, refresh, saving, user]);

  const handleReinitiate = useCallback(() => {
    // Re-run the whole wizard from step 1 (bypasses the switch→profile guard).
    router.push(`${ROUTES.RIA_ONBOARDING}?reinitiate=1`);
  }, [router]);

  const handleOpenEditServices = useCallback(() => {
    if (saving || deleting) {
      return {
        status: "blocked" as const,
        summary:
          "The RIA profile is busy. Try again when the current update finishes.",
      };
    }
    setEditOpen(true);
    return {
      status: "succeeded" as const,
      summary: "The RIA profile editor is open.",
    };
  }, [deleting, saving]);

  useLocalOnboardingActionHandler(
    "ria.profile.edit_services",
    handleOpenEditServices,
  );

  const openLicenseRefresh = useCallback(() => {
    setLicenseNumber(getProfileRiaRefreshLicenseNumber(status));
    setLicenseRegulator((status?.regulator || "SEC").trim() || "SEC");
    setLicenseMessage(null);
    setShowLicense(true);
  }, [status]);

  const submitLicenseRefresh = useCallback(async () => {
    if (!user || refreshingLicense) return;
    const nextLicense = licenseNumber.trim();
    if (!nextLicense) return;
    setRefreshingLicense(true);
    setLicenseMessage(null);
    try {
      const idToken = await user.getIdToken();
      const result = await RiaService.refreshLicenseProfile(idToken, {
        license_number: nextLicense,
        regulator: licenseRegulator.trim() || undefined,
        force_live_verification: true,
      });
      if (!result.updated) {
        setLicenseMessage(result.message || "Could not update license data.");
        toast.error("Update failed", {
          description: result.message || "Please try again.",
        });
        return;
      }
      await onRefresh(true);
      await refresh({ force: true });
      toast.success("Official RIA information updated.");
      setShowLicense(false);
    } catch (error) {
      setLicenseMessage(
        error instanceof Error ? error.message : "Please try again.",
      );
    } finally {
      setRefreshingLicense(false);
    }
  }, [licenseNumber, licenseRegulator, onRefresh, refresh, refreshingLicense, user]);

  const currentLicenseNumber = getProfileRiaRefreshLicenseNumber(status);
  const verified = isRiaVerified(status?.verification_status);
  const secRecordMetadata = useMemo(
    () => resolveSecRecordMetadata(status),
    [status],
  );
  const claimMetadata = status?.latest_claim_event?.reference_metadata;
  // Email upgrade needs a claim snapshot; v1 gates firm claims out (no adviser
  // name to match an email against).
  const showEmailVerify =
    !verified && Boolean(claimMetadata) && claimMetadata?.claim_type !== "firm";
  const handleEmailVerified = useCallback(async () => {
    await onRefresh(true);
    await refresh({ force: true });
  }, [onRefresh, refresh]);
  const verificationProvider =
    status?.latest_verification_event?.reference_metadata?.provider;
  const currentRegulator =
    status?.regulator ||
    (typeof verificationProvider === "string" ? verificationProvider : "") ||
    "SEC";
  const currentFirm =
    status?.advisory_firm_legal_name ||
    status?.display_name ||
    "Official regulator record";

  const handleDeleteProfile = useCallback(async () => {
    if (!user || deleting) return;
    setDeleting(true);
    try {
      const idToken = await user.getIdToken();
      await RiaService.deleteProfile(idToken);
      // Full RIA client-state teardown so nothing stale survives the delete:
      //  - local onboarding draft (else a re-onboard resumes prefilled with old data)
      //  - in-memory RIA caches (persona, onboarding status, home, clients, ...)
      //  - IndexedDB device caches under the `ria:` prefix (survive cold start)
      await RiaOnboardingDraftLocalService.clear(user.uid).catch(() => {});
      CacheSyncService.onPersonaStateChanged(user.uid);
      await DeviceResourceCacheService.invalidateResourcePrefix(
        user.uid,
        "ria:",
      ).catch(() => {});
      // Drop back to the investor persona (server force-bypasses its 30s cache),
      // re-pull state, then leave the RIA sub-agent for One home.
      await switchPersona("investor").catch(() => null);
      await refresh({ force: true });
      setShowDeleteConfirm(false);
      toast.success("RIA profile deleted", {
        description: "Your One account is unchanged.",
      });
      router.replace(ROUTES.ONE_HOME);
    } catch (error) {
      toast.error("Could not delete profile", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setDeleting(false);
    }
  }, [deleting, refresh, router, switchPersona, user]);

  const isBooting = (personaLoading || personaRefreshing || loading) && !status;

  // When the profile resolves to "setup / no profile", the effect above redirects
  // to onboarding. Render the neutral skeleton (not the empty profile body) until
  // that navigation lands, so the profile never flashes empty before redirecting.
  // `redirectSettled` ends the wait when the navigation never lands, so this is a
  // brief skeleton rather than a dead end.
  const pendingOnboardingRedirect =
    !deleting &&
    !redirectSettled &&
    riaCapability !== "disabled" &&
    (riaCapability === "setup" || status?.exists === false);

  if (isBooting || pendingOnboardingRedirect) {
    return (
      <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading profile...
      </div>
    );
  }

  if (riaCapability === "disabled") {
    return (
      <RiaCompatibilityState
        title="RIA profile is waiting on the IAM rollout"
        description="This environment needs the IAM schema before your advisor profile can load."
      />
    );
  }

  // The redirect to onboarding did not land (the two screens disagree about
  // whether this adviser exists). Say so and offer the way out, instead of
  // spinning forever or rendering an empty profile body.
  if (riaCapability === "setup" || status?.exists === false) {
    return (
      <div className="space-y-4 rounded-[22px] border border-[color:var(--border)] bg-[color:var(--card)] p-5">
        <div>
          <p className="text-[16px] font-semibold">We couldn&apos;t load your profile</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Your adviser profile didn&apos;t come back. Try again, or set it up.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              void onRefresh(true);
              void refresh({ force: true });
            }}
            data-testid="ria-profile-missing-retry"
          >
            Try again
          </Button>
          <Button
            variant="ghost"
            onClick={() => router.push(ROUTES.RIA_ONBOARDING)}
            data-testid="ria-profile-missing-setup"
          >
            Set up profile
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <RiaRegulatoryProfileSummary
        reviewProps={reviewProps}
        onEditSection={handleEditSection}
        onAskKaiUpdateAnything={handleAskKai}
      />

      {secRecordMetadata ? (
        <RiaSecRecordSection
          advisorRecord={asRecord<RiaSecAdvisorRecord>(
            secRecordMetadata.advisor_record,
          )}
          firmRecord={asRecord<RiaSecFirmRecord>(secRecordMetadata.firm_record)}
          headerAccessory={<RiaVerificationChip verified={verified} />}
        />
      ) : null}

      <RiaDossierCard />

      {showEmailVerify ? (
        <RiaEmailVerifyCard onVerified={handleEmailVerified} />
      ) : null}

      <SettingsGroup eyebrow="Manage" title="RIA profile" testId="ria-profile-manage">
        <SettingsRow
          icon={ClipboardCheck}
          iconTone="blue"
          title="Update license data"
          description="Refresh official regulator fields (CRD, regulator). Your bio, services, fees, and contact details stay unchanged."
          onClick={openLicenseRefresh}
          chevron
          testId="ria-profile-update-license"
        />
        <SettingsRow
          icon={RotateCcw}
          title="Re-initiate onboarding"
          description="Run the 5-step setup wizard again. Your profile goes to pending until re-verified; clients stay connected."
          onClick={handleReinitiate}
          chevron
          testId="ria-profile-reinitiate"
        />
        <SettingsRow
          icon={Trash2}
          tone="destructive"
          title="Delete RIA profile"
          description="Remove your RIA profile and disconnect any clients. Your One account stays."
          onClick={() => setShowDeleteConfirm(true)}
          disabled={deleting}
          testId="ria-profile-delete"
        />
      </SettingsGroup>

      <SettingsDetailPanel
        open={editOpen}
        onOpenChange={(open) => {
          if (!open && !saving) setEditOpen(false);
        }}
        title="Edit profile"
        description="Update your services, fees, bio, and business location."
      >
        {draft ? (
          <div className="space-y-6">
            <OnboardingStepServices
              servicesOffered={draft.servicesOffered}
              feeStructure={draft.feeStructure}
              minEngagementAmount={draft.minEngagementAmount}
              bio={draft.bio}
              city={draft.city}
              areaLocality={draft.areaLocality}
              fullStreetAddress={draft.fullStreetAddress}
              pinZip={draft.pinZip}
              onServicesChange={(services) =>
                updateDraft({ servicesOffered: services })
              }
              onFeeStructureChange={(fees) => updateDraft({ feeStructure: fees })}
              onMinEngagementChange={(value) =>
                updateDraft({ minEngagementAmount: value })
              }
              onBioChange={(value) => updateDraft({ bio: value })}
              onCityChange={(value) => updateDraft({ city: value })}
              onAreaLocalityChange={(value) =>
                updateDraft({ areaLocality: value })
              }
              onFullStreetAddressChange={(value) =>
                updateDraft({ fullStreetAddress: value })
              }
              onPinZipChange={(value) => updateDraft({ pinZip: value })}
              onDraftBio={handleDraftBio}
            />
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveProfile}
              className={cn(
                "ria-cta w-full text-[17px]",
                saving && "cursor-not-allowed opacity-40",
              )}
            >
              {saving ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <>
                  Save changes
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        ) : null}
      </SettingsDetailPanel>

      <Dialog open={showLicense} onOpenChange={setShowLicense}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>Update license data</DialogTitle>
          <DialogDescription>
            Refresh official regulator fields. Your bio, services, fees, email,
            phone, and custom profile copy stay unchanged.
          </DialogDescription>
          <div className="rounded-xl border border-border/60 bg-muted/40 p-3 text-sm">
            <p className="font-medium">{currentFirm}</p>
            <p className="text-muted-foreground">
              Current CRD {currentLicenseNumber || "not stored"} - {currentRegulator}
            </p>
          </div>
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="type-footnote text-muted-foreground">License / CRD</span>
              <Input
                value={licenseNumber}
                onChange={(event) => setLicenseNumber(event.target.value)}
                inputMode="numeric"
                placeholder="e.g. 7413463"
              />
            </label>
            <label className="block space-y-1">
              <span className="type-footnote text-muted-foreground">Regulator</span>
              <Input
                value={licenseRegulator}
                onChange={(event) => setLicenseRegulator(event.target.value)}
                placeholder="SEC"
              />
            </label>
          </div>
          {licenseMessage ? (
            <p className="type-footnote text-destructive">{licenseMessage}</p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button
              disabled={refreshingLicense || !licenseNumber.trim()}
              onClick={() => void submitLicenseRefresh()}
            >
              {refreshingLicense ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update official information"
              )}
            </Button>
            <Button variant="ghost" onClick={() => setShowLicense(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={showDeleteConfirm}
        onOpenChange={(open) => {
          if (!deleting) setShowDeleteConfirm(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your RIA profile?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes your RIA advisor profile and automatically disconnects
              any active clients (their consent is revoked). Your One account and
              investor information is not affected. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                if (!deleting) void handleDeleteProfile();
              }}
            >
              {deleting ? "Deleting..." : "Delete profile"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
