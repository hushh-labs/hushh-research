"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { NativeFeatureBack, NativeFeaturePage } from "@/components/app-ui/native-feature-page";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  FileText,
  Loader2,
  PencilLine,
  Search,
  X,
} from "@/components/icons";
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
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import type { FileEntry, WikiPageDetail } from "@/lib/files/service";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import type { CoreAgentMarkdownId } from "@/lib/pkm/agent-core-markdown-files";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/utils/clipboard";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export type MarkdownSheetMode = "preview" | "source" | "edit";

export type FilesMarkdownDocumentTarget =
  | {
      kind: "core";
      docId: CoreAgentMarkdownId;
      title: string;
      subtitle: string;
      markdown: string;
      persisted: boolean;
      updatedAt: string | null;
      storedMarkdown: string;
      isDefaultTemplate: boolean;
    }
  | {
      kind: "wiki";
      page: WikiPageDetail;
    }
  | {
      kind: "file";
      entry: FileEntry;
      text: string;
    };

function sanitizeDownloadFilename(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "document.md";
}

function formatLineAndWordSummary(text: string): string {
  const trimmed = text.trim();
  const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${words} ${words === 1 ? "word" : "words"}`;
}

function isMarkdownLikeFilename(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

export function FilesMarkdownDocumentSheet({
  open,
  target,
  busy = false,
  initialMode = "preview",
  onClose,
  onSaveCore,
  onSaveWiki,
  onForgetWikiClaim,
}: {
  open: boolean;
  target: FilesMarkdownDocumentTarget | null;
  busy?: boolean;
  initialMode?: MarkdownSheetMode;
  onClose: () => void;
  onSaveCore?: (params: {
    docId: CoreAgentMarkdownId;
    markdown: string;
    expectedStoredMarkdown: string;
    expectedPersisted: boolean;
  }) => Promise<boolean>;
  onSaveWiki?: (params: {
    pageId: string;
    expectedRevision: number;
    title: string;
    tldr: string;
    body: string;
  }) => Promise<boolean>;
  onForgetWikiClaim?: (params: { pageId: string; claimId: string; statement: string }) => Promise<void>;
}) {
  const isMobile = useIsMobile();
  const nativePage = customNativePresentationEnabled();
  const owner = snapshotValidatedAuthSessionOwner();

  const editable = target?.kind === "core" || target?.kind === "wiki";
  const targetKey = target
    ? target.kind === "core"
      ? `core:${target.docId}:${target.updatedAt ?? ""}`
      : target.kind === "wiki"
        ? `wiki:${target.page.pageId}:${target.page.revision}`
        : `file:${target.entry.id}:${target.entry.revision}`
    : "empty";

  const [mode, setMode] = useState<MarkdownSheetMode>(initialMode);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [showFindBar, setShowFindBar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [forgetTarget, setForgetTarget] = useState<{
    pageId: string;
    claimId: string;
    statement: string;
  } | null>(null);

  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!target) return;
    setMode(editable ? initialMode : "preview");
    setSourceFilter("");
    setFindQuery("");
    setReplaceQuery("");
    setShowFindBar(false);
    setConfirmDiscardOpen(false);
    setForgetTarget(null);
    if (target.kind === "core") {
      setDraftTitle(target.title);
      setDraftSummary(target.subtitle);
      setDraftBody(target.markdown);
    } else if (target.kind === "wiki") {
      setDraftTitle(target.page.title);
      setDraftSummary(target.page.tldr);
      setDraftBody(target.page.body);
    } else {
      setDraftTitle(target.entry.name);
      setDraftSummary("");
      setDraftBody(target.text);
    }
  }, [targetKey, open, editable, initialMode, target]);

  const dirty = useMemo(() => {
    if (!target) return false;
    if (target.kind === "core") {
      return draftBody !== target.markdown;
    }
    if (target.kind === "wiki") {
      return (
        draftTitle !== target.page.title ||
        draftSummary !== target.page.tldr ||
        draftBody !== target.page.body
      );
    }
    return false;
  }, [target, draftTitle, draftSummary, draftBody]);

  const requestClose = useCallback(() => {
    if (saving || busy) return;
    if (dirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    onClose();
  }, [saving, busy, dirty, onClose]);

  useBackLayer(
    ROUTES.ONE_FILES,
    open && target !== null && !nativePage ? 3 : 0,
    () => {
      if (saving || busy) return true;
      requestClose();
      return true;
    },
  );

  const fullMarkdownForPreview = useMemo(() => {
    if (!target) return "";
    if (target.kind === "wiki") {
      const parts: string[] = [];
      if (draftTitle.trim()) parts.push(`# ${draftTitle.trim()}`);
      if (draftSummary.trim()) parts.push(`> ${draftSummary.trim()}`);
      if (draftBody.trim()) parts.push(draftBody.trim());
      return parts.join("\n\n");
    }
    return draftBody;
  }, [target, draftTitle, draftSummary, draftBody]);

  const sourceLines = useMemo(() => {
    const raw =
      target?.kind === "wiki" ? fullMarkdownForPreview : draftBody;
    const all = raw.split(/\r\n|\r|\n/);
    const needle = sourceFilter.trim().toLowerCase();
    return all
      .map((line, index) => ({ number: index + 1, line }))
      .filter((item) => !needle || item.line.toLowerCase().includes(needle));
  }, [target, fullMarkdownForPreview, draftBody, sourceFilter]);

  const filenameForDownload = useMemo(() => {
    if (!target) return "document.md";
    if (target.kind === "core") return target.docId;
    if (target.kind === "file") return sanitizeDownloadFilename(target.entry.name);
    return sanitizeDownloadFilename(`${draftTitle || target.page.pageId}.md`);
  }, [target, draftTitle]);

  const handleSave = useCallback(async () => {
    if (!target || saving || busy || !editable) return;
    setSaving(true);
    try {
      let ok = false;
      if (target.kind === "core" && onSaveCore) {
        ok = await onSaveCore({
          docId: target.docId,
          markdown: draftBody,
          expectedStoredMarkdown: target.storedMarkdown,
          expectedPersisted: target.persisted,
        });
      } else if (target.kind === "wiki" && onSaveWiki) {
        if (!draftTitle.trim()) {
          morphyToast.error("Note title cannot be empty.");
          return;
        }
        ok = await onSaveWiki({
          pageId: target.page.pageId,
          expectedRevision: target.page.revision,
          title: draftTitle,
          tldr: draftSummary,
          body: draftBody,
        });
      }
      if (ok) {
        setMode("preview");
      }
    } finally {
      setSaving(false);
    }
  }, [target, saving, busy, editable, onSaveCore, onSaveWiki, draftBody, draftTitle, draftSummary]);

  const handleCopy = useCallback(async () => {
    const content = target?.kind === "wiki" ? fullMarkdownForPreview : draftBody;
    const copiedOk = await copyToClipboard(content);
    if (copiedOk) {
      setCopied(true);
      morphyToast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1800);
    }
  }, [target, fullMarkdownForPreview, draftBody]);

  const handleDownload = useCallback(() => {
    const content = target?.kind === "wiki" ? fullMarkdownForPreview : draftBody;
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filenameForDownload;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [target, fullMarkdownForPreview, draftBody, filenameForDownload]);

  const handleReplaceAll = useCallback(() => {
    if (!findQuery) return;
    const escaped = findQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    const next = draftBody.replace(regex, replaceQuery);
    if (next !== draftBody) {
      setDraftBody(next);
      morphyToast.success("Replaced matching text");
    } else {
      morphyToast.info("No matches found");
    }
  }, [findQuery, replaceQuery, draftBody]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && editable && mode === "edit") {
        event.preventDefault();
        void handleSave();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        if (mode === "edit") {
          event.preventDefault();
          setShowFindBar((prev) => !prev);
        }
      }
    },
    [editable, mode, handleSave],
  );

  const headerTitle =
    target?.kind === "core"
      ? target.title
      : target?.kind === "wiki"
        ? draftTitle.trim() || "Personal wiki note"
        : target?.entry.name ?? "Document";

  const headerSubtitle =
    target?.kind === "core"
      ? `${target.subtitle}${target.isDefaultTemplate ? " · Default template" : ""}`
      : target?.kind === "wiki"
        ? target.page.statusAsOf
          ? `Personal wiki · Updated ${target.page.statusAsOf}`
          : "Personal wiki note"
        : formatLineAndWordSummary(draftBody);

  const activeClaims =
    target?.kind === "wiki"
      ? target.page.claims.filter((claim) => claim.status === "active")
      : [];

  const renderBody = () => {
    if (!target) return null;

    const isFileNonMarkdown =
      target.kind === "file" && !isMarkdownLikeFilename(target.entry.name);

    return (
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--agent-md-rule)] px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {nativePage ? (
              <NativeFeatureBack
                owner={owner?.userId ?? null}
                context="files-markdown-document"
                layer="profile-pane"
                onBack={requestClose}
              />
            ) : null}
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{headerTitle}</p>
              <p className="truncate text-xs text-muted-foreground">{headerSubtitle}</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant={mode === "preview" ? "secondary" : "ghost"}
              size="compact"
              onClick={() => setMode("preview")}
              aria-pressed={mode === "preview"}
            >
              <Eye className="mr-1.5 size-3.5" aria-hidden="true" />
              Preview
            </Button>
            <Button
              type="button"
              variant={mode === "source" ? "secondary" : "ghost"}
              size="compact"
              onClick={() => setMode("source")}
              aria-pressed={mode === "source"}
            >
              <Code2 className="mr-1.5 size-3.5" aria-hidden="true" />
              Source
            </Button>
            {editable ? (
              <Button
                type="button"
                variant={mode === "edit" ? "secondary" : "ghost"}
                size="compact"
                onClick={() => setMode("edit")}
                aria-pressed={mode === "edit"}
              >
                <PencilLine className="mr-1.5 size-3.5" aria-hidden="true" />
                Edit
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-touch"
              aria-label={copied ? "Copied" : "Copy markdown"}
              onClick={() => void handleCopy()}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-touch"
              aria-label={`Download ${filenameForDownload}`}
              onClick={handleDownload}
            >
              <Download className="size-4" />
            </Button>
            {!nativePage ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-touch"
                aria-label="Close document"
                onClick={requestClose}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {mode === "preview" ? (
            <div className="space-y-4">
              {isFileNonMarkdown ? (
                <pre className="whitespace-pre-wrap break-words rounded-xl bg-[color:var(--agent-md-well)] p-4 font-mono text-xs leading-relaxed">
                  {draftBody}
                </pre>
              ) : fullMarkdownForPreview.trim() ? (
                <AgentMarkdown text={fullMarkdownForPreview} className="text-sm leading-relaxed" />
              ) : (
                <p className="text-sm text-muted-foreground">This document is empty.</p>
              )}

              {target.kind === "wiki" && activeClaims.length > 0 ? (
                <SettingsGroup title="Saved facts" embedded>
                  {activeClaims.map((claim) => (
                    <SettingsRow
                      key={claim.claimId}
                      title={claim.statement}
                      description={
                        claim.origins.length > 0
                          ? `From ${claim.origins.join(", ")}`
                          : `Recorded ${claim.observedAt}`
                      }
                      trailing={
                        onForgetWikiClaim ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="compact"
                            disabled={saving || busy}
                            aria-label={`Forget ${claim.statement}`}
                            onClick={() =>
                              setForgetTarget({
                                pageId: target.page.pageId,
                                claimId: claim.claimId,
                                statement: claim.statement,
                              })
                            }
                          >
                            Forget
                          </Button>
                        ) : undefined
                      }
                    />
                  ))}
                </SettingsGroup>
              ) : null}
            </div>
          ) : mode === "source" ? (
            <div className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={sourceFilter}
                  onChange={(event) => setSourceFilter(event.target.value)}
                  placeholder="Filter lines…"
                  aria-label="Filter source lines"
                  className="pl-9"
                />
              </div>
              <div className="overflow-x-auto rounded-xl border border-[color:var(--agent-md-rule)] bg-[color:var(--agent-md-well)] p-3 font-mono text-xs leading-5">
                {sourceLines.length === 0 ? (
                  <p className="py-2 text-muted-foreground">No matching lines.</p>
                ) : (
                  sourceLines.map((row) => (
                    <div key={row.number} className="grid grid-cols-[2.5rem_1fr] gap-3">
                      <span className="select-none text-right text-muted-foreground/60 tabular-nums">
                        {row.number}
                      </span>
                      <span className="whitespace-pre-wrap break-words">{row.line || " "}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <form
              className="flex min-h-full flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              {target.kind === "wiki" ? (
                <>
                  <div className="space-y-1">
                    <label htmlFor="wiki-note-title" className="text-xs font-medium">
                      Title
                    </label>
                    <Input
                      id="wiki-note-title"
                      aria-label="Note title"
                      value={draftTitle}
                      disabled={saving || busy}
                      onChange={(event) => setDraftTitle(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="wiki-note-summary" className="text-xs font-medium">
                      Summary
                    </label>
                    <Input
                      id="wiki-note-summary"
                      aria-label="Summary"
                      value={draftSummary}
                      disabled={saving || busy}
                      onChange={(event) => setDraftSummary(event.target.value)}
                    />
                  </div>
                </>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                <label htmlFor="files-md-editor-body" className="text-xs font-medium">
                  {target.kind === "wiki" ? "Details (Markdown)" : `${headerTitle} (Markdown)`}
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatLineAndWordSummary(draftBody)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={() => setShowFindBar((prev) => !prev)}
                  >
                    <Search className="mr-1 size-3.5" aria-hidden="true" />
                    Find
                  </Button>
                </div>
              </div>

              {showFindBar ? (
                <div className="grid grid-cols-1 gap-2 rounded-xl border p-2.5 sm:grid-cols-[1fr_1fr_auto]">
                  <Input
                    value={findQuery}
                    onChange={(event) => setFindQuery(event.target.value)}
                    placeholder="Find text"
                    aria-label="Find text"
                  />
                  <Input
                    value={replaceQuery}
                    onChange={(event) => setReplaceQuery(event.target.value)}
                    placeholder="Replace with"
                    aria-label="Replace with"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="compact"
                    disabled={!findQuery}
                    onClick={handleReplaceAll}
                  >
                    Replace all
                  </Button>
                </div>
              ) : null}

              <Textarea
                ref={bodyTextareaRef}
                id="files-md-editor-body"
                aria-label={target.kind === "wiki" ? "Details" : `${headerTitle} content`}
                value={draftBody}
                disabled={saving || busy}
                onChange={(event) => setDraftBody(event.target.value)}
                rows={16}
                spellCheck={false}
                className="min-h-[18rem] flex-1 font-mono text-xs leading-relaxed"
              />

              {target.kind === "wiki" && activeClaims.length > 0 ? (
                <details className="rounded-xl border px-3 py-2 text-xs">
                  <summary className="cursor-pointer font-medium">
                    Saved facts ({activeClaims.length})
                  </summary>
                  <div className="mt-2 space-y-2">
                    {activeClaims.map((claim) => (
                      <div key={claim.claimId} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{claim.statement}</p>
                          <p className="truncate text-muted-foreground">
                            {claim.origins.length > 0
                              ? `From ${claim.origins.join(", ")}`
                              : `Recorded ${claim.observedAt}`}
                          </p>
                        </div>
                        {onForgetWikiClaim ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="compact"
                            disabled={saving || busy}
                            aria-label={`Forget ${claim.statement}`}
                            onClick={() =>
                              setForgetTarget({
                                pageId: target.page.pageId,
                                claimId: claim.claimId,
                                statement: claim.statement,
                              })
                            }
                          >
                            Forget
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              <div className="flex items-center justify-between gap-2 border-t pt-3">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving || busy}
                  onClick={() => {
                    if (dirty) setConfirmDiscardOpen(true);
                    else setMode("preview");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    saving ||
                    busy ||
                    (target.kind === "wiki" && !draftTitle.trim()) ||
                    (!dirty && target.kind === "core" && !target.isDefaultTemplate)
                  }
                >
                  {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  {target.kind === "wiki" ? "Save changes" : `Save ${headerTitle}`}
                </Button>
              </div>
            </form>
          )}
        </div>

        <AlertDialog
          open={confirmDiscardOpen}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setConfirmDiscardOpen(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
              <AlertDialogDescription>
                Your edits to {headerTitle} have not been saved to your encrypted vault yet.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmDiscardOpen(false);
                  onClose();
                }}
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={forgetTarget !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !saving) setForgetTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Forget this fact?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes &ldquo;{forgetTarget?.statement}&rdquo; from active recall and stops
                future sharing of this detail.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>Keep fact</AlertDialogCancel>
              <AlertDialogAction
                disabled={saving}
                onClick={() => {
                  if (!forgetTarget || !onForgetWikiClaim) return;
                  const targetClaim = forgetTarget;
                  setForgetTarget(null);
                  void onForgetWikiClaim(targetClaim);
                }}
              >
                Forget fact
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  };

  if (nativePage) {
    return (
      <NativeFeaturePage
        open={open && target !== null}
        title={headerTitle}
        owner={owner?.userId ?? null}
        context={JSON.stringify([owner?.generation, snapshotVaultSessionEpoch(), "files-markdown-doc"])}
        layer="profile-pane"
        authoredHeader
        bodyClassName="flex flex-1 flex-col overflow-hidden"
        data-testid="files-markdown-document-sheet"
        onBack={requestClose}
      >
        {renderBody()}
      </NativeFeaturePage>
    );
  }

  return (
    <Sheet
      open={open && target !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose();
      }}
      modal={isMobile}
    >
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        showOverlay={isMobile}
        contentDragDismiss={false}
        data-testid="files-markdown-document-sheet"
        className={cn(
          "gap-0 overflow-hidden p-0 motion-reduce:animate-none motion-reduce:transition-none",
          isMobile
            ? "h-[calc(100dvh-var(--app-safe-area-top-effective,0px)-2.5rem-var(--kb-height,0px))] max-h-[calc(100dvh-var(--app-safe-area-top-effective,0px)-2.5rem-var(--kb-height,0px))]"
            : "inset-y-3 right-3 h-auto w-[min(44rem,56vw)] rounded-[var(--app-card-radius-feature)] border sm:max-w-none",
        )}
      >
        <SheetTitle className="sr-only">{headerTitle}</SheetTitle>
        <SheetDescription className="sr-only">{headerSubtitle}</SheetDescription>
        {renderBody()}
      </SheetContent>
    </Sheet>
  );
}
