"use client";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { VOICE_ENGINE_DOMAINS, type VoiceEngineDomainKey } from "@/lib/agent/voice-engine-domains";

/** Presentation only; the preferences owner commits the existing restriction. */
export function VoiceControlDomainsGroup({
  enabled,
  disabledDomains,
  onDomainChange,
}: {
  enabled: boolean;
  disabledDomains: readonly string[];
  onDomainChange: (domain: VoiceEngineDomainKey, allowed: boolean) => void;
}) {
  return (
    <SettingsGroup
      title="What voice can control"
      description="Turn a domain off to block voice there; tap still works."
      rowSizing="uniform"
      testId="voice-control-domains"
    >
      {VOICE_ENGINE_DOMAINS.map((domain) => (
        <SettingsRow
          key={domain.key}
          title={domain.label}
          description={domain.description}
          disabled={!enabled || !domain.enforced}
          trailing={domain.enforced ? (
            <Switch
              checked={!disabledDomains.includes(domain.key)}
              disabled={!enabled}
              onCheckedChange={(allowed) => onDomainChange(domain.key, allowed)}
              aria-label={domain.label}
            />
          ) : <Badge variant="secondary">Coming soon</Badge>}
        />
      ))}
    </SettingsGroup>
  );
}
