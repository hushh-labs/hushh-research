"use client";

import { useEffect, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ScopeTariffEditor, type SharingPriceReviewRequest } from "@/components/consent/scope-tariff-editor";
import { useCommerceSession } from "@/components/consent/use-commerce-session";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useVault } from "@/lib/vault/vault-context";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { buildPkmShareBundles } from "@/lib/profile/pkm-memory-tree";
import { sharingPriceTargets } from "@/lib/profile/pkm-sharing-price-review";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";

export type PkmSharingChange = { domain: string; manifest: DomainManifest; scopeHandles: string[]; enabled: boolean };

/** Domain and chat use the same listing controls and exact catalogued tariffs. */
export function PkmDomainSharing({ userId, title, manifest, pendingKey, onChange, proposal, heading = "Sharing and price", onPaymentsNavigate }: {
  userId: string; title: string; manifest: DomainManifest; pendingKey: string | null;
  onChange: (change: PkmSharingChange) => Promise<void>; proposal?: SharingPriceReviewRequest;
  heading?: string;
  onPaymentsNavigate?: () => boolean;
}) {
  const { user, capture } = useCommerceSession(`domain-sharing:${userId}:${manifest.domain}:${manifest.manifest_version}`);
  const { vaultOwnerToken, isVaultUnlocked } = useVault();
  const [catalog, setCatalog] = useState<ReadonlyArray<Record<string, unknown>>>([]);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const bundles = buildPkmShareBundles(manifest);
  const targets = sharingPriceTargets(manifest, catalog);
  const sections = bundles.filter(bundle => targets.some(target => target.scopeHandle === bundle.scopeHandle &&
    target.machineScope === `attr.${manifest.domain}.${bundle.topLevelScopePath}.*`));
  const handles = sections.map(section => section.scopeHandle!);
  const whole = targets.find(target => target.machineScope === `attr.${manifest.domain}.*`);
  const available = sections.length > 0 && sections.every(section => section.enabled);
  const valid = Boolean(user?.uid === userId && isVaultUnlocked && vaultOwnerToken &&
    (!manifest.user_id || manifest.user_id === userId) && Number.isSafeInteger(manifest.manifest_version) && manifest.manifest_version > 0);

  useEffect(() => {
    let active = true;
    const current = capture();
    setCatalog([]); setChecking(true); setFailed(false);
    if (!valid || !vaultOwnerToken) { setChecking(false); return; }
    void PersonalKnowledgeModelService.getAvailableScopes(userId, vaultOwnerToken).then(result => {
      if (!active || !current()) return;
      if (result.userId !== userId) throw new Error("Owner changed.");
      setCatalog(result.scopeEntries ?? []);
    }).catch(() => { if (active && current()) setFailed(true); })
      .finally(() => { if (active && current()) setChecking(false); });
    return () => { active = false; };
  }, [userId, vaultOwnerToken, valid, manifest.domain, manifest.manifest_version, capture, retry]);

  if (!valid) return null;
  if (!sections.length) return <p role="status" className="text-sm text-muted-foreground">Sharing choices are unavailable for this area.</p>;
  return <section className="space-y-3" aria-label={`Sharing and price for ${title}`}>
    <p data-pkm-body="true" className="text-sm text-muted-foreground">Choose what people can request. Every recipient still needs your approval.</p>
    <SettingsGroup title={heading} separatorInset>
      {sections.length > 1 ? <SettingsRow title={`${title} bundle`} description={available ? "All sections available to request" : "Some sections are private"}
        trailingInteractive stackTrailingOnMobile trailing={<Switch checked={available} disabled={Boolean(pendingKey)}
          aria-label={`Make ${title} bundle available to request`} onCheckedChange={enabled => void onChange({ domain: manifest.domain, manifest, scopeHandles: handles, enabled })} />} /> : null}
      {checking ? <SettingsRow title="Checking bundle price…" /> : whole && !failed ? <SettingsRow title="Whole bundle price" description="Applies only when someone requests the whole bundle. Section prices stay separate."
        trailingInteractive stackTrailingOnMobile trailing={<ScopeTariffEditor key={`${userId}:${manifest.manifest_version}:${whole.scopeHandle}`} scopeHandle={whole.scopeHandle}
          machineScope={whole.machineScope} label={`${title} bundle`} showSavedPrice reviewRequest={proposal} onPaymentsNavigate={onPaymentsNavigate} />} /> : null}
      {sections.map(section => {
        const target = targets.find(item => item.scopeHandle === section.scopeHandle && item.machineScope === `attr.${manifest.domain}.${section.topLevelScopePath}.*`)!;
        return <SettingsRow key={target.machineScope} title={section.label} description={section.enabled ? "Available to request · Ask first" : "Private · Allow requests before changing its price"}
          trailingInteractive stackTrailingOnMobile trailing={<div className="flex flex-wrap items-center justify-end gap-2">
            <ScopeTariffEditor key={`${userId}:${target.scopeHandle}:${target.machineScope}`} scopeHandle={target.scopeHandle} machineScope={target.machineScope} label={`${title} · ${section.label}`} showSavedPrice onPaymentsNavigate={onPaymentsNavigate} />
            <Switch checked={section.enabled} disabled={Boolean(pendingKey)} aria-label={`${section.enabled ? "Make private" : "Ask before sharing"} ${section.label}`}
              onCheckedChange={enabled => void onChange({ domain: manifest.domain, manifest, scopeHandles: [target.scopeHandle], enabled })} />
          </div>} />;
      })}
    </SettingsGroup>
    {failed ? <div role="status" className="text-sm text-muted-foreground">Whole-bundle availability could not be checked. <Button data-pkm-utility="true" variant="link" onClick={() => setRetry(value => value + 1)}>Retry bundle availability</Button></div> : !checking && !whole ?
      <p data-pkm-helper="true" className="text-xs text-muted-foreground">Set section prices above. A whole-bundle price appears when that bundle is available to request.</p> : null}
  </section>;
}
