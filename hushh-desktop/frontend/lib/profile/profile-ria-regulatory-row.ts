import type { RiaOnboardingStatus } from "@/lib/services/ria-service";

export type ProfileRiaRegulatoryRowAction = "wait" | "onboarding" | "refresh";

export type ProfileRiaRegulatoryRowState = {
  action: ProfileRiaRegulatoryRowAction;
  title: string;
  description: string;
  badge: string;
  disabled: boolean;
};

function preferredLicenseNumber(
  status: RiaOnboardingStatus | null,
): string | null {
  const value =
    status?.license_number ||
    status?.individual_crd ||
    status?.finra_crd ||
    status?.advisory_firm_iapd_number ||
    status?.sec_iard ||
    "";
  const normalized = String(value).trim();
  return normalized || null;
}

export function resolveProfileRiaRegulatoryRow(params: {
  loading: boolean;
  status: RiaOnboardingStatus | null;
  error: string | null;
}): ProfileRiaRegulatoryRowState {
  if (params.loading) {
    return {
      action: "wait",
      title: "Regulatory profile",
      description: "Checking official license data.",
      badge: "Checking",
      disabled: true,
    };
  }

  if (params.error) {
    return {
      action: "refresh",
      title: "Regulatory profile",
      description: "Status unavailable. Open to retry official data sync.",
      badge: "Retry",
      disabled: false,
    };
  }

  if (!params.status?.exists) {
    return {
      action: "onboarding",
      title: "Regulatory profile",
      description: "Complete onboarding before syncing official license data.",
      badge: "Setup",
      disabled: false,
    };
  }

  const licenseNumber = preferredLicenseNumber(params.status);
  return {
    action: "refresh",
    title: "Regulatory profile",
    description: licenseNumber
      ? `Update license data for CRD ${licenseNumber}.`
      : "Update official license data from your regulator.",
    badge: "Update",
    disabled: false,
  };
}

export function getProfileRiaRefreshLicenseNumber(
  status: RiaOnboardingStatus | null,
): string {
  return preferredLicenseNumber(status) || "";
}
