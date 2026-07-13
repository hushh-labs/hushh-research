"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, RotateCcw, Trash2 } from "lucide-react";

import {
  RiaCompatibilityState,
  RiaPageShell,
} from "@/components/ria/ria-page-shell";
import { OnboardingStepReview } from "@/components/ria/onboarding/onboarding-step-review";
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
import { useAuth } from "@/hooks/use-auth";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { usePersonaState } from "@/lib/persona/persona-context";
import { RiaService } from "@/lib/services/ria-service";
import { RiaOnboardingDraftLocalService } from "@/lib/services/ria-onboarding-draft-local-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { DeviceResourceCacheService } from "@/lib/services/device-resource-cache-service";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import {
  mapRiaStatusToReviewProps,
  seedRiaDraftFromStatus,
} from "@/lib/ria/ria-profile-view-model";
import {
  normalizeRiaOnboardingDraft,
  type RiaOnboardingDraft,
} from "@/lib/ria/ria-onboarding-flow";
import { buildRiaOnboardingBioSuggestion } from "@/lib/ria/ria-onboarding-prefill";
import { openKaiCommandBar } from "@/lib/navigation/kai-command-bar-events";
import { cn } from "@/lib/utils";

export default function RiaProfilePage() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    riaOnboardingStatus,
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

  // No RIA profile to show → route to onboarding for a clean new-user experience.
  // Covers both "setup" (never onboarded) AND the split-brain case where the
  // persona still reports 'ria' but the profile row is gone (exists:false) — so a
  // stale/resurrected persona can never render a zombie empty profile. Skipped
  // while a delete is in flight (that navigates to One home itself).
  useEffect(() => {
    if (personaLoading || personaRefreshing || deleting) return;
    if (riaCapability === "setup" || riaOnboardingStatus?.exists === false) {
      router.replace(ROUTES.RIA_ONBOARDING);
    }
  }, [
    personaLoading,
    personaRefreshing,
    deleting,
    riaCapability,
    riaOnboardingStatus,
    router,
  ]);

  const reviewProps = useMemo(
    () => mapRiaStatusToReviewProps(riaOnboardingStatus),
    [riaOnboardingStatus],
  );

  const updateDraft = useCallback((patch: Partial<RiaOnboardingDraft>) => {
    setDraft((current) =>
      current ? normalizeRiaOnboardingDraft({ ...current, ...patch }) : current,
    );
  }, []);

  const openServicesEdit = useCallback(() => {
    setDraft(seedRiaDraftFromStatus(riaOnboardingStatus));
    setEditOpen(true);
  }, [riaOnboardingStatus]);

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
  }, [draft, refresh, saving, user]);

  const handleReinitiate = useCallback(() => {
    // Re-run the whole wizard from step 1 (bypasses the switch→profile guard).
    router.push(`${ROUTES.RIA_ONBOARDING}?reinitiate=1`);
  }, [router]);

  const handleOpenEditServices = useCallback(() => {
    if (saving || deleting) {
      return {
        status: "blocked" as const,
        summary: "The RIA profile is busy. Try again when the current update finishes.",
      };
    }
    setEditOpen(true);
    return {
      status: "succeeded" as const,
      summary: "The RIA profile editor is open.",
    };
  }, [deleting, saving]);

  useLocalOnboardingActionHandler("ria.profile.edit_services", handleOpenEditServices);

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

  const isBooting =
    (personaLoading || personaRefreshing) && !riaOnboardingStatus;
  const dataState = isBooting
    ? "loading"
    : riaCapability === "disabled"
      ? "unavailable-valid"
      : "loaded";

  return (
    <RiaPageShell
      width="reading"
      eyebrow="Advisor"
      title="Your RIA profile"
      description="The profile you built during onboarding. Edit the details investors see."
      nativeTest={{
        routeId: "/ria/profile",
        marker: "native-route-ria-profile",
        authState: user ? "authenticated" : "pending",
        dataState,
        errorCode: null,
        errorMessage: null,
      }}
    >
      {isBooting ? (
        <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading profile...
        </div>
      ) : riaCapability === "disabled" ? (
        <RiaCompatibilityState
          title="RIA profile is waiting on the IAM rollout"
          description="This environment needs the IAM schema before your advisor profile can load."
        />
      ) : (
        <OnboardingStepReview
          advisorName={reviewProps.advisorName}
          firmName={reviewProps.firmName}
          crdNumber={reviewProps.crdNumber}
          regulator={reviewProps.regulator}
          regulatorStatus={reviewProps.regulatorStatus}
          certifications={reviewProps.certifications}
          servicesOffered={reviewProps.servicesOffered}
          feeStructure={reviewProps.feeStructure}
          minEngagementAmount={reviewProps.minEngagementAmount}
          bio={reviewProps.bio}
          city={reviewProps.city}
          pinZip={reviewProps.pinZip}
          areaLocality={reviewProps.areaLocality}
          fullStreetAddress={reviewProps.fullStreetAddress}
          advisoryAccessReady={reviewProps.advisoryAccessReady}
          onEditSection={handleEditSection}
          onAskKaiUpdateAnything={handleAskKai}
        />
      )}

      {!isBooting && riaCapability !== "disabled" ? (
        <SettingsGroup
          eyebrow="Manage"
          title="RIA profile"
          testId="ria-profile-manage"
        >
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
      ) : null}

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
              onFeeStructureChange={(fees) =>
                updateDraft({ feeStructure: fees })
              }
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
    </RiaPageShell>
  );
}
