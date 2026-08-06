"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  BookOpen,
  Briefcase,
  Landmark,
  Plane,
  Search,
  ShoppingBag,
  X,
} from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AddNotePanel } from "@/components/sage/add-note-panel";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  PersonalKnowledgeModelService,
  type DomainSummary,
} from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { archiveMatchingNoteEntity, buildArchivedNoteSummaryPatch } from "@/lib/sage/add-note-entity";

const DOMAIN_ICON: Record<string, typeof Landmark> = {
  financial: Landmark,
  professional: Briefcase,
  shopping: ShoppingBag,
  travel: Plane,
  kyc_connector: BadgeCheck,
};

const NOTE_PREFIX = /^saved from your note:\s*/i;

type NoteEntry = {
  id: string;
  domainKey: string;
  domainDisplayName: string;
  text: string;
  updatedAt: string | null;
};

function extractNotes(domain: DomainSummary): NoteEntry[] {
  const highlights = Array.isArray(domain.readableHighlights) ? domain.readableHighlights : [];
  const notes: NoteEntry[] = [];
  highlights.forEach((line, index) => {
    if (!NOTE_PREFIX.test(line)) return;
    const text = line.replace(NOTE_PREFIX, "").trim();
    if (!text) return;
    notes.push({
      id: `${domain.key}_${index}`,
      domainKey: domain.key,
      domainDisplayName: domain.displayName,
      text,
      updatedAt: domain.readableUpdatedAt || domain.lastUpdated,
    });
  });
  return notes;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Sage's "searchable personal archive": every raw note Kai/One has ever
 * captured verbatim ("Saved from your note: ..."), across every domain,
 * in one place with a plain-text filter -- no new capture mechanism,
 * this is real data that already exists per-domain, just never surfaced
 * together before.
 */
export function NotesArchivePanel() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [loading, setLoading] = useState(true);
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [query, setQuery] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // forceRefresh=true bypasses the metadata cache -- required right after a
  // write, since a stale-ok read here can hand back the pre-write snapshot.
  // The plain mount-time call below stays stale-ok since nothing has
  // changed yet from this component's view.
  async function refresh(forceRefresh = false) {
    if (!user?.uid || !vaultOwnerToken) {
      setLoading(false);
      return;
    }
    try {
      const metadata = await PersonalKnowledgeModelService.getMetadata(user.uid, forceRefresh, vaultOwnerToken);
      setDomains(metadata.domains);
      const all = metadata.domains.flatMap(extractNotes).sort((a, b) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bTime - aTime;
      });
      setNotes(all);
    } catch {
      // Best-effort only -- leaves domains/notes at their previous value.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Only re-run when the user/token actually changes -- refresh() is also
    // called directly from AddNotePanel's onSaved below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, vaultOwnerToken]);

  // Archives the underlying entity (never deletes) and strips it from
  // readable_highlights. Removes it from local state immediately on
  // success (rather than relying solely on the follow-up refresh) so the
  // click always reads as having done something even if that refresh is
  // slow. Fails the write outright if no matching entity is found, rather
  // than silently dropping the note from the summary while the underlying
  // entity stays active (which would orphan it).
  async function handleRemoveNote(note: NoteEntry) {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return;
    setRemovingId(note.id);
    setRemoveError(null);
    try {
      // Re-fetch live rather than trusting the `domains` snapshot -- readable_highlights
      // is replaced wholesale on write, not merged server-side, so a stale local
      // snapshot here could silently drop a newer highlight line added elsewhere.
      const domain = domains.find((d) => d.key === note.domainKey);
      const freshDomains = await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken)
        .then((m) => m.domains)
        .catch(() => domains);
      const freshDomain = freshDomains.find((d) => d.key === note.domainKey) || domain;
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: note.domainKey,
        vaultKey,
        vaultOwnerToken,
        confirmation: { confirmedByUser: true, surface: "web", source: "sage_note_remove" },
        build: (context) => {
          const archived = archiveMatchingNoteEntity(context.currentDomainData, note.text, "Removed by user");
          if (!archived.matched) {
            throw new Error("Couldn't find that note to remove.");
          }
          return {
            domainData: archived.domainData,
            mergeDecision: { merge_mode: "replace_domain", target_domain: note.domainKey },
            summary: {
              source: "sage_note_remove",
              ...buildArchivedNoteSummaryPatch({
                existingHighlights: freshDomain?.readableHighlights || [],
                noteText: note.text,
              }),
            },
          };
        },
      });
      if (!result.success) {
        setRemoveError(result.message || "Couldn't remove that note just now.");
        return;
      }
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      void refresh(true);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Couldn't remove that note just now.");
    } finally {
      setRemovingId(null);
    }
  }

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return notes;
    return notes.filter(
      (note) =>
        note.text.toLowerCase().includes(trimmed) ||
        note.domainDisplayName.toLowerCase().includes(trimmed),
    );
  }, [notes, query]);

  return (
    <div className="space-y-4">
      <AddNotePanel domains={domains} onSaved={() => void refresh(true)} />
      {removeError ? <p className="text-sm text-destructive">{removeError}</p> : null}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : notes.length === 0 ? (
        <Empty className="border-blue-500/20 bg-blue-500/[0.03] dark:border-blue-400/20 dark:bg-blue-400/[0.03]">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-blue-500/10 text-blue-700 dark:text-blue-300">
              <BookOpen className="size-6" aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No raw notes yet</EmptyTitle>
            <EmptyDescription>
              When you tell Kai something in your own words -- or add one above -- the exact
              wording gets saved here too, not just the cleaned-up summary.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your notes…"
              className="pl-9"
            />
          </div>

          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No notes match &ldquo;{query}&rdquo;.</p>
          ) : (
            <div className="space-y-2.5">
              {filtered.map((note) => {
                const Icon = DOMAIN_ICON[note.domainKey] || BookOpen;
                return (
                  <div
                    key={note.id}
                    className="group relative flex items-start gap-3 rounded-xl border border-border/60 bg-card/85 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-700 dark:text-blue-300">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1 pr-6">
                      <p className="text-sm leading-5 text-foreground">&ldquo;{note.text}&rdquo;</p>
                      <p className="mt-1.5 text-xs text-muted-foreground/80">
                        {note.domainDisplayName}
                        {formatDate(note.updatedAt) ? ` · ${formatDate(note.updatedAt)}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRemoveNote(note)}
                      disabled={removingId === note.id}
                      className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-100"
                      aria-label="Remove this note"
                      title="Remove this note"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
