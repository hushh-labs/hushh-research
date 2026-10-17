import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OWNER_CLOUD_TARGETS,
  isAzureHomeSelectable,
  isOwnerCloudTarget,
  ownerCloudProvider,
} from "@/lib/one/owner-cloud";

describe("the owner-cloud question", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
});
