"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Edit3, Loader2, Lock, RefreshCw, ShieldAlert, Sparkles, Trash2, Users, X } from "lucide-react";

import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  PersonalKnowledgeModelService,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import { Button } from "@/lib/morphy-ux/morphy";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  buildNaturalAccessEntries,
  buildNaturalDomainPresentation,
  type NaturalAccessEntry,
} from "@/lib/personal-knowledge-model/natural-language";
import {
  buildPkmMemorySnapshot,
  deletePkmDomainValue,
  updatePkmDomainValue,
  type PkmMemoryCard,
} from "@/lib/pkm/pkm-memory-cards";
import { clearAgentPkmContext } from "@/lib/agent/agent-pkm-memory";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { useVault } from "@/lib/vault/vault-context";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function initials(label: string | null | undefined): string {
  const parts = String(label || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return "KA";
  return parts.map((part) => part[0]?.toUpperCase() || "").join("");
}

function globalAccessLabel(scope: string | null | undefined): string | null {
  if (scope === "pkm.read") return "Can access all of your saved data.";
  if (scope === "vault.owner") return "Can manage your full vault and everything inside it.";
  return null;
}

type PkmNaturalPanelProps = {
  refreshToken?: number;
  onOpenExplorer: () => void;
};

export function PkmNaturalPanel({
  refreshToken = 0,
  onOpenExplorer,
}: PkmNaturalPanelProps) {
  const { user, loading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();

  const [metadata, setMetadata] = useState<PersonalKnowledgeModelMetadata | null>(null);
  const [fullBlob, setFullBlob] = useState<Record<string, unknown>>({});
  const [manifests, setManifests] = useState<Record<string, DomainManifest | null>>({});
  const [activeGrants, setActiveGrants] = useState<ConsentCenterEntry[]>([]);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [memoryActionId, setMemoryActionId] = useState<string | null>(null);
  const [memoryActionMessage, setMemoryActionMessage] = useState<string | null>(null);
  const [memoryActionError, setMemoryActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadNaturalView() {
      if (loading) return;
      if (!user) {
        if (!cancelled) {
          setMetadata(null);
          setFullBlob({});
          setManifests({});
          setActiveGrants([]);
          setBootstrapLoading(false);
          setBootstrapError(null);
        }
        return;
      }
      if (!isVaultUnlocked || !vaultOwnerToken || !vaultKey) {
        if (!cancelled) {
          setMetadata(null);
          setFullBlob({});
          setManifests({});
          setActiveGrants([]);
          setBootstrapLoading(false);
          setBootstrapError(null);
        }
        return;
      }

      setBootstrapLoading(true);
      setBootstrapError(null);
      try {
        const force = refreshToken > 0 || refreshNonce > 0;
        const idToken = await user.getIdToken();
        const nextMetadata = await PersonalKnowledgeModelService.getMetadata(
          user.uid,
          force,
          vaultOwnerToken
        );
        const manifestPairs = await Promise.all(
          nextMetadata.domains.map(async (domain) => [
            domain.key,
            await PersonalKnowledgeModelService.getDomainManifest(
              user.uid,
              domain.key,
              vaultOwnerToken
            ).catch(() => null),
          ])
        );
        const center = await ConsentCenterService.getCenter({
          idToken,
          userId: user.uid,
          actor: "investor",
          view: "active",
          force,
        }).catch(() => null);
        const nextFullBlob = await PersonalKnowledgeModelService.loadFullBlob({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
        });

        if (cancelled) return;
        setMetadata(nextMetadata);
        setFullBlob(nextFullBlob);
        setManifests(Object.fromEntries(manifestPairs));
        setActiveGrants(center?.active_grants || []);
      } catch (nextError) {
        if (!cancelled) {
          setBootstrapError(
            nextError instanceof Error ? nextError.message : "Failed to load the natural PKM view."
          );
        }
      } finally {
        if (!cancelled) {
          setBootstrapLoading(false);
        }
      }
    }

    void loadNaturalView();
    return () => {
      cancelled = true;
    };
  }, [isVaultUnlocked, loading, refreshNonce, refreshToken, user, vaultKey, vaultOwnerToken]);

  const memorySnapshot = useMemo(
    () =>
      buildPkmMemorySnapshot({
        metadata,
        fullBlob,
      }),
    [fullBlob, metadata]
  );

  const domainInsightByKey = useMemo(
    () => new Map(memorySnapshot.domainInsights.map((insight) => [insight.domain, insight])),
    [memorySnapshot.domainInsights]
  );

  const globalAccessEntries = useMemo(() => {
    return activeGrants
      .filter((entry) => entry.scope === "pkm.read" || entry.scope === "vault.owner")
      .map((entry): NaturalAccessEntry => ({
        id: entry.id,
        requesterLabel: String(entry.counterpart_label || "Connected app"),
        requesterImageUrl: entry.counterpart_image_url,
        readableAccessLabel: globalAccessLabel(entry.scope) || "Has broad access.",
        coverageKind: "broad",
        status: String(entry.status || "active"),
        expiresAt:
          typeof entry.expires_at === "string"
            ? entry.expires_at
            : typeof entry.expires_at === "number"
              ? new Date(entry.expires_at).toISOString()
              : null,
      }));
  }, [activeGrants]);

  const domainEntries = useMemo(() => {
    if (!metadata) return [];
    const domainScopedGrants = activeGrants.filter(
      (entry) => entry.scope !== "pkm.read" && entry.scope !== "vault.owner"
    );
    return metadata.domains.map((domain) => ({
      domain,
      manifest: manifests[domain.key] || null,
      presentation: (() => {
        const base = buildNaturalDomainPresentation({
          domain,
          manifest: manifests[domain.key] || null,
        });
        const insight = domainInsightByKey.get(domain.key);
        if (!insight) return base;
        return {
          ...base,
          summary: insight.summary || base.summary,
          highlights: insight.highlights.length > 0 ? insight.highlights : base.highlights,
          updatedAt: insight.updatedAt || base.updatedAt,
        };
      })(),
      accessEntries: buildNaturalAccessEntries({
        domain,
        activeGrants: domainScopedGrants,
      }),
    }));
  }, [activeGrants, domainInsightByKey, manifests, metadata]);

  async function refreshMetadataAfterMemoryWrite() {
    if (!user || !vaultOwnerToken) return;
    const nextMetadata = await PersonalKnowledgeModelService.getMetadata(
      user.uid,
      true,
      vaultOwnerToken
    );
    setMetadata(nextMetadata);
  }

  function domainDataForCard(card: PkmMemoryCard): Record<string, unknown> {
    const value = fullBlob[card.domain];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function memoryWriteSummary(
    card: PkmMemoryCard,
    action: "edited" | "deleted",
    nextDomainData: Record<string, unknown>
  ) {
    const now = new Date().toISOString();
    const nextDomainSnapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: {
        [card.domain]: nextDomainData,
      },
      maxCards: 128,
      maxCardsPerDomain: 128,
    });
    return {
      readable_summary: `${card.domainTitle} memory was ${action} from your data view.`,
      readable_highlights: [`${action === "edited" ? "Updated" : "Removed"} ${card.title}`],
      readable_updated_at: now,
      readable_source_label: action === "edited" ? "Edited memory" : "Deleted memory",
      readable_event_summary: `${action === "edited" ? "Updated" : "Removed"} ${card.title}.`,
      memory_count: nextDomainSnapshot.cards.filter((item) => item.domain === card.domain).length,
    };
  }

  async function persistMemoryCardChange(params: {
    card: PkmMemoryCard;
    action: "edited" | "deleted";
    nextDomainData: Record<string, unknown>;
  }) {
    if (!user || !vaultKey || !vaultOwnerToken) return;
    setMemoryActionId(`${params.card.id}:${params.action}`);
    setMemoryActionError(null);
    setMemoryActionMessage(null);
    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: params.card.domain,
        vaultKey,
        vaultOwnerToken,
        build: () => ({
          domainData: params.nextDomainData,
          summary: memoryWriteSummary(params.card, params.action, params.nextDomainData),
          mergeDecision: {
            merge_mode: "replace_domain",
          },
        }),
      });
      if (!result.success) {
        throw new Error(result.message || "Failed to update saved memory.");
      }
      setFullBlob((current) => ({
        ...current,
        [params.card.domain]: result.fullBlob[params.card.domain] || params.nextDomainData,
      }));
      clearAgentPkmContext(user.uid);
      await refreshMetadataAfterMemoryWrite();
      setEditingCardId(null);
      setEditValue("");
      setMemoryActionMessage(
        params.action === "edited" ? "Memory card updated." : "Memory card deleted."
      );
    } catch (error) {
      setMemoryActionError(
        error instanceof Error ? error.message : "Failed to update saved memory."
      );
    } finally {
      setMemoryActionId(null);
    }
  }

  function startEditing(card: PkmMemoryCard) {
    setEditingCardId(card.id);
    setEditValue(card.value);
    setMemoryActionError(null);
    setMemoryActionMessage(null);
  }

  async function saveEditedCard(card: PkmMemoryCard) {
    const nextDomainData = updatePkmDomainValue({
      domainData: domainDataForCard(card),
      pathSegments: card.pathSegments,
      previousValue: card.value,
      nextValue: editValue,
    });
    await persistMemoryCardChange({
      card,
      action: "edited",
      nextDomainData,
    });
  }

  async function deleteCard(card: PkmMemoryCard) {
    const nextDomainData = deletePkmDomainValue({
      domainData: domainDataForCard(card),
      pathSegments: card.pathSegments,
    });
    await persistMemoryCardChange({
      card,
      action: "deleted",
      nextDomainData,
    });
  }

  if (loading || bootstrapLoading) {
    return (
      <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Building a readable view of your PKM and current access...
      </SurfaceInset>
    );
  }

  if (!user) {
    return (
      <SurfaceInset className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <ShieldAlert className="h-4 w-4" />
          Sign in to review your readable PKM view.
        </div>
        <p>This tab is tied to your live account, so it only loads once you are signed in.</p>
      </SurfaceInset>
    );
  }

  if (!isVaultUnlocked || !vaultOwnerToken || !vaultKey) {
    return (
      <SurfaceInset className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Lock className="h-4 w-4" />
          Unlock your vault to see the readable PKM view.
        </div>
        <p>
          The Natural tab uses the same private PKM metadata as the explorer, but presents it in a
          much simpler shape.
        </p>
      </SurfaceInset>
    );
  }

  return (
    <div className="space-y-4">
      <SurfaceInset className="space-y-4 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">
              Data + Access
            </p>
            <h2 className="text-sm font-semibold">What Kai knows about you, in plain English</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              This view keeps the saved data readable for a normal app user. It focuses on what Kai
              knows, when it was last updated, and which connected apps can currently access it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="none" effect="fade" onClick={() => setRefreshNonce((value) => value + 1)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button variant="none" effect="fade" onClick={onOpenExplorer}>
              Open Explorer view
            </Button>
          </div>
        </div>

        {bootstrapError ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
            {bootstrapError}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">{metadata?.domains.length || 0} domains</Badge>
          <Badge variant="secondary">{metadata?.totalAttributes || 0} saved details</Badge>
          <Badge variant="secondary">{memorySnapshot.totalCards} memory cards</Badge>
          <Badge variant="secondary">{activeGrants.length} active access grants</Badge>
          <Badge variant="secondary">
            Last updated {formatTimestamp(metadata?.lastUpdated || null)}
          </Badge>
        </div>
      </SurfaceInset>

      {globalAccessEntries.length > 0 ? (
        <SurfaceCard accent="emerald">
          <SurfaceCardHeader>
            <SurfaceCardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Cross-domain access
            </SurfaceCardTitle>
            <SurfaceCardDescription>
              These apps or agents currently have access that spans more than one domain.
            </SurfaceCardDescription>
          </SurfaceCardHeader>
          <SurfaceCardContent className="grid gap-3 md:grid-cols-2">
            {globalAccessEntries.map((entry) => (
              <div key={entry.id} className="rounded-2xl border bg-muted/20 p-4">
                <div className="flex items-start gap-3">
                  <Avatar className="h-11 w-11 border">
                    <AvatarImage src={entry.requesterImageUrl || undefined} alt={entry.requesterLabel} />
                    <AvatarFallback>{initials(entry.requesterLabel)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold">{entry.requesterLabel}</p>
                      <Badge variant="secondary">Broad access</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{entry.readableAccessLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      Expires {formatTimestamp(entry.expiresAt)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </SurfaceCardContent>
        </SurfaceCard>
      ) : null}

      <SurfaceCard accent="violet">
        <SurfaceCardHeader className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <SurfaceCardTitle>Memory cards</SurfaceCardTitle>
              <SurfaceCardDescription>
                Decrypted only while your vault is unlocked. Edit or delete cards to update the
                encrypted PKM domain.
              </SurfaceCardDescription>
            </div>
            <Badge variant="secondary">{memorySnapshot.totalCards} cards</Badge>
          </div>
          {memoryActionMessage ? (
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-100">
              {memoryActionMessage}
            </div>
          ) : null}
          {memoryActionError ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {memoryActionError}
            </div>
          ) : null}
        </SurfaceCardHeader>
        <SurfaceCardContent>
          {memorySnapshot.cards.length === 0 ? (
            <div className="rounded-2xl border border-dashed bg-muted/10 px-4 py-4 text-sm text-muted-foreground">
              No readable memory cards yet. Save a profile fact, preference, project note, receipt,
              or portfolio detail and it will show up here after vault unlock.
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {memorySnapshot.cards.slice(0, 24).map((card) => {
                const editing = editingCardId === card.id;
                const savingEdit = memoryActionId === `${card.id}:edited`;
                const deleting = memoryActionId === `${card.id}:deleted`;
                return (
                  <div key={card.id} className="rounded-2xl border bg-muted/15 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="secondary">{card.domainTitle}</Badge>
                          <Badge variant="outline">{Math.round(card.confidence * 100)}%</Badge>
                          <Badge variant="outline">{card.sourceLabel}</Badge>
                        </div>
                        <h3 className="text-sm font-semibold leading-6">{card.title}</h3>
                        <p className="text-xs text-muted-foreground">{card.detail}</p>
                        <p className="text-xs text-muted-foreground">
                          Updated {formatTimestamp(card.updatedAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {editing ? (
                          <>
                            <Button
                              variant="none"
                              effect="fade"
                              disabled={savingEdit}
                              onClick={() => void saveEditedCard(card)}
                              aria-label="Save memory card"
                            >
                              {savingEdit ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Check className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="none"
                              effect="fade"
                              disabled={savingEdit}
                              onClick={() => {
                                setEditingCardId(null);
                                setEditValue("");
                              }}
                              aria-label="Cancel memory card edit"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="none"
                              effect="fade"
                              onClick={() => startEditing(card)}
                              aria-label="Edit memory card"
                            >
                              <Edit3 className="h-4 w-4" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="none"
                                  effect="fade"
                                  disabled={deleting}
                                  aria-label="Delete memory card"
                                >
                                  {deleting ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-4 w-4" />
                                  )}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent size="sm">
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This removes the selected detail from the encrypted{" "}
                                    {card.domainTitle} PKM domain.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    variant="destructive"
                                    onClick={() => void deleteCard(card)}
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </>
                        )}
                      </div>
                    </div>
                    {editing ? (
                      <Input
                        className="mt-3"
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                        aria-label="Memory card value"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </SurfaceCardContent>
      </SurfaceCard>

      {domainEntries.length === 0 ? (
        <SurfaceInset className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Sparkles className="h-4 w-4" />
            No saved PKM domains yet.
          </div>
          <p>
            Generate a PKM preview in the Tool tab and save it once you are happy with the
            structure. This readable view will appear automatically after the write.
          </p>
        </SurfaceInset>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {domainEntries.map(({ domain, presentation, accessEntries }) => (
            <SurfaceCard key={domain.key} accent="sky">
              <SurfaceCardHeader className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <SurfaceCardTitle>{presentation.title}</SurfaceCardTitle>
                    <SurfaceCardDescription>
                      Updated {formatTimestamp(presentation.updatedAt)}
                    </SurfaceCardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{domain.attributeCount} details</Badge>
                    {presentation.sections.length > 0 ? (
                      <Badge variant="secondary">{presentation.sections.length} sections</Badge>
                    ) : null}
                  </div>
                </div>
                <p className="text-sm leading-6 text-foreground/90">{presentation.summary}</p>
              </SurfaceCardHeader>
              <SurfaceCardContent className="space-y-5">
                {presentation.highlights.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                      Highlights
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {presentation.highlights.map((highlight) => (
                        <Badge key={highlight} variant="outline" className="whitespace-normal py-1">
                          {highlight}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                {presentation.sections.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                      Sections
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {presentation.sections.map((section) => (
                        <Badge key={section} variant="secondary">
                          {section}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                      Access
                    </p>
                    {presentation.sourceLabel ? (
                      <p className="text-xs text-muted-foreground">{presentation.sourceLabel}</p>
                    ) : null}
                  </div>
                  {accessEntries.length > 0 ? (
                    <div className="space-y-3">
                      {accessEntries.map((entry) => (
                        <div key={entry.id} className="rounded-2xl border bg-muted/20 p-4">
                          <div className="flex items-start gap-3">
                            <Avatar className="h-10 w-10 border">
                              <AvatarImage
                                src={entry.requesterImageUrl || undefined}
                                alt={entry.requesterLabel}
                              />
                              <AvatarFallback>{initials(entry.requesterLabel)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-semibold">{entry.requesterLabel}</p>
                                <Badge variant="secondary">
                                  {entry.coverageKind === "broad" ? "Broad access" : "Limited access"}
                                </Badge>
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {entry.readableAccessLabel}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Status {entry.status} • Expires {formatTimestamp(entry.expiresAt)}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed bg-muted/10 px-4 py-4 text-sm text-muted-foreground">
                      No connected apps have active access to this part of your PKM right now.
                    </div>
                  )}
                </div>
              </SurfaceCardContent>
            </SurfaceCard>
          ))}
        </div>
      )}
    </div>
  );
}
