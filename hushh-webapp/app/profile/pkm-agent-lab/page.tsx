"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Loader2, Save, ShieldAlert, Vault } from "lucide-react";
import { useRouter } from "next/navigation";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { PkmExplorerPanel } from "@/components/profile/pkm-explorer-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { PkmJsonTree } from "@/components/profile/pkm-tree-view";
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/lib/morphy-ux/morphy";
import { Textarea } from "@/components/ui/textarea";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { ApiService } from "@/lib/services/api-service";
import {
  getDeveloperAccess,
  type DeveloperPortalAccess,
} from "@/lib/services/developer-portal-service";
import { type DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { useVault } from "@/lib/vault/vault-context";

type AgentLabResponse = {
  agent_id: string;
  agent_name: string;
  model: string;
  used_fallback: boolean;
  error?: string | null;
  candidate_payload: Record<string, unknown>;
  structure_decision: Record<string, unknown>;
  manifest_draft?: DomainManifest | null;
};

type OverlapAssessment = {
  targetDomain: string;
  action: string;
  requiresConfirmation: boolean;
  existingPathCount: number;
  incomingPathCount: number;
  overlappingPaths: string[];
  newPaths: string[];
  note: string;
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toPathSet(value: DomainManifest | null | undefined): Set<string> {
  return new Set(
    Array.isArray(value?.paths)
      ? value.paths
          .map((path) => path?.json_path)
          .filter((item): item is string => typeof item === "string" && item.length > 0)
      : []
  );
}

export default function PkmAgentLabPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const explorerRef = useRef<HTMLDivElement | null>(null);

  const [access, setAccess] = useState<DeveloperPortalAccess | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [currentDomains, setCurrentDomains] = useState<string[]>([]);
  const [message, setMessage] = useState(
    "Remember that I prefer short city breaks and weekly meal prep."
  );
  const [response, setResponse] = useState<AgentLabResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [overlapAssessment, setOverlapAssessment] = useState<OverlapAssessment | null>(null);
  const [overlapLoading, setOverlapLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadAccess() {
      if (loading) {
        return;
      }
      if (!user) {
        if (!cancelled) {
          setAccess(null);
          setAccessLoading(false);
          setCurrentDomains([]);
        }
        return;
      }

      setAccessLoading(true);
      try {
        const idToken = await user.getIdToken();
        const [developerAccess, metadata] = await Promise.all([
          getDeveloperAccess(idToken),
          isVaultUnlocked && vaultOwnerToken
            ? PersonalKnowledgeModelService.getMetadata(user.uid, false, vaultOwnerToken).catch(
                () => null
              )
            : Promise.resolve(null),
        ]);
        if (!cancelled) {
          setAccess(developerAccess);
          setCurrentDomains(metadata?.domains.map((domain) => domain.key) || []);
        }
      } catch (nextError) {
        if (!cancelled) {
          setAccess(null);
          setCurrentDomains([]);
          setError(
            nextError instanceof Error ? nextError.message : "Failed to load developer access."
          );
        }
      } finally {
        if (!cancelled) {
          setAccessLoading(false);
        }
      }
    }

    void loadAccess();
    return () => {
      cancelled = true;
    };
  }, [isVaultUnlocked, loading, user, vaultOwnerToken]);

  useEffect(() => {
    let cancelled = false;

    async function assessOverlap() {
      if (!response || !user || !vaultOwnerToken) {
        if (!cancelled) {
          setOverlapAssessment(null);
          setOverlapLoading(false);
        }
        return;
      }

      const structureDecision =
        response.structure_decision && typeof response.structure_decision === "object"
          ? response.structure_decision
          : {};
      const manifestDraft =
        response.manifest_draft && typeof response.manifest_draft === "object"
          ? response.manifest_draft
          : null;
      const targetDomain =
        (typeof manifestDraft?.domain === "string" && manifestDraft.domain) ||
        (typeof structureDecision.target_domain === "string" && structureDecision.target_domain) ||
        "";
      const action =
        typeof structureDecision.action === "string"
          ? structureDecision.action
          : "match_existing_domain";

      if (!targetDomain) {
        if (!cancelled) {
          setOverlapAssessment(null);
          setOverlapLoading(false);
        }
        return;
      }

      const incomingPaths = Array.from(toPathSet(manifestDraft));
      const domainExists = currentDomains.includes(targetDomain);
      if (!domainExists) {
        if (!cancelled) {
          setOverlapAssessment({
            targetDomain,
            action,
            requiresConfirmation: false,
            existingPathCount: 0,
            incomingPathCount: incomingPaths.length,
            overlappingPaths: [],
            newPaths: incomingPaths,
            note: "This preview targets a brand new PKM domain, so no existing structure overlap was found.",
          });
          setOverlapLoading(false);
        }
        return;
      }

      setOverlapLoading(true);
      try {
        const existingManifest = await PersonalKnowledgeModelService.getDomainManifest(
          user.uid,
          targetDomain,
          vaultOwnerToken
        );
        if (cancelled) return;

        const existingPaths = toPathSet(existingManifest);
        const overlappingPaths = incomingPaths.filter((path) => existingPaths.has(path));
        const newPaths = incomingPaths.filter((path) => !existingPaths.has(path));
        const requiresConfirmation =
          action !== "create_domain" || overlappingPaths.length > 0 || existingPaths.size > 0;

        setOverlapAssessment({
          targetDomain,
          action,
          requiresConfirmation,
          existingPathCount: existingPaths.size,
          incomingPathCount: incomingPaths.length,
          overlappingPaths,
          newPaths,
          note:
            overlappingPaths.length > 0
              ? "This preview overlaps with PKM paths that already exist. Saving will write a new encrypted revision for the same domain."
              : "This preview will extend an existing domain with new paths. Review before saving so we do not duplicate structure accidentally.",
        });
      } catch {
        if (!cancelled) {
          setOverlapAssessment({
            targetDomain,
            action,
            requiresConfirmation: true,
            existingPathCount: 0,
            incomingPathCount: incomingPaths.length,
            overlappingPaths: [],
            newPaths: incomingPaths,
            note:
              "Kai could not verify the existing manifest for this domain, so save confirmation is required before writing.",
          });
        }
      } finally {
        if (!cancelled) {
          setOverlapLoading(false);
        }
      }
    }

    void assessOverlap();
    return () => {
      cancelled = true;
    };
  }, [currentDomains, response, user, vaultOwnerToken]);

  const canUseLab = Boolean(user && access?.access_enabled && isVaultUnlocked && vaultOwnerToken);
  const prettyResponse = useMemo(
    () => (response ? JSON.stringify(response, null, 2) : ""),
    [response]
  );

  const backendOrganization = useMemo(() => {
    if (!response) return null;
    const structureDecision =
      response.structure_decision && typeof response.structure_decision === "object"
        ? response.structure_decision
        : {};
    const manifestDraft =
      response.manifest_draft && typeof response.manifest_draft === "object"
        ? response.manifest_draft
        : null;
    const targetDomain =
      (typeof manifestDraft?.domain === "string" && manifestDraft.domain) ||
      (typeof structureDecision.target_domain === "string" && structureDecision.target_domain) ||
      "general";
    const segmentIds = toStringArray(manifestDraft?.segment_ids);
    const topLevelScopes = toStringArray(
      manifestDraft?.top_level_scope_paths ?? structureDecision.top_level_scope_paths
    );
    const externalizablePaths = toStringArray(
      manifestDraft?.externalizable_paths ?? structureDecision.externalizable_paths
    );
    const pathCount =
      typeof manifestDraft?.path_count === "number"
        ? manifestDraft.path_count
        : Array.isArray(manifestDraft?.paths)
          ? manifestDraft.paths.length
          : 0;
    const scopeRegistryCount = Array.isArray(manifestDraft?.scope_registry)
      ? manifestDraft.scope_registry.length
      : 0;
    const manifestVersion =
      typeof manifestDraft?.manifest_version === "number" ? manifestDraft.manifest_version : 1;
    return {
      targetDomain,
      action:
        typeof structureDecision.action === "string"
          ? structureDecision.action
          : "match_existing_domain",
      segmentIds,
      topLevelScopes,
      externalizablePaths,
      pathCount,
      scopeRegistryCount,
      manifestVersion,
    };
  }, [response]);

  async function handlePreview() {
    if (!user || !vaultOwnerToken) {
      setError("Unlock your vault before using Agent Lab.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setSaveMessage(null);
    setOverlapAssessment(null);
    try {
      const result = await ApiService.apiFetch("/api/pkm/agent-lab/structure", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${vaultOwnerToken}`,
        },
        body: JSON.stringify({
          user_id: user.uid,
          message,
          current_domains: currentDomains,
        }),
      });

      if (!result.ok) {
        const detail = await result.text();
        throw new Error(detail || `Agent lab request failed with ${result.status}`);
      }

      const payload = (await result.json()) as AgentLabResponse;
      setResponse(payload);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to preview PKM structure.");
    } finally {
      setSubmitting(false);
    }
  }

  async function persistPreview() {
    if (!user || !vaultOwnerToken || !vaultKey) {
      setError("Unlock your vault before saving to PKM.");
      return;
    }
    if (!response) {
      setError("Generate a preview before saving to PKM.");
      return;
    }

    const candidatePayload =
      response.candidate_payload && typeof response.candidate_payload === "object"
        ? response.candidate_payload
        : null;
    const structureDecision =
      response.structure_decision && typeof response.structure_decision === "object"
        ? response.structure_decision
        : {};
    const manifestDraft =
      response.manifest_draft && typeof response.manifest_draft === "object"
        ? response.manifest_draft
        : null;
    const targetDomain =
      (typeof manifestDraft?.domain === "string" && manifestDraft.domain) ||
      (typeof structureDecision.target_domain === "string" && structureDecision.target_domain) ||
      "";
    if (!candidatePayload || !targetDomain) {
      setError("Preview did not produce a valid candidate payload.");
      return;
    }

    const summaryProjection =
      structureDecision.summary_projection && typeof structureDecision.summary_projection === "object"
        ? (structureDecision.summary_projection as Record<string, unknown>)
        : {};

    try {
      setSaving(true);
      setError(null);
      setSaveMessage(null);
      const result = await PersonalKnowledgeModelService.storePreparedDomain({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        domain: targetDomain,
        domainData: candidatePayload,
        summary: {
          ...summaryProjection,
          message_excerpt: message.slice(0, 160),
          source: "pkm_agent_lab",
        },
        structureDecision: structureDecision as Record<string, unknown>,
        manifest: manifestDraft as DomainManifest | null,
      });

      if (!result.success) {
        throw new Error(result.message || "Failed to save candidate payload to PKM.");
      }

      const metadata = await PersonalKnowledgeModelService.getMetadata(
        user.uid,
        true,
        vaultOwnerToken
      ).catch(() => null);
      setCurrentDomains(metadata?.domains.map((domain) => domain.key) || currentDomains);
      setSaveMessage(
        `Saved ${targetDomain} to your PKM. Preview only inspected the structure; Save encrypted the inferred payload with your vault key and wrote the new PKM revision.`
      );
      setShowSaveConfirm(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save PKM payload.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveToPkm() {
    if (overlapAssessment?.requiresConfirmation) {
      setShowSaveConfirm(true);
      return;
    }
    await persistPreview();
  }

  function scrollToExplorer() {
    explorerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <>
      <PkmSettingsShell
        title="PKM Agent Lab"
        description="Developer-only intent capture for a live signed-in account. Use natural language only, inspect what Kai inferred, save it with your vault, and inspect the real saved PKM below."
      >
        <SurfaceInset className="space-y-3 px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{user ? "Signed in" : "Signed out"}</Badge>
            <Badge variant="secondary">{isVaultUnlocked ? "Vault unlocked" : "Vault locked"}</Badge>
            <Badge variant="secondary">
              {access?.access_enabled ? "Developer access enabled" : "Developer access required"}
            </Badge>
            {currentDomains.length > 0 ? (
              <Badge variant="secondary">{currentDomains.length} current domains</Badge>
            ) : null}
          </div>
          {accessLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading developer access and PKM metadata...
            </div>
          ) : null}
          {!user ? (
            <div className="flex items-center gap-2 text-sm text-amber-700">
              <ShieldAlert className="h-4 w-4" />
              Sign in first to use Agent Lab.
            </div>
          ) : null}
          {user && !isVaultUnlocked ? (
            <div className="flex flex-wrap items-center gap-3 text-sm text-amber-700">
              <div className="flex items-center gap-2">
                <Vault className="h-4 w-4" />
                Unlock your vault here before previewing or saving PKM data.
              </div>
              <Button variant="none" effect="fade" onClick={() => setShowVaultUnlock(true)}>
                Unlock vault
              </Button>
            </div>
          ) : null}
          {user && isVaultUnlocked && !access?.access_enabled ? (
            <div className="flex flex-wrap items-center gap-3 text-sm text-amber-700">
              <div className="flex items-center gap-2">
                <Code2 className="h-4 w-4" />
                Developer access is required for this tool.
              </div>
              <Button variant="none" effect="fade" onClick={() => router.push("/developers")}>
                Open Developers
              </Button>
            </div>
          ) : null}
        </SurfaceInset>

        <SurfaceInset className="space-y-4 px-4 py-4">
          <div className="rounded-3xl border bg-muted/30 p-4 sm:p-5">
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">Developer onboarding</h2>
              <p className="text-sm text-muted-foreground">
                Use one natural-language memory at a time. Preview stays read-only, Save encrypts
                the inferred payload with the active vault key, and the saved PKM explorer below is
                collapsed by default so you can inspect only the structure you need.
              </p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border bg-background/75 p-4 text-sm">
                <p className="font-medium">1. Describe the memory</p>
                <p className="mt-1 text-muted-foreground">
                  Enter a plain-language memory, preference, or intent. Kai infers structure from
                  that message only.
                </p>
              </div>
              <div className="rounded-2xl border bg-background/75 p-4 text-sm">
                <p className="font-medium">2. Review preview</p>
                <p className="mt-1 text-muted-foreground">
                  Preview shows the candidate payload, target domain, scope plan, and backend
                  storage organization without writing anything.
                </p>
              </div>
              <div className="rounded-2xl border bg-background/75 p-4 text-sm">
                <p className="font-medium">3. Confirm overlap</p>
                <p className="mt-1 text-muted-foreground">
                  Kai checks whether the domain already exists so we can avoid silently duplicating
                  or rewriting information.
                </p>
              </div>
              <div className="rounded-2xl border bg-background/75 p-4 text-sm">
                <p className="font-medium">4. Save encrypted PKM</p>
                <p className="mt-1 text-muted-foreground">
                  Save encrypts the inferred payload, writes the PKM records, and lets you inspect
                  the stored result below.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Natural language prompt</label>
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Describe the memory or preference you want Kai to structure and potentially save."
              className="min-h-28"
            />
            <p className="text-xs text-muted-foreground">
              This is the only input for the developer tool now. Kai infers the payload, target
              domain, scope plan, and manifest draft from this prompt.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Button
              className="w-full"
              onClick={() => void handlePreview()}
              disabled={!canUseLab || submitting || saving}
            >
              {submitting ? "Generating preview..." : "Preview PKM structure"}
            </Button>
            <Button
              variant="none"
              effect="fade"
              className="w-full"
              onClick={() => void handleSaveToPkm()}
              disabled={!canUseLab || !response || submitting || saving}
            >
              {saving ? (
                "Saving to PKM..."
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save to PKM
                </>
              )}
            </Button>
            <Button
              variant="none"
              effect="fade"
              className="w-full"
              onClick={scrollToExplorer}
            >
              Jump to saved PKM
            </Button>
          </div>

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          {saveMessage ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-700">
              {saveMessage}
            </div>
          ) : null}
        </SurfaceInset>

        <SurfaceInset className="space-y-3 px-4 py-4">
          <div>
            <h2 className="text-sm font-semibold">Preview and save flow</h2>
            <p className="text-sm text-muted-foreground">
              Preview never writes to the backend. Save encrypts the inferred payload with the
              current vault key and then writes the PKM artifacts.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border bg-muted/30 p-4 text-sm">
              <p className="font-medium">1. Intent capture</p>
              <p className="mt-1 text-muted-foreground">
                Natural language goes to the PKM structure agent using your current domain list.
              </p>
            </div>
            <div className="rounded-2xl border bg-muted/30 p-4 text-sm">
              <p className="font-medium">2. Preview only</p>
              <p className="mt-1 text-muted-foreground">
                Kai infers a candidate payload, structure decision, manifest draft, and scope plan.
              </p>
            </div>
            <div className="rounded-2xl border bg-muted/30 p-4 text-sm">
              <p className="font-medium">3. Save encrypts</p>
              <p className="mt-1 text-muted-foreground">
                The candidate payload is encrypted in the first-party vault boundary before upload.
              </p>
            </div>
            <div className="rounded-2xl border bg-muted/30 p-4 text-sm">
              <p className="font-medium">4. PKM write</p>
              <p className="mt-1 text-muted-foreground">
                Save writes `pkm_blobs`, `pkm_manifests`, `pkm_manifest_paths`,
                `pkm_scope_registry`, `pkm_index`, and `pkm_events`.
              </p>
            </div>
          </div>
        </SurfaceInset>

        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
          <div className="space-y-4">
            <SurfaceInset className="space-y-3 px-4 py-4">
              <div>
                <h2 className="text-sm font-semibold">What Kai understood</h2>
                <p className="text-sm text-muted-foreground">
                  This is the structured candidate payload inferred from the prompt. It stays a
                  preview until you explicitly save it.
                </p>
              </div>
              <PkmJsonTree
                value={response?.candidate_payload}
                rootLabel="candidate_payload"
                emptyLabel="Generate a preview to see the inferred payload."
              />
            </SurfaceInset>

            <SurfaceInset className="space-y-3 px-4 py-4">
              <div>
                <h2 className="text-sm font-semibold">Duplicate and overlap check</h2>
                <p className="text-sm text-muted-foreground">
                  Kai checks whether the preview maps into an existing domain and whether the
                  manifest overlaps with paths already present there. Save confirmation is required
                  whenever the preview might extend or rewrite an existing domain.
                </p>
              </div>
              {overlapLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking the existing PKM manifest for overlap...
                </div>
              ) : overlapAssessment ? (
                <div className="space-y-3 rounded-2xl border bg-muted/30 p-4 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">Domain: {overlapAssessment.targetDomain}</Badge>
                    <Badge variant="secondary">Action: {overlapAssessment.action}</Badge>
                    <Badge variant="secondary">
                      Existing paths: {overlapAssessment.existingPathCount}
                    </Badge>
                    <Badge variant="secondary">
                      Incoming paths: {overlapAssessment.incomingPathCount}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">{overlapAssessment.note}</p>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="min-w-0">
                      <p className="font-medium">Overlapping paths</p>
                      <p className="break-words text-muted-foreground">
                        {overlapAssessment.overlappingPaths.length > 0
                          ? overlapAssessment.overlappingPaths.slice(0, 6).join(", ")
                          : "No direct manifest-path overlap found."}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium">New paths</p>
                      <p className="break-words text-muted-foreground">
                        {overlapAssessment.newPaths.length > 0
                          ? overlapAssessment.newPaths.slice(0, 6).join(", ")
                          : "This preview does not add new manifest paths."}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border bg-muted/30 p-4 text-sm text-muted-foreground">
                  Generate a preview to see whether the save would create a new domain or update an
                  existing one.
                </div>
              )}
            </SurfaceInset>
          </div>

          <div className="space-y-4">
            <SurfaceInset className="space-y-3 px-4 py-4">
              <div>
                <h2 className="text-sm font-semibold">Backend organization</h2>
                <p className="text-sm text-muted-foreground">
                  This shows how the preview maps into PKM storage and scope exposure on the
                  backend.
                </p>
              </div>
              {backendOrganization ? (
                <div className="space-y-3 rounded-2xl border bg-muted/30 p-4 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">Domain: {backendOrganization.targetDomain}</Badge>
                    <Badge variant="secondary">Action: {backendOrganization.action}</Badge>
                    <Badge variant="secondary">
                      Manifest v{backendOrganization.manifestVersion}
                    </Badge>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0">
                      <p className="font-medium">Segments</p>
                      <p className="break-words text-muted-foreground">
                        {backendOrganization.segmentIds.length > 0
                          ? backendOrganization.segmentIds.join(", ")
                          : "No explicit segments yet"}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium">Top-level scopes</p>
                      <p className="break-words text-muted-foreground">
                        {backendOrganization.topLevelScopes.length > 0
                          ? backendOrganization.topLevelScopes.join(", ")
                          : "No scopes derived yet"}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium">Manifest paths</p>
                      <p className="text-muted-foreground">{backendOrganization.pathCount}</p>
                    </div>
                    <div>
                      <p className="font-medium">Scope registry entries</p>
                      <p className="text-muted-foreground">
                        {backendOrganization.scopeRegistryCount}
                      </p>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium">Externalizable paths</p>
                    <p className="break-words text-muted-foreground">
                      {backendOrganization.externalizablePaths.length > 0
                        ? backendOrganization.externalizablePaths.join(", ")
                        : "No externalizable paths derived yet"}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border bg-muted/30 p-4 text-sm text-muted-foreground">
                  Generate a preview to see the backend storage plan.
                </div>
              )}
            </SurfaceInset>

            <SurfaceInset className="space-y-3 px-4 py-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">Structured output</h2>
                  <p className="text-sm text-muted-foreground">
                    Raw structured output is still available here for developer inspection, but the
                    sections above explain how it flows through preview and save.
                  </p>
                </div>
                {response ? (
                  <Badge variant="secondary" className="w-fit">
                    {response.used_fallback ? "Deterministic fallback" : response.model}
                  </Badge>
                ) : null}
              </div>
              <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-2xl border bg-muted/40 p-4 text-xs leading-6">
                {prettyResponse || "No preview generated yet."}
              </pre>
            </SurfaceInset>
          </div>
        </div>

        <div ref={explorerRef}>
          <PkmExplorerPanel />
        </div>
      </PkmSettingsShell>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showVaultUnlock}
          onOpenChange={setShowVaultUnlock}
          title="Unlock your vault"
          description="Unlock your vault here to preview and save PKM data."
          onSuccess={() => {
            setShowVaultUnlock(false);
            setError(null);
          }}
        />
      ) : null}

      <AlertDialog open={showSaveConfirm} onOpenChange={setShowSaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm PKM save</AlertDialogTitle>
            <AlertDialogDescription>
              {overlapAssessment?.note ||
                "This preview may update an existing domain. Review the overlap summary before saving."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              {overlapAssessment?.targetDomain ? (
                <Badge variant="secondary">Domain: {overlapAssessment.targetDomain}</Badge>
              ) : null}
              {overlapAssessment?.action ? (
                <Badge variant="secondary">Action: {overlapAssessment.action}</Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground">
              Preview did not write anything. Continuing now will encrypt the inferred payload with
              the active vault key and write a new PKM revision for this domain.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Review again</AlertDialogCancel>
            <AlertDialogAction onClick={() => void persistPreview()}>
              Save to PKM
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
