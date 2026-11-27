import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OWNER_CLOUD_TARGETS,
  hostedPodDisplayLabel,
  hostedPodProvider,
  isAzureHomeSelectable,
  isByocSelectableOnBuild,
  isHostedAzureMigrationAvailable,
  isHostedPodTierUnderMaintenance,
  isOwnerCloudTarget,
  isPooledSandboxSwitchAvailable,
  isPrivatePodBinding,
  isPuppyLiveOnBuild,
  ownerCloudProvider,
} from "@/lib/one/owner-cloud";

describe("the owner-cloud question", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("labels pooled ACE confidential sandboxes cleanly without advertising legacy GCP->Azure migration", () => {
    expect(hostedPodDisplayLabel("ace")).toBe("Hussh Confidential Sandbox");
    expect(hostedPodProvider("ace")).toBeNull();
  });

  it("separates managed direct bindings from owner-cloud classification", () => {
    expect(isPrivatePodBinding({ deployment_target: "gcp", environment: "dev", hosting_mode: "hussh_hosted" })).toBe(true);
    expect(isPrivatePodBinding({ deployment_target: "azure", environment: "dev", hosting_mode: "hussh_hosted" })).toBe(true);
    expect(isPrivatePodBinding({ deployment_target: "ace", environment: "dev" })).toBe(true);
    expect(isPrivatePodBinding({ deployment_target: "ace", environment: "uat" })).toBe(true);
    for (const binding of [
      { deployment_target: "gcp", environment: "dev" },
      { deployment_target: "azure", environment: "dev" },
      { deployment_target: "ace", environment: "production" },
      { deployment_target: "ace", environment: "dev", hosting_mode: "hussh_hosted" },
      { deployment_target: "ace", environment: "uat", hosting_mode: "hussh_hosted" },
      { deployment_target: "gcp", environment: "uat", hosting_mode: "hussh_hosted" },
      { deployment_target: "azure", environment: "uat", hosting_mode: "hussh_hosted" },
      { deployment_target: "user_gcp", environment: "dev", hosting_mode: "hussh_hosted" },
      { deployment_target: "user_gcp", environment: "dev", hosting_mode: null },
    ]) expect(isPrivatePodBinding(binding)).toBe(false);
  });

  it("names exactly the person's own Google Cloud and Azure homes", () => {
    expect(OWNER_CLOUD_TARGETS).toEqual(["user_gcp", "user_azure"]);
    expect(isOwnerCloudTarget("user_gcp")).toBe(true);
    expect(isOwnerCloudTarget("user_azure")).toBe(true);
  });

  it.each(["gcp", "anypoint", "aws", "user_aws", "", " user_gcp", "USER_AZURE", null, undefined, 1, {}])(
    "refuses %j, failing closed on any near miss",
    (target) => {
      expect(isOwnerCloudTarget(target)).toBe(false);
      expect(ownerCloudProvider(target)).toBeNull();
    },
  );

  it("maps each owner cloud to its provider", () => {
    expect(ownerCloudProvider("user_gcp")).toBe("gcp");
    expect(ownerCloudProvider("user_azure")).toBe("azure");
  });

  it("ships the Azure choice dark until a build admits it", () => {
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "");
    expect(isAzureHomeSelectable()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "true");
    expect(isAzureHomeSelectable()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "1");
    expect(isAzureHomeSelectable()).toBe(true);
  });

  it("admits Azure on the hosted dev lane and nowhere else by environment", () => {
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    expect(isAzureHomeSelectable()).toBe(true);
    for (const env of ["uat", "production", "development", "staging", "", "dev-uat"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
      expect(isAzureHomeSelectable()).toBe(false);
    }
  });

  it("opens Hussh Pods on hosted dev by default while keeping UAT, production, and explicit overrides fail-closed", () => {
    vi.stubEnv("NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE", "");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    expect(isHostedPodTierUnderMaintenance()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE", "1");
    expect(isHostedPodTierUnderMaintenance()).toBe(true);

    for (const env of ["uat", "production", "development", "staging", ""]) {
      vi.stubEnv("NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE", "");
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
      expect(isHostedPodTierUnderMaintenance()).toBe(true);
    }

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE", "0");
    expect(isHostedPodTierUnderMaintenance()).toBe(false);
  });

  it("enables Personal Sandbox switching on hosted dev and uat builds", () => {
    for (const env of ["dev", "uat"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
      expect(isPooledSandboxSwitchAvailable()).toBe(true);
    }

    for (const env of ["production", "development", "staging", "", "dev-uat"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
      expect(isPooledSandboxSwitchAvailable()).toBe(false);
    }
  });

  it("keeps BYOC and Puppy One live in dev while marking them coming soon on UAT and production", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    expect(isByocSelectableOnBuild()).toBe(true);
    expect(isPuppyLiveOnBuild()).toBe(true);

    for (const env of ["uat", "production"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
      expect(isByocSelectableOnBuild()).toBe(false);
      expect(isPuppyLiveOnBuild()).toBe(false);
    }
  });

  it("retires legacy Azure hosted-pod migration whenever Confidential Sandbox cutover is active", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    vi.stubEnv("NEXT_PUBLIC_HOSTED_AZURE_MIGRATION_ENABLED", "1");
    expect(isHostedAzureMigrationAvailable()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    vi.stubEnv("NEXT_PUBLIC_HOSTED_AZURE_MIGRATION_ENABLED", "1");
    expect(isHostedAzureMigrationAvailable()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_HOSTED_AZURE_MIGRATION_ENABLED", "");
    expect(isHostedAzureMigrationAvailable()).toBe(false);
  });
});
