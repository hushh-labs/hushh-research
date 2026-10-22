"use client";

import { RadioGroup as RadioPrimitive } from "radix-ui";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { Cloud } from "@/components/icons/legacy-ui-icons";
import { MicrosoftAzureLogo } from "@/components/brand/microsoft-azure-logo";
import { GoogleCloudLogo } from "@/components/brand/google-cloud-logo";
import { Badge } from "@/components/ui/badge";
import type { useAiPlacement } from "@/lib/connections/use-ai-placement";
import type { RuntimeCredentialMode } from "@/lib/services/personal-knowledge-model-service";

type CloudAiChoiceProps = {
  placement: ReturnType<typeof useAiPlacement>["placement"];
  title: string;
  disabled: boolean;
  requiresExplicitSelection: boolean;
  selectedOption: string;
  mode: RuntimeCredentialMode;
  hasExplicitSelection: boolean;
  otherProvider: boolean;
  cloudAiVerified: boolean;
  onSelect: () => void;
};

export function CloudAiChoice({ placement, title, disabled, requiresExplicitSelection, selectedOption, mode, hasExplicitSelection, otherProvider, cloudAiVerified, onSelect }: CloudAiChoiceProps) {
  return (
            <SettingsRow
              asChild
              leading={
                placement === "azure" ? <MicrosoftAzureLogo decorative className="h-8 w-8" />
                  : placement === "gcp" ? <GoogleCloudLogo decorative className="h-8 w-8" /> : (
                  <Cloud aria-hidden="true" className="h-8 w-8" />
                )
              }
              title={title}
              disabled={disabled}
              description={
                placement === "azure"
                  ? `Azure AI · ${cloudAiVerified ? "Verified" : "Check connection"}`
                  : placement === "gcp"
                    ? `Vertex AI · ${cloudAiVerified ? "Verified" : "Check connection"}`
                    : placement === "shared"
                      ? "Managed for you. No key needed."
                      : placement === "pending"
                        ? "Your cloud setup is still finishing."
                        : placement === "loading"
                          ? "Checking your hosting…"
                          : "Reconnect your hosting to choose its AI."
              }
              // The default we want people to take. Until it is chosen the row says
              // so out loud, so the fast path is the obvious one rather than the one
              // you work out by elimination.
              trailing={
                requiresExplicitSelection ? (
                  <span
                    aria-hidden
                    className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground"
                  >
                    {selectedOption === "hushh_managed_vertex" ? (
                      <span className="size-3 rounded-full bg-primary" />
                    ) : null}
                  </span>
                ) : mode === "hushh_managed_vertex" &&
                  hasExplicitSelection &&
                  !otherProvider ? (
                  <Badge variant="secondary">Selected</Badge>
                ) : (
                  <Badge variant="outline">Recommended</Badge>
                )
              }
              testId="profile-managed-runtime"
            >
              {requiresExplicitSelection ? (
                <RadioPrimitive.Item
                  value="hushh_managed_vertex"
                  disabled={disabled}
                  onClick={onSelect}
                />
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={onSelect}
                  aria-pressed={mode === "hushh_managed_vertex"}
                />
              )}
            </SettingsRow>
  );
}
