"use client";

import { SpinnerGapIcon as Loader2 } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Switch } from "@/components/ui/switch";
import { ScopeTariffEditor } from "@/components/consent/scope-tariff-editor";
import { consentScopeForPermission } from "@/lib/personal-knowledge-model/slice-publishing";
import { buildPkmShareBundles, pkmShareBundleState } from "@/lib/profile/pkm-memory-tree";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";

type Props = {
  userId: string;
  active: boolean;
  domains: ReadonlyArray<{ key: string; displayName: string }>;
  sharingManifests: Record<string, DomainManifest | null>;
  sharingManifestsLoading: boolean;
  retrySharing: () => void;
  sharingActionKey: string | null;
  isVaultUnlocked: boolean;
  exportBusy: boolean;
  exportStatus: string | null;
  exportError: string | null;
  handleExportMemory: () => Promise<void>;
  updateSharingBundles: (params: { domain: string; manifest: DomainManifest; scopeHandles: string[]; enabled: boolean }) => Promise<void>;
};

/** Saved section controls reuse the existing exact-scope owner mutations. */
export function PkmSavedSharing({ userId, active, domains, sharingManifests, sharingManifestsLoading, retrySharing, sharingActionKey, isVaultUnlocked, exportBusy, exportStatus, exportError, handleExportMemory, updateSharingBundles }: Props) {
  const sharingUnavailable = domains.some(domain => !sharingManifests[domain.key]);
  return (
          <div className="space-y-4 pb-1 pr-px" data-pkm-memory-sharing="true">
            <p className="px-1 text-sm text-muted-foreground">Sharing and prices apply to each section below. Every requester still needs your approval.</p>
            {sharingManifestsLoading ? (
              <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking sharing settings…
              </p>
            ) : null}

            <SettingsGroup separatorInset testId="memory-export-group">
              <SettingsRow
                title={exportBusy ? "Preparing…" : "Download Memory"}
                description={isVaultUnlocked
                  ? "Readable file. Keep it private."
                  : "Unlock to download."}
                onClick={() => void handleExportMemory()}
                disabled={!isVaultUnlocked || exportBusy}
                trailing={exportBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : undefined}
                ariaLabel="Download Memory"
                testId="memory-export-button"
              />
            </SettingsGroup>

            {exportStatus ? (
              <p className="px-1 text-sm text-muted-foreground" role="status">
                {exportStatus}
              </p>
            ) : null}
            {exportError ? (
              <p className="px-1 text-sm text-[color:var(--app-destructive)]" role="alert">
                {exportError}
              </p>
            ) : null}

            {!sharingManifestsLoading &&
              domains.map((domain) => {
                const manifest = sharingManifests[domain.key] || null;
                const bundles = buildPkmShareBundles(manifest);
                if (!manifest || bundles.length === 0) return null;
                const state = pkmShareBundleState(bundles);
                const allHandles = bundles
                  .map((bundle) => bundle.scopeHandle)
                  .filter((value): value is string => Boolean(value));
                const allBusy = sharingActionKey === `${domain.key}:${allHandles.join(",")}`;
                return (
                  <SettingsGroup
                    key={domain.key}
                    title={domain.displayName}
                    separatorInset
                    testId={`memory-sharing-${domain.key}`}
                    titleAction={
                      bundles.length > 1 && allHandles.length > 0 ? (
                        <button
                          type="button"
                          disabled={allBusy}
                          aria-pressed={state === "checked"}
                          aria-label={`Set every ${domain.displayName} item ${
                            state === "checked" ? "private" : "to ask before sharing"
                          }`}
                          onClick={() =>
                            void updateSharingBundles({
                              domain: domain.key,
                              manifest,
                              scopeHandles: allHandles,
                              enabled: state !== "checked",
                            })
                          }
                          className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                        >
                          {allBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : null}
                          {state === "checked" ? "Make all private" : "Ask for all"}
                        </button>
                      ) : undefined
                    }
                  >
                    {bundles.map((bundle) => {
                      const bundleKey = `${domain.key}:${bundle.scopeHandle || bundle.topLevelScopePath}`;

  return (
                        <SettingsRow
                          key={bundleKey}
                          title={bundle.label}
                          description={bundle.enabled ? "Ask before sharing" : "Private"}
                          stackTrailingOnMobile
                          trailingInteractive
                          trailing={
                            <div className="flex flex-wrap items-center justify-end gap-2">
                            {bundle.scopeHandle && active ? <ScopeTariffEditor
                              key={`${userId}:${bundle.scopeHandle}:${bundle.topLevelScopePath}`}
                              scopeHandle={bundle.scopeHandle}
                              machineScope={consentScopeForPermission(domain.key, bundle.topLevelScopePath)}
                              label={`${domain.displayName} · ${bundle.label}`}
                              showSavedPrice
                            /> : null}
                            <Switch
                              checked={bundle.enabled}
                              disabled={sharingActionKey === bundleKey || !bundle.scopeHandle}
                              onCheckedChange={(enabled) =>
                                bundle.scopeHandle &&
                                void updateSharingBundles({
                                  domain: domain.key,
                                  manifest,
                                  scopeHandles: [bundle.scopeHandle],
                                  enabled,
                                })
                              }
                              aria-label={`${bundle.enabled ? "Make private" : "Ask before sharing"} ${bundle.label}`}
                            />
                            </div>
                          }
                        />
                      );
                    })}
                  </SettingsGroup>
                );
              })}

            {!sharingManifestsLoading && sharingUnavailable ? (
              <div className="px-1 text-sm text-muted-foreground" role="status">
                <p>Some sharing settings could not be checked. Try again before changing access.</p>
                <button type="button" className="min-h-11 underline" onClick={retrySharing}>Retry sharing settings</button>
              </div>
            ) : null}

            {!sharingManifestsLoading && !sharingUnavailable &&
            domains.length > 0 &&
            Object.values(sharingManifests).every(
              (manifest) => buildPkmShareBundles(manifest).length === 0,
            ) ? (
              <p className="px-1 text-sm text-muted-foreground">Nothing to share yet.</p>
            ) : null}
          </div>
  );
}
