"use client";

import { useState } from "react";
import { NotebookPen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { addNoteEntity, buildSageNoteSummaryPatch } from "@/lib/sage/add-note-entity";
import { PersonalKnowledgeModelService, type DomainSummary } from "@/lib/services/personal-knowledge-model-service";

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * A direct, real write into any domain -- same addNoteEntity +
 * buildSageNoteSummaryPatch + PkmWriteCoordinator path Sage's other save
 * actions use, just exposed as its own small tool instead of being wedged
 * into Ask Sage or the misfiled-note fix. Useful for quickly adding real
 * texture to a thin domain without needing Kai chat.
 */
export function AddNotePanel({
  domains,
  onSaved,
}: {
  domains: DomainSummary[];
  onSaved?: () => void;
}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [domainKey, setDomainKey] = useState(domains[0]?.key || "");
  const [text, setText] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const effectiveDomainKey = domainKey || domains[0]?.key || "";
  const domain = domains.find((d) => d.key === effectiveDomainKey);

  async function handleSave() {
    const trimmed = text.trim();
    if (!trimmed || !user?.uid || !vaultKey || !vaultOwnerToken || !domain) return;
    setState("saving");
    setError(null);
    try {
      // Re-fetch live rather than trusting the `domains` prop -- adding two
      // notes to the same domain back to back (before the parent's onSaved
      // refresh lands) would otherwise silently overwrite the first note's
      // highlight line, since readable_highlights is replaced wholesale on
      // write, not merged server-side.
      const freshDomains = await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken)
        .then((m) => m.domains)
        .catch(() => domains);
      const freshDomain = freshDomains.find((d) => d.key === domain.key) || domain;
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: domain.key,
        vaultKey,
        vaultOwnerToken,
        confirmation: { confirmedByUser: true, surface: "web", source: "sage_manual" },
        build: (context) => ({
          domainData: addNoteEntity(context.currentDomainData, trimmed, "sage_manual"),
          mergeDecision: { merge_mode: "replace_domain", target_domain: domain.key },
          summary: {
            source: "sage_manual",
            message_excerpt: trimmed.slice(0, 160),
            ...buildSageNoteSummaryPatch({
              displayName: freshDomain.displayName,
              existingHighlights: freshDomain.readableHighlights || [],
              noteText: trimmed,
            }),
          },
        }),
      });
      if (!result.success) {
        setState("error");
        setError(result.message || "Couldn't save that just now.");
        return;
      }
      setState("saved");
      setText("");
      onSaved?.();
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Couldn't save that just now.");
    }
  }

  if (domains.length === 0) return null;

  return (
    <div className="rounded-2xl border border-blue-500/25 bg-card/85 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-blue-700 dark:text-blue-300">
        <NotebookPen className="h-4 w-4" aria-hidden />
        Add a note
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Write a real note straight into a domain -- the same safe write path Sage uses everywhere
        else.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <select
          value={effectiveDomainKey}
          onChange={(event) => {
            setDomainKey(event.target.value);
            setState("idle");
          }}
          className="h-10 w-full rounded-md border border-border/60 bg-card px-3 text-sm text-foreground sm:w-auto"
        >
          {domains.map((d) => (
            <option key={d.key} value={d.key}>
              {d.displayName}
            </option>
          ))}
        </select>
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="e.g. Bought running shoes and a winter jacket from REI last week, about $310 total."
          className="min-h-[3rem] resize-none"
          rows={2}
        />
        <Button onClick={() => void handleSave()} disabled={state === "saving" || !text.trim()} className="sm:w-auto">
          {state === "saving" ? "Saving…" : "Save note"}
        </Button>
      </div>

      {state === "saved" ? (
        <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">Saved to {domain?.displayName}.</p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
