import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";
import { LIVE_MEMORY_BOUNDARY_COPY, LIVE_MIRROR_HIDDEN_PREDICATES } from "@/lib/pkm/live-mirror-contract";
import { liveMirrorClaimText, liveMirrorFactStateLabel, liveMirrorFixRoutes, liveMirrorPreviewRows, liveMirrorStatus } from "@/lib/pkm/live-mirror-presentation";
import type { LiveMirrorViewState } from "@/lib/pkm/use-live-mirror-view";
import { pkmMemoryRowLabels } from "@/lib/pkm/pkm-memory-cards";
import { pkmMemoryCardBreadcrumb } from "@/lib/pkm/pkm-memory-level";
import { buildPkmShareBundles } from "@/lib/profile/pkm-memory-tree";
import { formatCommerceMoney } from "@/lib/services/scope-commerce-service";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import type { MemoryCommerceSummaryModel } from "./memory-commerce-summary";
import { nativeMemoryMarkdown, type NativeMemoryMarkdownBlock } from "./native-memory-markdown";
import type { PkmNaturalModel } from "./use-pkm-natural-model";

type Action = (choice: NativeWorkspaceChoice) => void | Promise<unknown>;
export type NativeMemorySavedHandoff = (target: "soul-editor" | "sharing" | "detail" | "payments" | "navigation", action: () => void) => Promise<boolean>;
export type NativeMemorySavedModel = Pick<PkmNaturalModel,
  | "soul" | "authLoading" | "canOpen" | "selectedCard" | "selectedMetadataDomain"
  | "homeSearchQuery" | "setHomeSearchQuery" | "bootstrapLoading" | "bootstrapError" | "metadata"
  | "memoryCardsLoading" | "memoryCardsLoadError" | "memoryCards" | "trimmedQuery" | "searchResults"
  | "matchedCategories" | "recentMemories" | "categories" | "setWorkspaceTab" | "openMemory"
  | "setSelectedDomainKey" | "navigate" | "setRefreshNonce" | "setMemoryCardsNonce"
  | "visibleMetadataDomains" | "sharingManifests" | "sharingManifestsLoading" | "exportBusy"
  | "exportStatus" | "exportError" | "isVaultUnlocked" | "handleExportMemory"
>;

/** A missing field is not a license to hide a control: null means retain the
 * complete authored React owner until native can represent this state. */
