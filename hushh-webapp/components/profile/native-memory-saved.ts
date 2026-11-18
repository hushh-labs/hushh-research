import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { ROUTES } from "@/lib/navigation/routes";
import type { LiveMirrorViewState } from "@/lib/pkm/use-live-mirror-view";
import {
  CORE_AGENT_MARKDOWN_IDS,
  CORE_AGENT_MARKDOWN_META,
  peekCoreAgentMarkdownFile,
} from "@/lib/pkm/agent-core-markdown-files";
import { buildPkmShareBundles } from "@/lib/profile/pkm-memory-tree";
import { formatCommerceMoney } from "@/lib/services/scope-commerce-service";
import type { MemoryCommerceSummaryModel } from "./memory-commerce-summary";
import type { NativeMemoryMarkdownBlock } from "./native-memory-markdown";
import type { PkmNaturalModel } from "./use-pkm-natural-model";

type Action = (choice: NativeWorkspaceChoice) => void | Promise<unknown>;
export type NativeMemorySavedHandoff = (target: "soul-editor" | "sharing" | "detail" | "payments" | "navigation", action: () => void) => Promise<boolean>;
export type NativeMemorySavedModel = Pick<PkmNaturalModel,
  | "ownerId" | "soul" | "authLoading" | "canOpen" | "selectedCard" | "selectedMetadataDomain"
  | "bootstrapLoading" | "bootstrapError" | "metadata"
  | "memoryCardsLoading" | "memoryCardsLoadError" | "memoryCards"
  | "categories" | "openMemory"
  | "setSelectedDomainKey" | "navigate" | "setRefreshNonce" | "setMemoryCardsNonce"
  | "visibleMetadataDomains" | "sharingManifests" | "sharingManifestsLoading" | "exportBusy"
  | "exportStatus" | "exportError" | "isVaultUnlocked" | "handleExportMemory"
>;

/** A missing field is not a license to hide a control: null means retain the
 * complete authored React owner until native can represent this state. */
export function nativeMemorySaved({ model, commerce, handle, handoff, openPayments }: {
  model: NativeMemorySavedModel;
  mirror?: LiveMirrorViewState;
  commerce: MemoryCommerceSummaryModel;
  handle: (key: string) => string;
  /** Must retire native ownership before invoking the supplied authored action. */
  handoff: NativeMemorySavedHandoff;
  openPayments: () => void;
  openSharing: () => void;
  markdownProjection?: { source: string; blocks: readonly NativeMemoryMarkdownBlock[] | null };
}): { sections: readonly NativeDrawerSection[]; actions: ReadonlyMap<string, Action> } | null {
  if (!model.canOpen || model.authLoading || model.selectedCard || model.selectedMetadataDomain) return null;
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

  group("wiki", [
    row(
      "wiki-open",
      "Personal wiki",
      "Open your Personal wiki folder in Files.",
      hand("navigation", () => model.navigate(`${ROUTES.ONE_FILES}?folder=personal-wiki`)),
      { chevron: true },
    ),
  ], "Wiki");

  group("core-docs", CORE_AGENT_MARKDOWN_IDS.map((docId) => {
    const meta = CORE_AGENT_MARKDOWN_META[docId];
    const warm = model.ownerId ? peekCoreAgentMarkdownFile(model.ownerId, docId) : null;
    const key = docId === "memory.md" ? "soul-edit" : docId === "identity.md" ? "identity-doc" : "soul-doc";
    return row(
      key,
      meta.title,
      warm?.updatedAt ? `${meta.subtitle} · Saved` : meta.subtitle,
      hand("navigation", () =>
        model.navigate(`${ROUTES.ONE_FILES}?folder=personal-wiki&doc=${encodeURIComponent(docId)}`),
      ),
      { chevron: true },
    );
  }), "Core files");

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
  const category = (domain: NativeMemorySavedModel["categories"][number], index: number) => {
    const countLabel = `${domain.count} ${domain.count === 1 ? "memory" : "memories"}`;
    const manifest = domain.key !== "location" && !model.sharingManifestsLoading ? model.sharingManifests[domain.key] : null;
    const bundles = manifest ? buildPkmShareBundles(manifest) : [];
    const enabledCount = bundles.filter(bundle => bundle.enabled).length;
    const sharingSummary = bundles.length === 0 ? "" : enabledCount === 0 ? " · Private" : enabledCount === bundles.length ? " · Ask first" : ` · ${enabledCount} of ${bundles.length} ask first`;
    return row(`category:${index}`, domain.title, `${countLabel}${sharingSummary}`,
      hand(domain.key === "location" ? "navigation" : "detail", () => domain.key === "location" ? model.navigate(ROUTES.PKM_LOCATION) : model.setSelectedDomainKey(domain.key)), { chevron: true });
  };
  if ((model.bootstrapLoading || (!model.metadata && !model.bootstrapError) || model.memoryCardsLoading) && model.memoryCards.length === 0) {
    group("loading", [row("loading", "Opening Memory…")]);
  } else if (model.memoryCardsLoadError && model.memoryCards.length === 0) {
    group("memory-error", [row("memory-error", "Some saved details couldn’t be opened."),
      row("memory-retry", "Try again", undefined, () => model.setMemoryCardsNonce(value => value + 1))]);
  } else {
    const categories = model.categories.map(category);
    if (!categories.length && model.metadata && !model.bootstrapLoading && !model.bootstrapError && !model.memoryCardsLoading && !model.memoryCardsLoadError) {
      group("empty", [row("empty", "No sharable scopes saved yet.")]);
    }
    group("categories", categories, model.categories.length ? "Scopes" : undefined);
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
  const unavailable = model.visibleMetadataDomains.some(domain => !model.sharingManifests[domain.key]);
  if (!model.sharingManifestsLoading && unavailable) {
    sharingRows.push(row("sharing-error", "Some sharing settings could not be checked. Try again before changing access."));
    sharingRows.push(row("sharing-retry", "Retry sharing settings", undefined, () => model.setRefreshNonce(value => value + 1)));
  }
  group("sharing", sharingRows);
  if (!valid || total > 200 || sections.length > 32) return null;
  return { sections, actions };
}
