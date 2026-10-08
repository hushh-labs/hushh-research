"use client";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { RuntimeProviderMark } from "@/components/brand/runtime-provider-mark";
import { OpenAiKeyCard, type OpenAiKeyCardProps } from "@/components/connections/openai-key-card";
import { KeyRowIcon } from "@/components/icons";
import {
  useRuntimeProviderCatalog,
  type ResolvedRuntimeProvider,
} from "@/lib/connections/runtime-provider-catalog-client";

function ProviderRow({ provider, testId, description }: {
  provider: ResolvedRuntimeProvider;
  testId: string;
  description?: string;
}) {
  return (
    <SettingsRow
      {...(provider.mark
        ? { leading: <RuntimeProviderMark provider={provider.mark} className="!h-8 !w-8" /> }
        : { icon: KeyRowIcon, iconTone: "capability" as const })}
      title={provider.name}
      description={description}
      disabled
      testId={testId}
    />
  );
}

/**
 * Bring your own AI, beyond Gemini, in the settings context only. The server
 * catalog decides what is offered; a provider or method this build cannot
 * configure is shown, never selectable, and its saved Vault values are left
 * exactly as they are.
 */
export function BringYourOwnAiProviders(props: Omit<OpenAiKeyCardProps, "defaultModel">) {
  const catalog = useRuntimeProviderCatalog().filter((provider) => provider.id !== "gemini");
  const openai = catalog.find((provider) => provider.id === "openai" && provider.state === "configurable");
  const comingSoon = catalog.filter((provider) => provider.state === "coming_soon");
  const newer = catalog.filter((provider) => provider.state === "newer_version");
  return (
    <>
      {openai ? <OpenAiKeyCard {...props} defaultModel={openai.defaultModel} /> : null}
      {comingSoon.length ? (
        <SettingsGroup title="Coming soon" testId="profile-coming-soon-runtime" separatorInset>
          {comingSoon.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} testId={`profile-coming-soon-${provider.id}`} />
          ))}
        </SettingsGroup>
      ) : null}
      {newer.length ? (
        <SettingsGroup title="More providers" testId="profile-newer-runtime" separatorInset>
          {newer.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              testId={`profile-newer-runtime-${provider.id}`}
              description="Available in a newer version of Hussh."
            />
          ))}
        </SettingsGroup>
      ) : null}
    </>
  );
}