export function nativeMemorySaved({ model, mirror, commerce, handle, handoff, openPayments, openSharing, markdownProjection }: {
  model: NativeMemorySavedModel;
  mirror: LiveMirrorViewState;
  commerce: MemoryCommerceSummaryModel;
  handle: (key: string) => string;
  /** Must retire native ownership before invoking the supplied authored action. */
  handoff: NativeMemorySavedHandoff;
  openPayments: () => void;
  openSharing: () => void;
  /** Optional owner-scoped memo; stale text is never used for the new note. */
  markdownProjection?: { source: string; blocks: readonly NativeMemoryMarkdownBlock[] | null };
}): { sections: readonly NativeDrawerSection[]; actions: ReadonlyMap<string, Action>; search: { id: string; label: string; query: string; afterSection: number }; requiresLiveSearch: true } | null {
  if (!model.canOpen || model.authLoading || model.selectedCard || model.selectedMetadataDomain || model.soul.editing) return null;
  const actions = new Map<string, Action>();
  const sections: NativeDrawerSection[] = [];
  const ids = new Set<string>();
  let valid = true;
  let total = 0;
  const opaque = (key: string) => {
    const id = handle(`memory-saved:${key}`);
    if (!id || id.length > 128 || ids.has(id)) valid = false;
    ids.add(id); return id;
  };
  const row = (key: string, label: string, detail?: string | null, action?: Action,
    extra: Partial<Pick<NativeDrawerRow, "trailing" | "enabled" | "chevron" | "pending">> = {}): NativeDrawerRow => {
    const id = opaque(key);
    if (!label || label.length > 4096 || (detail?.length ?? 0) > 4096 || (extra.trailing?.length ?? 0) > 32) valid = false;
    total += 1; if (action) actions.set(id, action);
    return { id, label, ...(detail ? { detail } : {}), enabled: extra.enabled ?? true,
      ...(extra.trailing ? { trailing: extra.trailing } : {}), ...(extra.chevron ? { chevron: true } : {}),
      ...(extra.pending ? { pending: true } : {}), ...(!action ? { readOnly: true } : {}) };
  };
  const group = (key: string, rows: NativeDrawerRow[], title?: string) => {
    if (rows.length) sections.push({ id: opaque(`section:${key}`), ...(title ? { title } : {}), rows });
  };
  const hand = (target: Parameters<NativeMemorySavedHandoff>[0], action: () => void): Action => async () => { await handoff(target, action); };

  if (!model.soul.verified) {
    group("soul-unverified", [row("soul-unverified", "Reconnect your account to open memory.md.")]);
  } else {
    const locked = mirror.status === "locked";
    const view = mirror.status === "ready" ? mirror.view : null;
    const status = view ? liveMirrorStatus(view.overall, view) : liveMirrorStatus(locked ? "locked" : "loading");
    const conflicts = (view?.conflicts ?? []).filter(conflict => !(LIVE_MIRROR_HIDDEN_PREDICATES as readonly string[]).includes(conflict.predicate));
    const disputed = new Set(conflicts.map(conflict => conflict.predicate));
    const liveRows: NativeDrawerRow[] = [];
    if (!locked) liveRows.push(row("live-boundary", LIVE_MEMORY_BOUNDARY_COPY));
    liveRows.push(row("live-status", status.headline, status.sub));
    conflicts.forEach((conflict, index) => {
      const lines = conflict.claims.map(claim => {
        const { label, value, detail } = liveMirrorClaimText(claim, conflict.predicate, view!.evaluatedAt);
        return `${label}: ${value}${detail ? ` · ${detail}` : ""}`;
      }).join("\n");
      liveRows.push(row(`live-conflict:${index}`, conflict.label, lines));
    });
    if (view) liveMirrorPreviewRows(view.facts.filter(fact => fact.kind !== "profile" || !disputed.has(fact.predicate)))
      .forEach((item, index) => liveRows.push(row(`live-fact:${index}`, item.title, item.description, undefined,
        { trailing: liveMirrorFactStateLabel(item.state) ?? undefined })));
    liveMirrorFixRoutes(conflicts, { includeMemory: false }).forEach((route, index) =>
      liveRows.push(row(`live-fix:${index}`, route.label, undefined, hand("navigation", () => model.navigate(route.href)), { chevron: true })));
    if (!locked) liveRows.push(row("live-all", "See all", undefined,
      hand("navigation", () => model.navigate(buildProfileRoute({ panel: "my-data" }))), { chevron: true }));
    group("live", liveRows, "Live memory");
    if (model.soul.failed) group("soul-failed", [row("soul-failed", "memory.md couldn’t be opened."), row("soul-retry", "Try again", undefined, () => model.soul.retryLoad())]);
    else if (!model.soul.current) group("soul-loading", [row("soul-loading", "Opening memory.md…")]);
    else {
      const markdown = model.soul.current.document.markdown;
      let blocks;
      try { blocks = markdownProjection?.source === markdown ? markdownProjection.blocks : nativeMemoryMarkdown(markdown); } catch { return null; }
      if (blocks?.some(block => !block.runs)) blocks = nativeMemoryMarkdown(markdown);
      if (!blocks) return null;
      const soulRows = [row("soul-description", "The memory One uses in every conversation."),
        row("soul-edit", "Edit memory.md", undefined, hand("soul-editor", () => model.soul.beginEdit()), { enabled: !model.soul.loading, chevron: true })];
      if (model.soul.sync === "saving") soulRows.push(row("soul-syncing", "Syncing your latest memories…"));
      if (model.soul.sync === "retryable") {
        soulRows.push(row("soul-sync-error", "Your latest memories are available here but haven’t synced yet."));
        soulRows.push(row("soul-retry-sync", "Retry sync", undefined, () => model.soul.retrySync()));
      }
      group("soul", soulRows, "memory.md");
      const documentRows = blocks.map((block, index) => {
        const item = row(`soul-document:${index}`, block.text);
        let previousHref: string | undefined, previousAction: string | undefined;
        const runs = block.runs!.map((run, runIndex) => {
          const { href, ...textRun } = run;
          if (!href) { previousHref = undefined; previousAction = undefined; return textRun; }
          const actionId = previousHref === href && previousAction ? previousAction : opaque(`soul-link:${index}:${runIndex}`);
          actions.set(actionId, () => openExternalUrl(href));
          previousHref = href; previousAction = actionId;
          return { ...textRun, actionId };
        });
        item.formattedText = { ...(block.kind === "heading" ? { level: block.level ?? 1 } : {}), runs };
        if (runs.some(run => "actionId" in run)) item.readOnly = false;
        return item;
      });
      group("soul-document", documentRows);
    }
  }

  // The authored search follows Live memory and memory.md inside the scroll.
  const searchAfterSection = sections.length;
  const searchId = opaque("search");
  actions.set(searchId, choice => { if (choice.text !== undefined) model.setHomeSearchQuery(choice.text); });
  if (commerce.user) {
    const earnings = commerce.data?.earnings;
    const hasEarnings = !!earnings && (earnings.pending_cents !== 0 || earnings.available_cents !== 0 || (earnings.debt_cents ?? 0) > 0 || (earnings.withdrawing_cents ?? 0) > 0);
    const rows: NativeDrawerRow[] = [];
    if (hasEarnings && earnings) {
      rows.push(row("earnings-pending", "Pending earnings", formatCommerceMoney(earnings.pending_cents)));
      rows.push(row("earnings-available", "Available earnings", formatCommerceMoney(earnings.available_cents)));
      if ((earnings.debt_cents ?? 0) > 0) rows.push(row("earnings-debt", "Unrecovered costs", formatCommerceMoney(earnings.debt_cents!)));
      if ((earnings.withdrawing_cents ?? 0) > 0) rows.push(row("earnings-withdrawal", "Withdrawal in progress", formatCommerceMoney(earnings.withdrawing_cents!)));
    }
    if (commerce.error || commerce.loading && !commerce.data) rows.push(row("earnings-status", commerce.error || "Checking earnings…"));
    rows.push(row("earnings-open", commerce.data?.readiness?.capabilities.start_onboarding && !commerce.data.seller?.eligible ? "Set up payouts and view your wallet" : "View payments and earnings",
      undefined, hand("payments", openPayments), { chevron: true }));
    group("earnings", rows, hasEarnings ? "Memory earnings" : undefined);
  }
  const category = (domain: NativeMemorySavedModel["categories"][number], index: number) => row(`category:${index}`, domain.title,
    `${domain.count} ${domain.count === 1 ? "memory" : "memories"}`,
    hand(domain.key === "location" ? "navigation" : "detail", () => domain.key === "location" ? model.navigate(ROUTES.PKM_LOCATION) : model.setSelectedDomainKey(domain.key)), { chevron: true });
  if ((model.bootstrapLoading || (!model.metadata && !model.bootstrapError) || model.memoryCardsLoading) && model.memoryCards.length === 0) {
    group("loading", [row("loading", "Opening Memory…")]);
  } else if (model.memoryCardsLoadError && model.memoryCards.length === 0) {
    group("memory-error", [row("memory-error", "Some saved details couldn’t be opened."),
      row("memory-retry", "Try again", undefined, () => model.setMemoryCardsNonce(value => value + 1))]);
  } else if (model.trimmedQuery) {
    if (!model.searchResults.length && !model.matchedCategories.length) group("search-empty", [row("search-empty", `No memories match “${model.trimmedQuery}”.`)]);
    group("search-results", model.searchResults.map((card, index) => {
      const { primary, secondary } = pkmMemoryRowLabels(card);
      return row(`result:${index}`, primary, pkmMemoryCardBreadcrumb(card) || secondary,
        hand("detail", () => model.openMemory(card)), { chevron: true });
    }), "Memories");
    group("matched-categories", model.matchedCategories.map(category), "Categories");
  } else {
    if (model.recentMemories.length) group("recent", [row("recent", "Recently learned", `${model.recentMemories.length} ${model.recentMemories.length === 1 ? "memory" : "memories"}`,
      hand("navigation", () => model.navigate(ROUTES.PKM_RECENT)), { chevron: true })]);
    const categories = model.categories.map(category);
    if (!categories.length && model.metadata && !model.bootstrapLoading && !model.bootstrapError && !model.memoryCardsLoading && !model.memoryCardsLoadError) {
      group("empty", [row("empty", "One hasn’t saved anything yet.")]);
    }
    categories.push(row("add-memory", "Add Memory", undefined, () => model.setWorkspaceTab("add"), { chevron: true }));
    group("categories", categories, model.categories.length ? "Categories" : undefined);
    if (model.bootstrapError) group("bootstrap-error", [row("bootstrap-error", "Some saved details couldn’t be loaded."),
      row("bootstrap-retry", "Try again", undefined, () => model.setRefreshNonce(value => value + 1))]);
    if (model.memoryCardsLoadError) group("refresh-error", [row("refresh-error", "Some saved details couldn’t be refreshed. Your available details are still here."),
      row("refresh-retry", "Retry", undefined, () => model.setMemoryCardsNonce(value => value + 1))]);
  }
  const sharingRows = [row("download", model.exportBusy ? "Preparing…" : "Download Memory", model.isVaultUnlocked ? "Readable file. Keep it private." : "Unlock to download.",
    () => model.handleExportMemory(), { enabled: model.isVaultUnlocked && !model.exportBusy, pending: model.exportBusy, chevron: true })];
  if (model.exportStatus) sharingRows.push(row("export-status", model.exportStatus));
  if (model.exportError) sharingRows.push(row("export-error", model.exportError));
  if (model.sharingManifestsLoading) sharingRows.push(row("sharing-loading", "Checking sharing settings…"));
  sharingRows.push(row("sharing-open", "Sharing settings", undefined, hand("sharing", openSharing), { chevron: true }));
  const unavailable = model.visibleMetadataDomains.some(domain => !model.sharingManifests[domain.key]);
  if (!model.sharingManifestsLoading && unavailable) {
    sharingRows.push(row("sharing-error", "Some sharing settings could not be checked. Try again before changing access."));
    sharingRows.push(row("sharing-retry", "Retry sharing settings", undefined, () => model.setRefreshNonce(value => value + 1)));
  } else if (!model.sharingManifestsLoading && model.visibleMetadataDomains.length > 0 &&
    Object.values(model.sharingManifests).every(manifest => buildPkmShareBundles(manifest).length === 0)) {
    sharingRows.push(row("sharing-empty", "Nothing to share yet."));
  }
  group("sharing", sharingRows);
  if (!valid || total > 200 || sections.length > 32 || model.homeSearchQuery.length > 256) return null;
  return { sections, actions, search: { id: searchId, label: "Search Memory", query: model.homeSearchQuery, afterSection: searchAfterSection }, requiresLiveSearch: true };
}
