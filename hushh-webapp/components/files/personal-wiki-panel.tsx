"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FilesMarkdownDocumentSheet,
  type FilesMarkdownDocumentTarget,
} from "@/components/files/files-markdown-document-sheet";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderLock,
  RefreshCw,
  Upload,
} from "@/components/icons";
import {
  hydrateFilesCacheFromEncryptedCache,
  hydrateFilesWikiPageFromEncryptedCache,
  peekFilesWikiOverviewCache,
  peekFilesWikiPageCache,
} from "@/lib/files/files-cache";
import {
  FilesService,
  type FileEntry,
  type WikiOptimizationResult,
  type WikiOverview,
  type WikiSummaryPage,
} from "@/lib/files/service";
import {
  resolveWikiPageFolder,
  wikiPageSlugFilename,
} from "@/lib/files/wiki/migration-and-maintenance";
import {
  CORE_AGENT_MARKDOWN_IDS,
  CORE_AGENT_MARKDOWN_META,
  isCoreAgentMarkdownId,
  loadCoreAgentMarkdownFile,
  peekCoreAgentMarkdownFile,
  saveCoreAgentMarkdownFile,
  type CoreAgentMarkdownId,
} from "@/lib/pkm/agent-core-markdown-files";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";
import type { FilesAction } from "./files-settings-panel";

function formatIsoDate(statusAsOf?: string, updatedAt?: number): string {
  if (statusAsOf && /^\d{4}-\d{2}-\d{2}/.test(statusAsOf)) {
    return statusAsOf.slice(0, 10);
  }
  if (updatedAt && Number.isFinite(updatedAt) && updatedAt > 0) {
    try {
      return new Date(updatedAt).toISOString().slice(0, 10);
    } catch {
      return "—";
    }
  }
  return "—";
}

function formatFolderLabel(folder: string): string {
  return folder
    .split("/")
    .map((part) =>
      part
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase()),
    )
    .join(" / ");
}

type EnrichedWikiFile = WikiSummaryPage & {
  resolvedFolder: string;
  filename: string;
  modifiedDate: string;
};

