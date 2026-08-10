"use client";

import { useMemo, useState } from "react";
import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PersonalKnowledgeModelService, type DomainSummary } from "@/lib/services/personal-knowledge-model-service";
import { buildPkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";
import { SageMarkdown } from "@/components/sage/sage-markdown";

type DraftState = "idle" | "drafting" | "done" | "error";

/**
 * Sage drafting a real self-assessment from your own accumulated history in
 * one domain (usually "professional") -- decrypts that domain client-side,
 * flattens it into real text fragments (reusing the same walker the PKM
 * explorer uses), and asks Sage to synthesize a structured document from
 * ONLY those real fragments. No new capture mechanism, no fabricated
 * accomplishments -- just what you've already told Kai over time.
 */
export function SelfReviewPanel({ domains }: { domains: DomainSummary[] }) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  // "Professional" is the natural default for a self-assessment, but not if
  // it's nearly empty while another domain has real substance -- defaulting
  // to a thin domain would draft a thin document. Only overrides the
  // professional default when another domain has meaningfully more (2x+).
  const preferredDomain = useMemo(() => {
    if (domains.length === 0) return undefined;
    const professional = domains.find((d) => d.key === "professional");
    const richest = [...domains].sort((a, b) => b.attributeCount - a.attributeCount)[0];
    if (professional && richest && richest.attributeCount > professional.attributeCount * 2) {
      return richest;
    }
    return professional || richest;
  }, [domains]);
  const [domainKey, setDomainKey] = useState<string>(preferredDomain?.key || "");
  const [state, setState] = useState<DraftState>("idle");
  const [document, setDocument] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveDomainKey = domainKey || preferredDomain?.key || "";
  const domain = domains.find((d) => d.key === effectiveDomainKey);

  async function handleDraft() {
    if (!user?.uid || !vaultKey || !vaultOwnerToken || !domain) return;
    setState("drafting");
    setError(null);
    try {
      const snapshot = await PkmDomainResourceService.getStaleFirst({
        userId: user.uid,
        domain: domain.key,
        vaultKey,
        vaultOwnerToken,
      });
      if (!snapshot?.data) {
        setDocument(`Not enough saved ${domain.displayName.toLowerCase()} history yet to draft a self-assessment.`);
        setState("done");
        return;
      }

      const metadata = await PersonalKnowledgeModelService.getMetadata(user.uid, false, vaultOwnerToken);
      const memorySnapshot = buildPkmMemorySnapshot({
        metadata,
        fullBlob: { [domain.key]: snapshot.data },
      });
      const fragments = memorySnapshot.cards
        .filter((card) => card.domain === domain.key)
        .map((card) => card.value)
        .filter(Boolean);

      const response = await ApiService.draftSageReview({
        vaultOwnerToken,
        domain: domain.key,
        displayName: domain.displayName,
        fragments,
      });
      if (!response.ok) {
        throw new Error("Sage couldn't draft that just now.");
      }
      const data = await response.json();
      setDocument(String(data.document || ""));
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sage couldn't draft that just now.");
      setState("error");
    }
  }

  if (domains.length === 0) return null;

  return (
    <div className="rounded-2xl border border-blue-500/25 bg-card/85 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-blue-700 dark:text-blue-300">
        <FileText className="h-4 w-4" aria-hidden />
        Draft a self-assessment
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Sage reads your real accumulated history in one domain and drafts a structured document --
        using only what you've actually told Kai, nothing invented.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={effectiveDomainKey}
          onChange={(event) => {
            setDomainKey(event.target.value);
            setState("idle");
            setDocument(null);
          }}
          className="rounded-md border border-border/60 bg-card px-2.5 py-2 text-sm text-foreground sm:w-auto"
        >
          {domains.map((d) => (
            <option key={d.key} value={d.key}>
              {d.displayName} ({d.attributeCount})
            </option>
          ))}
        </select>
        <Button onClick={() => void handleDraft()} disabled={state === "drafting" || !domain} className="sm:w-auto">
          {state === "drafting" ? "Drafting…" : "Draft my self-assessment"}
        </Button>
      </div>

      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}

      {document ? (
        <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3.5 dark:border-emerald-400/15 dark:bg-emerald-400/[0.03] sm:p-4">
          <SageMarkdown text={document} />
        </div>
      ) : null}
    </div>
  );
}
