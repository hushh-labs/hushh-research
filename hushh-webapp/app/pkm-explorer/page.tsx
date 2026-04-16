"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Database,
  FolderTree,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { PkmDomainList } from "@/components/pkm/pkm-domain-list";
import { PkmEntryDetail } from "@/components/pkm/pkm-entry-detail";
import { PkmSearchBar } from "@/components/pkm/pkm-search-bar";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/morphy";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  PersonalKnowledgeModelService,
  type DomainSummary,
  type EncryptedDomainBlob,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import { useVault } from "@/lib/vault/vault-context";

type DomainInspectorState = {
  manifest: DomainManifest | null;
  encrypted: EncryptedDomainBlob | null;
  decrypted: Record<string, unknown> | null;
  error: string | null;
  loading: boolean;
};

export default function PkmExplorerPage() {
  const { user, loading: authLoading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();

  const [metadata, setMetadata] =
    useState<PersonalKnowledgeModelMetadata | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [domainFilter, setDomainFilter] = useState("");
  const [domainState, setDomainState] = useState<DomainInspectorState>({
    manifest: null,
    encrypted: null,
    decrypted: null,
    error: null,
    loading: false,
  });

  // Load PKM metadata on mount / vault unlock
  useEffect(() => {
    let cancelled = false;

    async function loadMetadata(forceRefresh = false) {
      if (authLoading) return;
      if (!user || !isVaultUnlocked || !vaultOwnerToken) {
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
        const result =
          await PersonalKnowledgeModelService.getMetadata(
            user.uid,
            forceRefresh,
            vaultOwnerToken
          );
        if (cancelled) return;
        setMetadata(result);
        setSelectedDomain((current) => {
          if (
            current &&
            result.domains.some((d) => d.key === current)
          ) {
            return current;
          }
          return result.domains[0]?.key || null;
        });
      } catch (err) {
        if (!cancelled) {
          setBootstrapError(
            err instanceof Error ? err.message : "Failed to load PKM metadata."
          );
        }
      } finally {
        if (!cancelled) setBootstrapLoading(false);
      }
    }

    void loadMetadata();
    return () => {
      cancelled = true;
    };
  }, [authLoading, isVaultUnlocked, user, vaultOwnerToken]);

  // Load domain detail when selected domain changes
  useEffect(() => {
    let cancelled = false;

    async function loadDomain() {
      if (
        !user ||
        !selectedDomain ||
        !vaultKey ||
        !vaultOwnerToken ||
        !isVaultUnlocked
      ) {
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

      setDomainState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const [manifest, encrypted, decrypted] = await Promise.all([
          PersonalKnowledgeModelService.getDomainManifest(
            user.uid,
            selectedDomain,
            vaultOwnerToken
          ),
          PersonalKnowledgeModelService.getDomainData(
            user.uid,
            selectedDomain,
            vaultOwnerToken
          ),
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
      } catch (err) {
        if (!cancelled) {
          setDomainState({
            manifest: null,
            encrypted: null,
            decrypted: null,
            error:
              err instanceof Error
                ? err.message
                : "Failed to load domain data.",
            loading: false,
          });
        }
      }
    }

    void loadDomain();
    return () => {
      cancelled = true;
    };
  }, [isVaultUnlocked, selectedDomain, user, vaultKey, vaultOwnerToken]);

  const selectedSummary = useMemo<DomainSummary | null>(() => {
    if (!metadata || !selectedDomain) return null;
    return (
      metadata.domains.find((d) => d.key === selectedDomain) || null
    );
  }, [metadata, selectedDomain]);

  const filteredDomains = useMemo(() => {
    if (!metadata?.domains) return [];
    if (!domainFilter.trim()) return metadata.domains;
    const lower = domainFilter.trim().toLowerCase();
    return metadata.domains.filter(
      (d) =>
        d.key.toLowerCase().includes(lower) ||
        d.displayName.toLowerCase().includes(lower) ||
        (d.readableSummary?.toLowerCase().includes(lower) ?? false)
    );
  }, [metadata, domainFilter]);

  async function handleRefresh() {
    if (!user || !vaultOwnerToken || !isVaultUnlocked) return;

    setBootstrapLoading(true);
    setBootstrapError(null);
    try {
      const result =
        await PersonalKnowledgeModelService.getMetadata(
          user.uid,
          true,
          vaultOwnerToken
        );
      setMetadata(result);
      setSelectedDomain((current) => {
        if (current && result.domains.some((d) => d.key === current)) {
          return current;
        }
        return result.domains[0]?.key || null;
      });
    } catch (err) {
      setBootstrapError(
        err instanceof Error ? err.message : "Failed to refresh PKM metadata."
      );
    } finally {
      setBootstrapLoading(false);
    }
  }

  // --- Gate: auth loading ---
  if (authLoading) {
    return (
      <AppPageShell as="div" width="expanded" className="pb-32">
        <AppPageContentRegion>
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </AppPageContentRegion>
      </AppPageShell>
    );
  }

  // --- Gate: not signed in ---
  if (!user) {
    return (
      <AppPageShell as="div" width="expanded" className="pb-32">
        <AppPageContentRegion>
          <Empty className="py-24">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldAlert />
              </EmptyMedia>
              <EmptyTitle>Sign in required</EmptyTitle>
              <EmptyDescription>
                Sign in to your hushh account to explore your Personal Knowledge
                Model.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </AppPageContentRegion>
      </AppPageShell>
    );
  }

  // --- Gate: vault locked ---
  if (!isVaultUnlocked) {
    return (
      <AppPageShell as="div" width="expanded" className="pb-32">
        <AppPageHeaderRegion>
          <PageHeader
            eyebrow="PKM Explorer"
            title="Personal Knowledge Model"
            description="Inspect your encrypted PKM domains, scopes, and decrypted payloads."
            icon={Database}
            accent="violet"
          />
        </AppPageHeaderRegion>
        <AppPageContentRegion>
          <Empty className="py-24">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Lock />
              </EmptyMedia>
              <EmptyTitle>Vault locked</EmptyTitle>
              <EmptyDescription>
                Unlock your vault to decrypt and explore your PKM data. All
                decryption happens on this device only.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </AppPageContentRegion>
      </AppPageShell>
    );
  }

  return (
    <AppPageShell as="div" width="expanded" className="relative pb-32">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="PKM Explorer"
          title="Personal Knowledge Model"
          description="Browse, search, and inspect your encrypted PKM domains. All decryption is client-side only."
          icon={Database}
          accent="violet"
          actions={
            <div className="flex items-center gap-2">
              {metadata ? (
                <>
                  <Badge variant="secondary">
                    {metadata.domains.length} domain{metadata.domains.length !== 1 ? "s" : ""}
                  </Badge>
                  <Badge variant="secondary">
                    {metadata.totalAttributes} attribute{metadata.totalAttributes !== 1 ? "s" : ""}
                  </Badge>
                </>
              ) : null}
              <Button
                variant="none"
                effect="fade"
                onClick={() => void handleRefresh()}
                disabled={bootstrapLoading}
              >
                {bootstrapLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh
              </Button>
            </div>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack>
          {bootstrapError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {bootstrapError}
            </div>
          ) : null}

          {bootstrapLoading && !metadata ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
              {/* Domain list sidebar */}
              <div className="space-y-3">
                <SurfaceInset className="space-y-3 px-4 py-4">
                  <div className="flex items-center gap-2">
                    <FolderTree className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold">Domains</h3>
                  </div>
                  {(metadata?.domains.length ?? 0) > 3 ? (
                    <PkmSearchBar
                      value={domainFilter}
                      onChange={setDomainFilter}
                      placeholder="Filter domains..."
                    />
                  ) : null}
                  <PkmDomainList
                    domains={filteredDomains}
                    selectedDomain={selectedDomain}
                    onSelectDomain={setSelectedDomain}
                  />
                </SurfaceInset>
              </div>

              {/* Domain detail */}
              <div>
                <PkmEntryDetail
                  summary={selectedSummary}
                  manifest={domainState.manifest}
                  encrypted={domainState.encrypted}
                  decrypted={domainState.decrypted}
                  loading={domainState.loading}
                  error={domainState.error}
                />
              </div>
            </div>
          )}
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
