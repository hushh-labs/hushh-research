"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { AzureCloudCard } from "@/components/connections/azure-cloud-card";
import { ByocCloudCard } from "@/components/connections/byoc-cloud-card";
import { GoogleCloudLogo } from "@/components/brand/google-cloud-logo";
import { MicrosoftAzureLogo } from "@/components/brand/microsoft-azure-logo";
import {
  OWNER_CLOUD_PROVIDER_LABELS,
  isAzureHomeSelectable,
  type OwnerCloudProvider,
} from "@/lib/one/owner-cloud";
import { cn } from "@/lib/utils";

const PROVIDERS: readonly { value: OwnerCloudProvider; mark: ReactNode }[] = [
  { value: "gcp", mark: <GoogleCloudLogo decorative className="h-8" /> },
  { value: "azure", mark: <MicrosoftAzureLogo decorative className="h-8 w-8" /> },
];

type OwnerCloudProviderChoiceProps = {
  /** Google Cloud Platform: the named project to authorize. */
  onProjectNamed: (projectId: string) => void | Promise<void>;
  projectBusy?: boolean;
  /** Microsoft Azure: start the Microsoft sign-in. */
  onConnectAzure: () => void | Promise<void>;
  azureBusy?: boolean;
};

/**
 * "Your own cloud" is one choice with two homes. Google Cloud Platform stays the
 * default so the established path is unchanged; Microsoft Azure is one tap away
 * on a build where it is admitted, and absent everywhere else.
 *
 * Two equal cards, each the provider's mark above its full name, side by side at
 * every width: the names wrap inside their card rather than truncating, so the
 * phone layout is the desktop layout, narrower.
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
      <ProviderCards value={provider} onChange={setProvider} />
      {provider === "gcp" ? (
        <ByocCloudCard busy={projectBusy} onProjectNamed={onProjectNamed} />
      ) : (
        <AzureCloudCard busy={azureBusy} onConnect={onConnectAzure} />
      )}
    </div>
  );
}

function ProviderCards({
  value,
  onChange,
}: {
  value: OwnerCloudProvider;
  onChange: (next: OwnerCloudProvider) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (index: number) => {
    const wrapped = (index + PROVIDERS.length) % PROVIDERS.length;
    const next = PROVIDERS[wrapped];
    if (!next) return;
    onChange(next.value);
    buttons.current[wrapped]?.focus();
  };
  // A radio group is one tab stop; the arrows move within it.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    select(index + step);
  };
  return (
    <div role="radiogroup" aria-label="Your cloud provider" className="grid grid-cols-2 gap-3">
      {PROVIDERS.map(({ value: option, mark }, index) => {
        const checked = option === value;
        return (
          <button
            key={option}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option)}
            onKeyDown={(event) => onKeyDown(event, index)}
            data-testid={`owner-cloud-provider-${option}`}
            className={cn(
              "flex min-h-32 flex-col items-center justify-center gap-3 rounded-2xl border p-4",
              "text-center transition-[border-color,background-color,box-shadow] duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
              // The same surfaces as the hosting choice above, so the two steps read as one.
              checked
                ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-tint)] shadow-[0_0_0_1px_var(--app-accent)]"
                : "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default)] shadow-[var(--app-card-shadow-standard)] hover:border-[color:var(--app-accent-border)]",
            )}
          >
            <span className="flex h-8 items-center">{mark}</span>
            {/* Two lines tall on every card, so a name that wraps on a phone never
                lowers its card's mark against the neighbour's. */}
            <span className="flex min-h-10 items-center text-sm font-semibold leading-5">
              {OWNER_CLOUD_PROVIDER_LABELS[option]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
