"use client";

import { useMemo, useState } from "react";
import {
  Database,
  FileJson,
  KeyRound,
  Loader2,
  ShieldCheck,
} from "lucide-react";

import { SectionHeader } from "@/components/app-ui/page-sections";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import {
  PkmJsonTree,
  PkmManifestTree,
} from "@/components/profile/pkm-tree-view";
import { PkmSearchBar } from "@/components/pkm/pkm-search-bar";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import type { DomainSummary, EncryptedDomainBlob } from "@/lib/services/personal-knowledge-model-service";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/**
 * Recursively filter a JSON value to only include paths whose keys or
 * stringified leaf values match the search term (case-insensitive).
 */
function filterJsonValue(
  value: unknown,
  term: string
): unknown | undefined {
  if (value === null || value === undefined) return undefined;

  const lower = term.toLowerCase();

  if (Array.isArray(value)) {
    const filtered = value
      .map((item) => filterJsonValue(item, term))
      .filter((item) => item !== undefined);
    return filtered.length > 0 ? filtered : undefined;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    let hasMatch = false;
    for (const [key, child] of Object.entries(record)) {
      if (key.toLowerCase().includes(lower)) {
        result[key] = child;
        hasMatch = true;
      } else {
        const filteredChild = filterJsonValue(child, term);
        if (filteredChild !== undefined) {
          result[key] = filteredChild;
          hasMatch = true;
        }
      }
    }
    return hasMatch ? result : undefined;
  }

  // Leaf value
  if (String(value).toLowerCase().includes(lower)) {
    return value;
  }
  return undefined;
}

export function PkmEntryDetail({
  summary,
  manifest,
  encrypted,
  decrypted,
  loading,
  error,
}: {
  summary: DomainSummary | null;
  manifest: DomainManifest | null;
  encrypted: EncryptedDomainBlob | null;
  decrypted: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
}) {
  const [searchTerm, setSearchTerm] = useState("");

  const filteredDecrypted = useMemo(() => {
    if (!decrypted || !searchTerm.trim()) return decrypted;
    const result = filterJsonValue(decrypted, searchTerm.trim());
    if (result === undefined) return {};
    return result as Record<string, unknown>;
  }, [decrypted, searchTerm]);

  const scopeEntries = useMemo(
    () => manifest?.scope_registry || [],
    [manifest]
  );

  const manifestPaths = useMemo(() => manifest?.paths || [], [manifest]);

  if (!summary) {
    return (
      <SurfaceInset className="px-4 py-8">
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Database />
            </EmptyMedia>
            <EmptyTitle>Select a domain</EmptyTitle>
            <EmptyDescription>
              Choose a domain from the list to inspect its structure and
              decrypted data.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SurfaceInset>
    );
  }

  return (
    <div className="space-y-4">
      {/* Overview cards */}
      <SurfaceInset className="space-y-4 px-4 py-4">
        <SectionHeader
          eyebrow="Domain overview"
          title={summary.displayName}
          description={summary.readableSummary || `Inspect the ${summary.key} domain structure and content.`}
          icon={Database}
          accent="violet"
        />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SurfaceCard>
            <SurfaceCardContent className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Last updated
              </p>
              <p className="text-sm font-semibold">
                {formatTimestamp(summary.lastUpdated)}
              </p>
            </SurfaceCardContent>
          </SurfaceCard>
          <SurfaceCard>
            <SurfaceCardContent className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Storage mode
              </p>
              <p className="text-sm font-semibold">
                {encrypted?.storageMode || "domain"}
              </p>
            </SurfaceCardContent>
          </SurfaceCard>
          <SurfaceCard>
            <SurfaceCardContent className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Data version
              </p>
              <p className="text-sm font-semibold">
                {encrypted?.dataVersion ?? "Unavailable"}
              </p>
            </SurfaceCardContent>
          </SurfaceCard>
          <SurfaceCard>
            <SurfaceCardContent className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Manifest version
              </p>
              <p className="text-sm font-semibold">
                {manifest?.manifest_version ?? "Unavailable"}
              </p>
            </SurfaceCardContent>
          </SurfaceCard>
        </div>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        ) : null}
      </SurfaceInset>

      {/* Encrypted segments */}
      <SurfaceInset className="space-y-3 px-4 py-4">
        <SectionHeader
          eyebrow="Segments"
          title="Encrypted segment layout"
          description="Segment identifiers that partition the encrypted PKM payload for this domain."
          icon={KeyRound}
          accent="emerald"
        />
        <div className="flex flex-wrap gap-2">
          {(encrypted?.segmentIds || manifest?.segment_ids || ["root"]).map(
            (segmentId) => (
              <Badge key={segmentId} variant="secondary">
                {segmentId}
              </Badge>
            )
          )}
        </div>
      </SurfaceInset>

      {/* Scope registry */}
      <SurfaceInset className="space-y-3 px-4 py-4">
        <SectionHeader
          eyebrow="Scopes"
          title={`Scope registry (${scopeEntries.length})`}
          description="Consent scopes registered for this domain. Each scope controls what data can be shared."
          icon={ShieldCheck}
          accent="amber"
        />
        {scopeEntries.length ? (
          <Accordion type="multiple" className="rounded-2xl border px-4">
            {scopeEntries.map((scope) => (
              <AccordionItem
                key={scope.scope_handle}
                value={scope.scope_handle}
              >
                <AccordionTrigger>
                  <div className="flex flex-wrap items-center gap-2 text-left">
                    <Badge variant="secondary">{scope.scope_label}</Badge>
                    <Badge variant="outline">{scope.scope_handle}</Badge>
                    {scope.sensitivity_tier ? (
                      <Badge variant="secondary">
                        {scope.sensitivity_tier}
                      </Badge>
                    ) : null}
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {(scope.segment_ids || []).map((segmentId) => (
                      <Badge key={segmentId} variant="outline">
                        {segmentId}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Exposure: {scope.exposure_enabled ? "enabled" : "disabled"}
                    {scope.scope_kind ? ` | Kind: ${scope.scope_kind}` : ""}
                  </p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        ) : (
          <div className="rounded-2xl border bg-muted/30 p-4 text-sm text-muted-foreground">
            No scope registry entries are available for this domain yet.
          </div>
        )}
      </SurfaceInset>

      {/* Manifest path tree */}
      <SurfaceInset className="space-y-3 px-4 py-4">
        <SectionHeader
          eyebrow="Structure"
          title={`Manifest paths (${manifestPaths.length})`}
          description="The structural map of this domain: every JSON path, type, and segment assignment."
          icon={FileJson}
          accent="sky"
        />
        <PkmManifestTree paths={manifestPaths} />
      </SurfaceInset>

      {/* Decrypted payload with search */}
      <SurfaceInset className="space-y-3 px-4 py-4">
        <SectionHeader
          eyebrow="Decrypted data"
          title="First-party decrypted payload"
          description="Your decrypted domain data, viewable only because the vault is unlocked on this device."
          icon={KeyRound}
          accent="violet"
        />

        <PkmSearchBar
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder={`Search within ${summary.displayName}...`}
        />

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Decrypting domain payload...
          </div>
        ) : (
          <PkmJsonTree
            value={filteredDecrypted}
            rootLabel={summary.key}
            emptyLabel={
              searchTerm.trim()
                ? `No entries match "${searchTerm}" in this domain.`
                : "No decrypted payload is available for this domain yet."
            }
          />
        )}
      </SurfaceInset>
    </div>
  );
}