export function PersonalWikiPanel({
  ownerId,
  busy,
  unavailable,
  act,
  initialDocId,
  initialPageId,
  onInitialSelectionConsumed,
}: {
  ownerId: string | undefined;
  busy: boolean;
  unavailable: boolean;
  act: FilesAction;
  initialDocId?: string | null;
  initialPageId?: string | null;
  onInitialSelectionConsumed?: () => void;
}) {
  const { vaultKey, vaultOwnerToken } = useVault();
  const [overview, setOverview] = useState<WikiOverview | null>(() =>
    ownerId ? peekFilesWikiOverviewCache(ownerId) : null,
  );
  const [savedArchives, setSavedArchives] = useState<FileEntry[]>([]);
  const [docTarget, setDocTarget] =
    useState<FilesMarkdownDocumentTarget | null>(null);
  const [loading, setLoading] = useState(
    () => !(ownerId && peekFilesWikiOverviewCache(ownerId)),
  );
  const [hydratingWiki, setHydratingWiki] = useState<boolean>(() =>
    Boolean(ownerId && vaultKey && !peekFilesWikiOverviewCache(ownerId)),
  );
  const [loadError, setLoadError] = useState("");
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<
    Record<string, boolean>
  >({});
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  const [optimizationReceipt, setOptimizationReceipt] =
    useState<WikiOptimizationResult | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const localAbort = useRef<AbortController | null>(null);
  const getActiveSignal = useCallback(
    () => (localAbort.current ?? (localAbort.current = new AbortController())).signal,
    [],
  );
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const initialHandledRef = useRef<string | null>(null);
  const lastOwnerRef = useRef<string | undefined>(ownerId);
  const hasRenderedOverviewRef = useRef<boolean>(Boolean(overview));

  useEffect(() => {
    if (!ownerId || !vaultKey || !vaultOwnerToken) {
      setDocTarget(null);
    }
  }, [ownerId, vaultKey, vaultOwnerToken]);

  const loadOverview = useCallback(async (activeSignal: AbortSignal) => {
    const next = await FilesService.wikiOverview(activeSignal);
    activeSignal.throwIfAborted();
    setOverview(next);
    setLoadError("");
    setLoading(false);
    void FilesService.list("root", "", false, activeSignal)
      .then((rootList) => {
        if (activeSignal.aborted) return;
        setSavedArchives(
          rootList.entries
            .filter(
              (entry) =>
                entry.kind === "file" &&
                entry.state === "ready" &&
                /\.(zip|json)$/i.test(entry.name),
            )
            .slice(0, 5),
        );
      })
      .catch(() => undefined);
    return next;
  }, []);

  useEffect(() => {
    localAbort.current?.abort();
    const controller = new AbortController();
    localAbort.current = controller;

    if (lastOwnerRef.current !== ownerId) {
      lastOwnerRef.current = ownerId;
      setDocTarget(null);
      initialHandledRef.current = null;
      setFocusedFolder(null);
      setCollapsedFolders({});
      hasRenderedOverviewRef.current = false;
    } else if (unavailable && !hasRenderedOverviewRef.current) {
      setDocTarget((prev) => (prev?.kind === "core" ? prev : null));
    }
    setConfirmRollback(false);
    if (!ownerId) {
      setOverview(null);
      hasRenderedOverviewRef.current = false;
      setLoading(false);
      setHydratingWiki(false);
      return () => {
        controller.abort();
      };
    }

    const warmOverview = peekFilesWikiOverviewCache(ownerId);
    if (warmOverview) {
      setOverview(warmOverview);
      hasRenderedOverviewRef.current = true;
      setLoading(false);
      setHydratingWiki(false);
    }

    let canceled = false;
    void (async () => {
      let currentOverview = warmOverview;
      if (
        !currentOverview &&
        vaultKey &&
        typeof hydrateFilesCacheFromEncryptedCache === "function"
      ) {
        setHydratingWiki(true);
        try {
          const hydrated = await hydrateFilesCacheFromEncryptedCache(ownerId, vaultKey);
          if (controller.signal.aborted || canceled) return;
          if (hydrated.wikiOverview) {
            currentOverview = hydrated.wikiOverview;
            hasRenderedOverviewRef.current = true;
            setOverview(hydrated.wikiOverview);
            setLoading(false);
          }
        } catch {
          // Best-effort encrypted IDB hydration.
        } finally {
          if (!controller.signal.aborted && !canceled) {
            setHydratingWiki(false);
          }
        }
      } else {
        setHydratingWiki(false);
      }

      if (controller.signal.aborted || canceled) return;

      if (unavailable) {
        if (currentOverview) {
          setOverview(currentOverview);
          hasRenderedOverviewRef.current = true;
        }
        setLoading(false);
        return;
      }

      if (!currentOverview) {
        setLoading(true);
      }
      setLoadError("");
      try {
        const next = await loadOverview(controller.signal);
        if (!controller.signal.aborted && !canceled && next) {
          hasRenderedOverviewRef.current = true;
        }
      } catch {
        if (!controller.signal.aborted && !canceled && !currentOverview) {
          setLoadError("Could not open your personal wiki right now.");
        }
      } finally {
        if (!controller.signal.aborted && !canceled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      canceled = true;
      controller.abort();
    };
  }, [ownerId, unavailable, vaultKey, loadOverview]);

  const disabled = busy || unavailable || loading;

  const openCoreDoc = useCallback(
    async (docId: CoreAgentMarkdownId) => {
      if (!ownerId || !vaultKey || !vaultOwnerToken) return;
      const meta = CORE_AGENT_MARKDOWN_META[docId];
      const warm = peekCoreAgentMarkdownFile(ownerId, docId);
      if (warm) {
        setDocTarget({
          kind: "core",
          docId,
          title: meta.title,
          subtitle: meta.subtitle,
          markdown: warm.markdown,
          storedMarkdown: warm.storedMarkdown,
          persisted: warm.persisted,
          isDefaultTemplate: warm.isDefaultTemplate,
          updatedAt: warm.updatedAt,
        });
      }
      const loaded = await loadCoreAgentMarkdownFile({
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
        docId,
      });
      setDocTarget({
        kind: "core",
        docId,
        title: meta.title,
        subtitle: meta.subtitle,
        markdown: loaded.markdown,
        storedMarkdown: loaded.storedMarkdown,
        persisted: loaded.persisted,
        isDefaultTemplate: loaded.isDefaultTemplate,
        updatedAt: loaded.updatedAt,
      });
    },
    [ownerId, vaultKey, vaultOwnerToken],
  );

  const openPage = useCallback(
    async (pageId: string, expectedRevision?: number) => {
      let cachedPage = ownerId
        ? peekFilesWikiPageCache(ownerId, pageId)
        : null;
      if (
        !cachedPage &&
        ownerId &&
        vaultKey &&
        typeof hydrateFilesWikiPageFromEncryptedCache === "function"
      ) {
        cachedPage = await hydrateFilesWikiPageFromEncryptedCache(
          ownerId,
          vaultKey,
          pageId,
        ).catch(() => null);
      }
      const activeSignal = getActiveSignal();
      if (activeSignal.aborted) return;
      if (
        cachedPage &&
        (unavailable ||
          expectedRevision === undefined ||
          cachedPage.revision >= expectedRevision)
      ) {
        setDocTarget({ kind: "wiki", page: cachedPage });
        return;
      }
      if (cachedPage && !unavailable) {
        setDocTarget({ kind: "wiki", page: cachedPage });
      }
      if (unavailable) return;
      void act(
        async () => {
          const detail = await FilesService.wikiPage(pageId, activeSignal);
          activeSignal.throwIfAborted();
          setDocTarget({ kind: "wiki", page: detail });
        },
        "Note opened",
        false,
      );
    },
    [act, getActiveSignal, ownerId, unavailable, vaultKey],
  );

  useEffect(() => {
    if (!ownerId) return;
    if (isCoreAgentMarkdownId(initialDocId)) {
      if (!vaultKey || !vaultOwnerToken) return;
      const coreKey = `core:${ownerId}:${initialDocId}`;
      if (initialHandledRef.current === coreKey) return;
      initialHandledRef.current = coreKey;
      void openCoreDoc(initialDocId).finally(() => {
        onInitialSelectionConsumed?.();
      });
      return;
    }
    if (!initialPageId || (unavailable && !overview && !vaultKey)) return;
    const pageKey = `page:${ownerId}:${initialPageId}`;
    if (initialHandledRef.current === pageKey) return;
    initialHandledRef.current = pageKey;
    openPage(initialPageId);
    onInitialSelectionConsumed?.();
  }, [
    ownerId,
    unavailable,
    overview,
    vaultKey,
    vaultOwnerToken,
    initialDocId,
    initialPageId,
    openCoreDoc,
    openPage,
    onInitialSelectionConsumed,
  ]);

  const groupedFolders = useMemo(() => {
    const pages = overview?.pages ?? [];
    const seenSlugInFolder = new Map<string, number>();
    const enriched: EnrichedWikiFile[] = pages.map((page) => {
      const resolvedFolder = resolveWikiPageFolder(page);
      const baseName = wikiPageSlugFilename(page.title, page.pageId);
      const dedupeKey = `${resolvedFolder}/${baseName}`;
      const count = (seenSlugInFolder.get(dedupeKey) ?? 0) + 1;
      seenSlugInFolder.set(dedupeKey, count);
      const filename =
        count === 1 ? baseName : baseName.replace(/\.md$/i, `-${count}.md`);
      return {
        ...page,
        resolvedFolder,
        filename,
        modifiedDate: formatIsoDate(page.statusAsOf, page.updatedAt),
      };
    });

    const normalizedQuery = filterQuery.trim().toLowerCase();
    const filtered = enriched.filter((file) => {
      if (focusedFolder && file.resolvedFolder !== focusedFolder) return false;
      if (!normalizedQuery) return true;
      return (
        file.filename.toLowerCase().includes(normalizedQuery) ||
        file.title.toLowerCase().includes(normalizedQuery) ||
        file.resolvedFolder.toLowerCase().includes(normalizedQuery) ||
        file.tldr.toLowerCase().includes(normalizedQuery)
      );
    });

    const map = new Map<string, EnrichedWikiFile[]>();
    for (const item of filtered) {
      const list = map.get(item.resolvedFolder) ?? [];
      list.push(item);
      map.set(item.resolvedFolder, list);
    }

    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, files]) => {
        const sortedFiles = [...files].sort((a, b) =>
          a.filename.localeCompare(b.filename),
        );
        const latestModified =
          sortedFiles
            .map((f) => f.modifiedDate)
            .filter((d) => d !== "—")
            .sort()
            .at(-1) ?? "—";
        return { folder, files: sortedFiles, latestModified };
      });
  }, [overview?.pages, filterQuery, focusedFolder]);

  const visibleCoreDocs = useMemo(() => {
    if (focusedFolder) return [];
    const normalizedQuery = filterQuery.trim().toLowerCase();
    return CORE_AGENT_MARKDOWN_IDS.filter((docId) => {
      if (!normalizedQuery) return true;
      const meta = CORE_AGENT_MARKDOWN_META[docId];
      return (
        meta.title.toLowerCase().includes(normalizedQuery) ||
        meta.subtitle.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [filterQuery, focusedFolder]);

  return (
    <div className="space-y-3">
      {/* Compact 1-row Explorer Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/20 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
            <button
              type="button"
              className="font-mono hover:text-foreground hover:underline"
              onClick={() => setFocusedFolder(null)}
            >
              wiki/
            </button>
            {focusedFolder ? (
              <>
                <ChevronRight className="size-3" aria-hidden="true" />
                <span className="font-mono text-foreground">
                  {focusedFolder}/
                </span>
              </>
            ) : null}
          </div>
          <Input
            aria-label="Filter wiki files"
            placeholder="Quick open or filter .md files…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="h-8 min-w-[10rem] flex-1 bg-background text-xs sm:max-w-xs"
          />
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            aria-label="Choose ChatGPT or Claude export file"
            className="hidden"
            disabled={disabled}
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (!chosen || disabled) return;
              const activeSignal = getActiveSignal();
              void act(
                async () => {
                  const uploaded = await FilesService.upload(
                    chosen,
                    "root",
                    () => undefined,
                    activeSignal,
                  );
                  await FilesService.wikiImportArchive(
                    { fileId: uploaded.id, sourceProvider: "auto" },
                    activeSignal,
                  );
                  await loadOverview(activeSignal);
                },
                "History imported into wiki",
                false,
              );
            }}
          />
          {overview ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <span>Auto-save</span>
              <Switch
                size="ios"
                aria-label="Remember from conversations"
                checked={Boolean(overview.captureOptIn)}
                disabled={disabled}
                onCheckedChange={(enabled) => {
                  const activeSignal = getActiveSignal();
                  void act(
                    async () => {
                      await FilesService.wikiSetOptIn(enabled, activeSignal);
                      await loadOverview(activeSignal);
                    },
                    enabled
                      ? "Conversation memory on"
                      : "Conversation memory off",
                    false,
                  );
                }}
              />
            </label>
          ) : null}
          {!unavailable && !loadError ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="compact"
                data-testid="wiki-optimize-memory-button"
                disabled={disabled || optimizing}
                onClick={() => {
                  const activeSignal = getActiveSignal();
                  setOptimizing(true);
                  void act(
                    async () => {
                      try {
                        const result = await FilesService.wikiOptimize(activeSignal);
                        activeSignal.throwIfAborted();
                        setOptimizationReceipt(result);
                        await loadOverview(activeSignal);
                      } finally {
                        setOptimizing(false);
                      }
                    },
                    "Memory optimized",
                    false,
                  );
                }}
              >
                <RefreshCw
                  className={`mr-1.5 size-3.5 ${optimizing ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {optimizing ? "Optimizing…" : "Optimize memory"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="compact"
                disabled={disabled}
                onClick={() => importInputRef.current?.click()}
              >
                <Upload className="mr-1.5 size-3.5" aria-hidden="true" />
                Import archive
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {optimizationReceipt ? (
        <div
          role="status"
          data-testid="wiki-optimize-memory-receipt"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/25 px-3.5 py-2 text-xs text-muted-foreground"
        >
          <span>
            Optimized {optimizationReceipt.inspectedPageCount}{" "}
            {optimizationReceipt.inspectedPageCount === 1 ? "page" : "pages"} ·{" "}
            {optimizationReceipt.deduplicatedClaimCount} duplicates merged ·{" "}
            {optimizationReceipt.staleRetiredCount} stale retired ·{" "}
            {optimizationReceipt.structureRepairsCount} structure{" "}
            {optimizationReceipt.structureRepairsCount === 1 ? "fix" : "fixes"}
            {optimizationReceipt.protectedGrantScopes.length > 0
              ? ` · ${optimizationReceipt.protectedGrantScopes.length} shared/paid ${
                  optimizationReceipt.protectedGrantScopes.length === 1
                    ? "scope"
                    : "scopes"
                } protected`
              : ""}
            {optimizationReceipt.contradictions.length > 0
              ? ` · ${optimizationReceipt.contradictions.length} ${
                  optimizationReceipt.contradictions.length === 1
                    ? "conflict needs"
                    : "conflicts need"
                } review`
              : ""}
          </span>
          <button
            type="button"
            className="text-xs font-medium text-foreground/75 hover:text-foreground"
            onClick={() => setOptimizationReceipt(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Unified Nested Wiki File-System Explorer Table */}
      <div
        className="divide-y overflow-hidden rounded-2xl border"
        aria-label="Personal wiki files"
      >
        <div
          aria-hidden="true"
          className="hidden sm:flex items-center gap-3 bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground"
        >
          <span className="min-w-0 flex-1">Name</span>
          <span className="w-24 shrink-0">Type</span>
          <span className="w-28 shrink-0">Last modified</span>
          <span className="w-16 shrink-0 text-right">Size</span>
        </div>

        {/* Nested Scope / Domain Folders + Distinct .md Files */}
        {groupedFolders.map(({ folder, files, latestModified }) => {
          const isCollapsed =
            Boolean(collapsedFolders[folder]) &&
            !filterQuery.trim() &&
            !focusedFolder;
          return (
            <div key={folder} className="divide-y">
              <div className="flex min-w-0 items-center gap-2.5 bg-muted/10 px-3 py-2 hover:bg-muted/30 transition-colors sm:gap-3 sm:px-4">
                <button
                  type="button"
                  aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${folder} folder`}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setCollapsedFolders((prev) => ({
                      ...prev,
                      [folder]: !prev[folder],
                    }))
                  }
                >
                  {isCollapsed ? (
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="size-3.5" aria-hidden="true" />
                  )}
                </button>
                <FolderLock
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
                  onClick={() =>
                    setFocusedFolder((prev) =>
                      prev === folder ? null : folder,
                    )
                  }
                >
                  <span className="font-mono">{folder}/</span>
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {formatFolderLabel(folder)}
                  </span>
                </button>
                <span className="hidden sm:inline-block w-24 shrink-0 text-xs text-muted-foreground">
                  Folder
                </span>
                <span className="hidden sm:inline-block w-28 shrink-0 font-mono text-xs text-muted-foreground">
                  {latestModified}
                </span>
                <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                  {files.length} {files.length === 1 ? "file" : "files"}
                </span>
              </div>

              {!isCollapsed
                ? files.map((page) => (
                    <button
                      key={page.pageId}
                      type="button"
                      aria-label={`Open ${page.title}`}
                      disabled={busy || (unavailable && !overview) || (loading && !overview)}
                      onClick={() => openPage(page.pageId, page.revision)}
                      className="flex w-full min-w-0 items-center gap-2.5 py-2 pl-9 pr-3 text-left hover:bg-muted/30 transition-colors disabled:opacity-50 sm:gap-3 sm:pl-11 sm:pr-4"
                    >
                      <FileText
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                          <span className="truncate font-mono text-xs font-medium text-foreground">
                            {page.filename}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {page.title}
                          </span>
                        </div>
                        {page.tldr ? (
                          <p className="truncate text-[11px] text-muted-foreground/80">
                            {page.tldr}
                          </p>
                        ) : null}
                      </div>
                      <span className="hidden sm:inline-block w-24 shrink-0 text-xs text-muted-foreground">
                        Markdown
                      </span>
                      <span className="hidden sm:inline-block w-28 shrink-0 font-mono text-xs text-muted-foreground">
                        {page.modifiedDate}
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        r{page.revision}
                      </span>
                    </button>
                  ))
                : null}
            </div>
          );
        })}

        {/* Root Core Agent Markdown Files (memory.md, identity.md, soul.md) */}
        {visibleCoreDocs.map((docId) => {
          const meta = CORE_AGENT_MARKDOWN_META[docId];
          const warm = ownerId ? peekCoreAgentMarkdownFile(ownerId, docId) : null;
          const modified = warm?.updatedAt
            ? formatIsoDate(warm.updatedAt)
            : warm?.persisted
              ? "Saved"
              : "Core";
          const sizeLabel = warm?.markdown
            ? `${Math.max(1, Math.round(warm.markdown.length / 1024))} KB`
            : "Core";
          return (
            <button
              key={docId}
              type="button"
              data-testid={`wiki-core-doc-${docId}`}
              disabled={busy || !vaultKey || !vaultOwnerToken}
              onClick={() => void openCoreDoc(docId)}
              className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/30 transition-colors disabled:opacity-50 sm:gap-3 sm:px-4"
            >
              <FileText
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="truncate font-mono text-xs font-medium text-foreground">
                    {meta.title}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {meta.subtitle}
                  </span>
                </div>
              </div>
              <span className="hidden sm:inline-block w-24 shrink-0 text-xs text-muted-foreground">
                Markdown
              </span>
              <span className="hidden sm:inline-block w-28 shrink-0 font-mono text-xs text-muted-foreground">
                {modified}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {sizeLabel}
              </span>
            </button>
          );
        })}

        {!loading &&
        !hydratingWiki &&
        !unavailable &&
        !loadError &&
        groupedFolders.length === 0 &&
        visibleCoreDocs.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            {filterQuery.trim()
              ? "No matching markdown files in your personal wiki."
              : "No saved notes in this folder yet."}
          </p>
        ) : null}
      </div>

      {/* Inline Status / Error Feedback */}
      {unavailable && !overview && !hydratingWiki ? (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          Checking your Personal wiki connection…
        </p>
      ) : loading && !overview && !hydratingWiki ? (
        <div
          role="status"
          aria-label="Loading personal wiki"
          data-testid="personal-wiki-cold-skeleton"
          className="overflow-hidden rounded-xl border border-border/60"
        >
          <span className="sr-only">Opening personal wiki…</span>
          <div className="divide-y divide-border/50">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="grid h-10 grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3 px-3.5 sm:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_4.5rem]"
              >
                <div className="h-3.5 w-44 animate-pulse rounded bg-muted/70 motion-reduce:animate-none" />
                <div className="hidden h-3 w-14 animate-pulse rounded bg-muted/60 motion-reduce:animate-none sm:block" />
                <div className="hidden h-3 w-20 animate-pulse rounded bg-muted/60 motion-reduce:animate-none sm:block" />
                <div className="ml-auto h-3 w-10 animate-pulse rounded bg-muted/60 motion-reduce:animate-none" />
              </div>
            ))}
          </div>
        </div>
      ) : loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2">
          <p role="alert" className="text-xs text-muted-foreground">
            {loadError}
          </p>
          <Button
            variant="outline"
            size="compact"
            disabled={busy || unavailable}
            onClick={() => {
              const activeSignal = getActiveSignal();
              void act(
                () => loadOverview(activeSignal),
                "Personal wiki refreshed",
                false,
              );
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {/* Un-imported Archives Found in Root Blobstorage */}
      {savedArchives.length > 0 ? (
        <div className="divide-y rounded-xl border">
          {savedArchives.map((archive) => (
            <div
              key={archive.id}
              className="flex min-w-0 items-center justify-between gap-2 px-3 py-2 text-xs"
            >
              <span className="min-w-0 truncate font-mono">{archive.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                aria-label={`Add ${archive.name} to wiki`}
                disabled={disabled}
                onClick={() => {
                  const activeSignal = getActiveSignal();
                  void act(
                    async () => {
                      await FilesService.wikiImportArchive(
                        { fileId: archive.id, sourceProvider: "auto" },
                        activeSignal,
                      );
                      await loadOverview(activeSignal);
                    },
                    "Archive added to wiki",
                    false,
                  );
                }}
              >
                Add to wiki
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Compact Pending Memory Candidate Confirmations (Only When Non-Empty) */}
      {overview && overview.candidateReceipts.length > 0 ? (
        <div className="divide-y overflow-hidden rounded-xl border">
          <div className="flex items-center justify-between bg-muted/20 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            <span>
              Pending memory updates ({overview.candidateReceipts.length})
            </span>
            <span>Confirm to sync</span>
          </div>
          {overview.candidateReceipts.map((item) => (
            <div
              key={item.receiptId}
              className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">
                  {item.statement || `Pending update in ${item.domain}`}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {item.state === "private_candidate"
                    ? (item.activeRecipientCount ?? 0) > 0
                      ? `${item.domain}/ · shared with ${item.activeRecipientCount} active ${item.activeRecipientCount === 1 ? "recipient" : "recipients"}`
                      : `${item.domain}/`
                    : `Differs from verified ${item.domain} details`}
                </p>
              </div>
              {item.state === "private_candidate" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="compact"
                  disabled={disabled}
                  onClick={() => {
                    const activeSignal = getActiveSignal();
                    void act(
                      async () => {
                        await FilesService.wikiConfirmCandidate(
                          item.receiptId,
                          activeSignal,
                        );
                        await loadOverview(activeSignal);
                      },
                      "Update confirmed",
                      false,
                    );
                  }}
                >
                  Confirm
                </Button>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Needs review
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {/* Secondary Migration & Recovery Disclosure */}
      {overview ? (
        <details className="px-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1.5 font-medium hover:text-foreground">
            Migration and recovery
          </summary>
          <div className="space-y-2 pb-1 pt-1">
            {overview.migrationState === "v1_markdown_only" ? (
              <>
                <p>
                  Compile your existing classic notes into cited wiki pages and
                  verify parity before switching over.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="compact"
                  disabled={disabled}
                  onClick={() => {
                    const activeSignal = getActiveSignal();
                    void act(
                      async () => {
                        await FilesService.wikiMigrateCohort(
                          {
                            action: "compile_and_verify",
                            expectedMigrationRevision:
                              overview.migrationRevision,
                          },
                          activeSignal,
                        );
                        await loadOverview(activeSignal);
                      },
                      "Classic notes verified in wiki",
                      false,
                    );
                  }}
                >
                  Verify classic notes
                </Button>
              </>
            ) : null}

            {overview.migrationState === "dual_read_shadow_compile" ? (
              <>
                <p>
                  {overview.dualReadQualified
                    ? "Parity verified. Switch chat recall to your personal wiki while keeping classic rollback available."
                    : "Re-run verification to qualify parity before switching chat recall to your personal wiki."}
                </p>
                <div className="flex flex-wrap gap-2">
                  {overview.dualReadQualified ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="compact"
                      disabled={disabled}
                      onClick={() => {
                        const activeSignal = getActiveSignal();
                        void act(
                          async () => {
                            await FilesService.wikiMigrateCohort(
                              {
                                action: "cutover_rollback_safe",
                                expectedMigrationRevision:
                                  overview.migrationRevision,
                              },
                              activeSignal,
                            );
                            await loadOverview(activeSignal);
                          },
                          "Switched recall to personal wiki",
                          false,
                        );
                      }}
                    >
                      Use wiki as primary
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="compact"
                      disabled={disabled}
                      onClick={() => {
                        const activeSignal = getActiveSignal();
                        void act(
                          async () => {
                            await FilesService.wikiMigrateCohort(
                              {
                                action: "compile_and_verify",
                                expectedMigrationRevision:
                                  overview.migrationRevision,
                              },
                              activeSignal,
                            );
                            await loadOverview(activeSignal);
                          },
                          "Classic notes verified in wiki",
                          false,
                        );
                      }}
                    >
                      Re-verify classic notes
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    disabled={disabled}
                    onClick={() => setConfirmRollback(true)}
                  >
                    Switch back to classic notes
                  </Button>
                </div>
              </>
            ) : null}

            {overview.migrationState === "wiki_primary_with_v1_rollback" ? (
              <>
                <p>
                  Personal wiki is active with classic single-note rollback
                  available. Forgotten facts stay removed.
                </p>
                <div className="flex flex-wrap gap-2">
                  {overview.coldRecoveryQualified ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="compact"
                      disabled={disabled}
                      onClick={() => {
                        const activeSignal = getActiveSignal();
                        void act(
                          async () => {
                            await FilesService.wikiMigrateCohort(
                              {
                                action: "graduate_wiki_primary",
                                expectedMigrationRevision:
                                  overview.migrationRevision,
                              },
                              activeSignal,
                            );
                            await loadOverview(activeSignal);
                          },
                          "Classic note writer retired",
                          false,
                        );
                      }}
                    >
                      Retire classic writer
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="compact"
                    disabled={disabled}
                    onClick={() => setConfirmRollback(true)}
                  >
                    Switch back to classic notes
                  </Button>
                </div>
              </>
            ) : null}

            {overview.migrationState === "wiki_primary" ? (
              <p>
                Personal wiki is your active memory store and classic
                single-note writes are retired.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      <FilesMarkdownDocumentSheet
        open={docTarget !== null}
        target={docTarget}
        busy={docTarget?.kind === "core" ? busy : disabled}
        initialMode="preview"
        onClose={() => setDocTarget(null)}
        onSaveCore={async ({
          docId,
          markdown,
          expectedStoredMarkdown,
          expectedPersisted,
        }) => {
          if (!ownerId || !vaultKey || !vaultOwnerToken) return false;
          const epoch = snapshotVaultSessionEpoch();
          let savedOk = false;
          await act(
            async () => {
              const saved = await saveCoreAgentMarkdownFile({
                userId: ownerId,
                vaultKey,
                vaultOwnerToken,
                docId,
                markdown,
                expectedStoredMarkdown,
                expectedPersisted,
                beforeEffect: async () => {
                  if (!isVaultSessionEpochCurrent(epoch)) {
                    throw new DOMException(
                      "Vault locked before save",
                      "AbortError",
                    );
                  }
                },
              });
              if (!saved.success || !saved.document) {
                throw new Error(saved.message ?? `Could not save ${docId}.`);
              }
              const meta = CORE_AGENT_MARKDOWN_META[docId];
              setDocTarget({
                kind: "core",
                docId,
                title: meta.title,
                subtitle: meta.subtitle,
                markdown: saved.document.markdown,
                storedMarkdown: saved.document.storedMarkdown,
                persisted: saved.document.persisted,
                isDefaultTemplate: saved.document.isDefaultTemplate,
                updatedAt: saved.document.updatedAt,
              });
              savedOk = true;
            },
            `${docId} saved`,
            false,
          );
          return savedOk;
        }}
        onSaveWiki={async ({ pageId, expectedRevision, title, tldr, body }) => {
          const activeSignal = getActiveSignal();
          let savedOk = false;
          await act(
            async () => {
              await FilesService.wikiSavePage(
                { pageId, expectedRevision, title, tldr, body },
                activeSignal,
              );
              const refreshed = await FilesService.wikiPage(
                pageId,
                activeSignal,
              );
              await loadOverview(activeSignal);
              activeSignal.throwIfAborted();
              setDocTarget({ kind: "wiki", page: refreshed });
              savedOk = true;
            },
            "Note saved",
            false,
          );
          return savedOk;
        }}
        onForgetWikiClaim={async ({ pageId, claimId }) => {
          const activeSignal = getActiveSignal();
          await act(
            async () => {
              await FilesService.wikiForgetClaim(
                { pageId, claimId },
                activeSignal,
              );
              const refreshed = await FilesService.wikiPage(
                pageId,
                activeSignal,
              );
              await loadOverview(activeSignal);
              activeSignal.throwIfAborted();
              setDocTarget({ kind: "wiki", page: refreshed });
            },
            "Fact forgotten",
            false,
          );
        }}
      />

      <AlertDialog
        open={confirmRollback}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmRollback(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch back to classic notes?</AlertDialogTitle>
            <AlertDialogDescription>
              Restores classic single-note memory while keeping forgotten facts
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Stay on wiki</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const activeSignal = getActiveSignal();
                setConfirmRollback(false);
                void act(
                  async () => {
                    await FilesService.wikiRollbackClassic(activeSignal);
                    await loadOverview(activeSignal);
                  },
                  "Switched back to classic notes",
                  false,
                );
              }}
            >
              Switch back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
