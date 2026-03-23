"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Database,
  FolderTree,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Vault,
} from "lucide-react";

import { SectionHeader } from "@/components/app-ui/page-sections";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import { PkmJsonTree, PkmManifestTree } from "@/components/profile/pkm-tree-view";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import {
  PersonalKnowledgeModelService,
  type DomainSummary,
  type EncryptedDomainBlob,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import { Button } from "@/lib/morphy-ux/morphy";
import { type DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { useVault } from "@/lib/vault/vault-context";

type DomainInspectorState = {
  manifest: DomainManifest | null;
  encrypted: EncryptedDomainBlob | null;
  decrypted: Record<string, unknown> | null;
  error: string | null;
  loading: boolean;
};

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function PkmExplorerPanel() {
  const { user, loading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();

  const [metadata, setMetadata] = useState<PersonalKnowledgeModelMetadata | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [domainState, setDomainState] = useState<DomainInspectorState>({
    manifest: null,
    encrypted: null,
    decrypted: null,
    error: null,
    loading: false,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrap(forceRefresh = false) {
      if (loading) return;
      if (!user) {
        if (!cancelled) {
          setMetadata(null);
          setSelectedDomain(null);
          setBootstrapLoading(false);
        }
        return;
      }
      if (!isVaultUnlocked || !vaultOwnerToken) {
        if (!cancelled) {
          setMetadata(null);
          setSelectedDomain(null);
          setBootstrapLoading(false);
        }
        return;
      }

      setBootstrapLoading(true);
      setBootstrapError(null);
      try {
        const nextMetadata = await PersonalKnowledgeModelService.getMetadata(
          user.uid,
          forceRefresh,
          vaultOwnerToken
        );
        if (cancelled) return;
        setMetadata(nextMetadata);
        setSelectedDomain((current) => {
          if (current && nextMetadata.domains.some((domain) => domain.key === current)) {
            return current;
          }
          return nextMetadata.domains[0]?.key || null;
        });
      } catch (nextError) {
        if (!cancelled) {
          setBootstrapError(
            nextError instanceof Error ? nextError.message : "Failed to load saved PKM."
          );
        }
      } finally {
        if (!cancelled) {
          setBootstrapLoading(false);
        }
      }
    }

    void loadBootstrap();
    return () => {
      cancelled = true;
    };
  }, [isVaultUnlocked, loading, user, vaultOwnerToken]);

  useEffect(() => {
    let cancelled = false;

    async function loadDomainState() {
      if (!user || !selectedDomain || !vaultKey || !vaultOwnerToken || !isVaultUnlocked) {
        if (!cancelled) {
          setDomainState({
            manifest: null,
            encrypted: null,
            decrypted: null,
            error: null,
            loading: false,
          });
        }
        return;
      }

      setDomainState((current) => ({ ...current, loading: true, error: null }));
      try {
        const [manifest, encrypted, decrypted] = await Promise.all([
          PersonalKnowledgeModelService.getDomainManifest(
            user.uid,
            selectedDomain,
            vaultOwnerToken
          ),
          PersonalKnowledgeModelService.getDomainData(user.uid, selectedDomain, vaultOwnerToken),
          PersonalKnowledgeModelService.loadDomainData({
            userId: user.uid,
            domain: selectedDomain,
            vaultKey,
            vaultOwnerToken,
          }),
        ]);
        if (cancelled) return;
        setDomainState({
          manifest,
          encrypted,
          decrypted,
          error: null,
          loading: false,
        });
      } catch (nextError) {
        if (!cancelled) {
          setDomainState({
            manifest: null,
            encrypted: null,
            decrypted: null,
            error:
              nextError instanceof Error ? nextError.message : "Failed to load saved PKM domain.",
            loading: false,
          });
        }
      }
    }

    void loadDomainState();
    return () => {
      cancelled = true;
    };
  }, [isVaultUnlocked, selectedDomain, user, vaultKey, vaultOwnerToken]);

  const selectedSummary = useMemo<DomainSummary | null>(() => {
    if (!metadata || !selectedDomain) return null;
    return metadata.domains.find((domain) => domain.key === selectedDomain) || null;
  }, [metadata, selectedDomain]);

  const selectedScopeEntries = useMemo(
    () => domainState.manifest?.scope_registry || [],
    [domainState.manifest]
  );

  const selectedPaths = useMemo(() => domainState.manifest?.paths || [], [domainState.manifest]);

  async function handleRefresh() {
    if (!user || !vaultOwnerToken || !isVaultUnlocked) return;

    setBootstrapLoading(true);
    setBootstrapError(null);
    try {
      const nextMetadata = await PersonalKnowledgeModelService.getMetadata(
        user.uid,
        true,
        vaultOwnerToken
      );
      setMetadata(nextMetadata);
      setSelectedDomain((current) => {
        if (current && nextMetadata.domains.some((domain) => domain.key === current)) {
          return current;
        }
        return nextMetadata.domains[0]?.key || null;
      });
    } catch (nextError) {
      setBootstrapError(
        nextError instanceof Error ? nextError.message : "Failed to refresh saved PKM."
      );
    } finally {
      setBootstrapLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <SurfaceInset className="space-y-4 px-4 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <SectionHeader
              eyebrow="Saved PKM"
              title="Nested PKM explorer"
              description="Inspect the actual encrypted domain layout, manifest tree, scope registry, and first-party decrypted preview for this account."
              icon={Database}
              accent="violet"
            />
          </div>
          <Button
            variant="none"
            effect="fade"
            onClick={() => void handleRefresh()}
            disabled={!user || !isVaultUnlocked || bootstrapLoading}
            className="w-full sm:w-auto"
          >
            {bootstrapLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh saved PKM
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {metadata ? <Badge variant="secondary">{metadata.domains.length} domains</Badge> : null}
          {metadata ? (
            <Badge variant="secondary">{metadata.totalAttributes} attributes</Badge>
          ) : null}
          {selectedSummary ? (
            <Badge variant="secondary">Selected: {selectedSummary.displayName}</Badge>
          ) : null}
        </div>

        {!user ? (
          <div className="flex items-center gap-2 text-sm text-amber-700">
            <ShieldAlert className="h-4 w-4" />
            Sign in first to inspect saved PKM data.
          </div>
        ) : null}
        {user && !isVaultUnlocked ? (
          <div className="flex items-center gap-2 text-sm text-amber-700">
            <Vault className="h-4 w-4" />
            Unlock your vault above to load saved PKM data.
          </div>
        ) : null}
        {bootstrapError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
            {bootstrapError}
          </div>
        ) : null}
        <div className="rounded-2xl border bg-muted/30 p-4 text-sm text-muted-foreground">
          Start with the domain list, then expand only the manifest, scopes, or decrypted payload
          sections you need. Everything stays collapsed by default so larger PKM accounts remain
          easy to inspect on smaller screens.
        </div>
      </SurfaceInset>

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <SurfaceInset className="space-y-4 px-4 py-4">
          <SectionHeader
            eyebrow="Domains"
            title="Stored domains"
            description="Pick a domain to inspect how it is organized in the backend."
            icon={FolderTree}
            accent="sky"
          />
          {metadata?.domains.length ? (
            <div className="space-y-3">
              {metadata.domains.map((domain) => {
                const isActive = selectedDomain === domain.key;
                return (
                  <button
                    key={domain.key}
                    type="button"
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                      isActive
                        ? "border-sky-400 bg-sky-50/80"
                        : "border-border bg-background hover:bg-muted/40"
                    }`}
                    onClick={() => setSelectedDomain(domain.key)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{domain.displayName}</p>
                        <p className="text-xs text-muted-foreground">{domain.key}</p>
                      </div>
                      <Badge variant="secondary">{domain.attributeCount}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Updated {formatTimestamp(domain.lastUpdated)}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : (
            <SurfaceCard tone="warning">
              <SurfaceCardContent className="text-sm text-muted-foreground">
                No PKM domains are available yet for this account.
              </SurfaceCardContent>
            </SurfaceCard>
          )}
        </SurfaceInset>

        <div className="space-y-4">
          <SurfaceInset className="space-y-4 px-4 py-4">
            <SectionHeader
              eyebrow="Overview"
              title={selectedSummary?.displayName || "Select a domain"}
              description="Backend organization, segment layout, and scope exposure for the selected saved domain."
              icon={Database}
              accent="violet"
            />
            {selectedSummary ? (
              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
                <SurfaceCard>
                  <SurfaceCardContent className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Last updated
                    </p>
                    <p className="text-sm font-semibold">
                      {formatTimestamp(selectedSummary.lastUpdated)}
                    </p>
                  </SurfaceCardContent>
                </SurfaceCard>
                <SurfaceCard>
                  <SurfaceCardContent className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Storage mode
                    </p>
                    <p className="text-sm font-semibold">
                      {domainState.encrypted?.storageMode || "domain"}
                    </p>
                  </SurfaceCardContent>
                </SurfaceCard>
                <SurfaceCard>
                  <SurfaceCardContent className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Data version
                    </p>
                    <p className="text-sm font-semibold">
                      {domainState.encrypted?.dataVersion ?? "Unavailable"}
                    </p>
                  </SurfaceCardContent>
                </SurfaceCard>
                <SurfaceCard>
                  <SurfaceCardContent className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Manifest version
                    </p>
                    <p className="text-sm font-semibold">
                      {domainState.manifest?.manifest_version ?? "Unavailable"}
                    </p>
                  </SurfaceCardContent>
                </SurfaceCard>
              </div>
            ) : (
              <SurfaceCard tone="warning">
                <SurfaceCardContent className="text-sm text-muted-foreground">
                  Choose a domain to inspect it.
                </SurfaceCardContent>
              </SurfaceCard>
            )}
            {domainState.error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
                {domainState.error}
              </div>
            ) : null}
          </SurfaceInset>

          {selectedSummary ? (
            <>
              <SurfaceInset className="space-y-4 px-4 py-4">
                <SectionHeader
                  eyebrow="Segments"
                  title="Encrypted segment layout"
                  description="These segment ids control which encrypted PKM slices are fetched."
                  icon={KeyRound}
                  accent="emerald"
                />
                <div className="flex flex-wrap gap-2">
                  {(domainState.encrypted?.segmentIds || domainState.manifest?.segment_ids || [
                    "root",
                  ]).map((segmentId) => (
                    <Badge key={segmentId} variant="secondary">
                      {segmentId}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  Ciphertext is stored in `pkm_blobs`, while manifest and scope exposure live in
                  `pkm_manifests`, `pkm_manifest_paths`, and `pkm_scope_registry`.
                </p>
              </SurfaceInset>

              <SurfaceInset className="space-y-4 px-4 py-4">
                <SectionHeader
                  eyebrow="Explorer"
                  title="Nested saved-data explorer"
                  description="Expand only the pieces you need instead of scrolling through a long flat dump."
                  icon={FolderTree}
                  accent="amber"
                />
                <Accordion
                  type="multiple"
                  defaultValue={[]}
                  className="rounded-2xl border px-4"
                >
                  <AccordionItem value="storage-flow">
                    <AccordionTrigger>How this domain is stored</AccordionTrigger>
                    <AccordionContent className="space-y-3">
                      <div className="grid gap-3 lg:grid-cols-3">
                        <div className="rounded-2xl border bg-muted/30 p-4 text-sm">
                          <p className="font-medium">Discovery index</p>
                          <p className="mt-1 text-muted-foreground">
                            `pkm_index` keeps domain presence, freshness, and lightweight summary
                            metadata for fast lookups.
                          </p>
                        </div>
                        <div className="rounded-2xl border bg-muted/30 p-4 text-sm">
                          <p className="font-medium">Encrypted content</p>
                          <p className="mt-1 text-muted-foreground">
                            `pkm_blobs` stores the encrypted per-segment payload. Only the needed
                            segments are fetched after vault unlock.
                          </p>
                        </div>
                        <div className="rounded-2xl border bg-muted/30 p-4 text-sm">
                          <p className="font-medium">Manifest and scopes</p>
                          <p className="mt-1 text-muted-foreground">
                            `pkm_manifests`, `pkm_manifest_paths`, and `pkm_scope_registry`
                            explain structure and scoped exposure without exposing the payload.
                          </p>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="scope-registry">
                    <AccordionTrigger>
                      Scope registry ({selectedScopeEntries.length})
                    </AccordionTrigger>
                    <AccordionContent>
                      {selectedScopeEntries.length ? (
                        <Accordion type="multiple" className="rounded-2xl border px-4">
                          {selectedScopeEntries.map((scope) => (
                            <AccordionItem key={scope.scope_handle} value={scope.scope_handle}>
                              <AccordionTrigger>
                                <div className="flex flex-wrap items-center gap-2 text-left">
                                  <Badge variant="secondary">{scope.scope_label}</Badge>
                                  <Badge variant="outline">{scope.scope_handle}</Badge>
                                </div>
                              </AccordionTrigger>
                              <AccordionContent className="space-y-3">
                                <div className="flex flex-wrap gap-2">
                                  {(scope.segment_ids || []).map((segmentId) => (
                                    <Badge key={segmentId} variant="secondary">
                                      {segmentId}
                                    </Badge>
                                  ))}
                                  {scope.sensitivity_tier ? (
                                    <Badge variant="secondary">{scope.sensitivity_tier}</Badge>
                                  ) : null}
                                </div>
                                <p className="text-sm text-muted-foreground">
                                  This is the public scope handle. Raw internal JSON paths stay
                                  private to first-party tooling after vault unlock.
                                </p>
                              </AccordionContent>
                            </AccordionItem>
                          ))}
                        </Accordion>
                      ) : (
                        <SurfaceCard tone="warning">
                          <SurfaceCardContent className="text-sm text-muted-foreground">
                            No scope registry entries are available for this domain yet.
                          </SurfaceCardContent>
                        </SurfaceCard>
                      )}
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="manifest-tree">
                    <AccordionTrigger>Manifest path tree ({selectedPaths.length})</AccordionTrigger>
                    <AccordionContent>
                      <PkmManifestTree paths={selectedPaths} />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="decrypted-preview">
                    <AccordionTrigger>First-party decrypted payload</AccordionTrigger>
                    <AccordionContent className="space-y-3">
                      {domainState.loading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading domain payload...
                        </div>
                      ) : null}
                      <PkmJsonTree
                        value={domainState.decrypted}
                        rootLabel={selectedSummary.key}
                        emptyLabel="No decrypted payload is available yet for this domain."
                      />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </SurfaceInset>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
