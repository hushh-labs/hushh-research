"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ClipboardCheck,
  Loader2,
  MessageCircle,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";

import { RiaCompatibilityState } from "@/components/ria/ria-page-shell";
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
import { useAuth } from "@/hooks/use-auth";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { usePersonaState } from "@/lib/persona/persona-context";
import { RiaService, type RiaOnboardingStatus } from "@/lib/services/ria-service";
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
  /** RIA onboarding status (fetched by the host — e.g. the /profile workspace). */
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
        "block max-w-[15rem] text-right text-[14px] leading-snug tracking-normal [overflow-wrap:anywhere] sm:max-w-[20rem]",
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

/**
 * The unified RIA profile management section. Re-homed verbatim from the former
 * `/ria/profile` page so the SAME view / edit / re-initiate / delete / license
 * logic renders inside the main `/profile` "Regulatory profile" panel. The host
 * owns the status fetch (so it works on `/profile` regardless of active persona)
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

  // License-refresh ("Update license data") — folded in from the old /profile
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
  useEffect(() => {
    if (personaLoading || personaRefreshing || deleting || loading) return;
    if (riaCapability === "setup" || status?.exists === false) {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
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

  if (isBooting) {
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

  return (
    <div className="space-y-6">
      <RiaRegulatoryProfileSummary
        reviewProps={reviewProps}
        onEditSection={handleEditSection}
        onAskKaiUpdateAnything={handleAskKai}
      />

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
              investor data are not affected. This can&apos;t be undone.
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
