"use client";

import { useState } from "react";

import { AzureCloudCard } from "@/components/connections/azure-cloud-card";
import { ByocCloudCard } from "@/components/connections/byoc-cloud-card";
import { SegmentedControl } from "@/lib/morphy-ux/ui/segmented-control";
import {
  OWNER_CLOUD_PROVIDER_LABELS,
  isAzureHomeSelectable,
  type OwnerCloudProvider,
} from "@/lib/one/owner-cloud";

const PROVIDER_OPTIONS = (["gcp", "azure"] as const).map((value) => ({
  value,
  label: OWNER_CLOUD_PROVIDER_LABELS[value],
}));

function isOwnerCloudProvider(value: string): value is OwnerCloudProvider {
  return value === "gcp" || value === "azure";
}

type OwnerCloudProviderChoiceProps = {
  /** Google Cloud: the named project to authorize. */
  onProjectNamed: (projectId: string) => void | Promise<void>;
  projectBusy?: boolean;
  /** Microsoft Azure: start the Microsoft sign-in. */
  onConnectAzure: () => void | Promise<void>;
  azureBusy?: boolean;
};

/**
 * "Your own cloud" is one choice with two homes. Google Cloud stays the
 * default so the established path is unchanged; Microsoft Azure is one tap away
 * on a build where it is admitted, and absent everywhere else.
 */
export function OwnerCloudProviderChoice({
  onProjectNamed,
  projectBusy = false,
  onConnectAzure,
  azureBusy = false,
}: OwnerCloudProviderChoiceProps) {
  const [provider, setProvider] = useState<OwnerCloudProvider>("gcp");
  if (!isAzureHomeSelectable()) {
    return (
      <div className="space-y-4">
        <ByocCloudCard busy={projectBusy} onProjectNamed={onProjectNamed} />
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="owner-cloud-provider-choice">
      <SegmentedControl
        value={provider}
        onValueChange={(value) => {
          if (isOwnerCloudProvider(value)) setProvider(value);
        }}
        options={PROVIDER_OPTIONS}
        ariaLabel="Your cloud provider"
        className="w-full"
      />
      {provider === "gcp" ? (
        <ByocCloudCard busy={projectBusy} onProjectNamed={onProjectNamed} />
      ) : (
        <AzureCloudCard busy={azureBusy} onConnect={onConnectAzure} />
      )}
    </div>
  );
}
