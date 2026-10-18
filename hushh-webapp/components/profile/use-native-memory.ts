"use client";

import { useLayoutEffect, useMemo, useState } from "react";
import type { NativeDrawerChoice, NativeDrawerRow, NativeProfilePage, NativeMemoryPageId } from "@/lib/capacitor/native-drawers";
import type { PkmAccessConnectionPresentation, PkmDomainPermissionPresentation, PkmDomainPresentation, PkmDomainUpgradePresentation } from "@/lib/profile/pkm-profile-presentation";
import { formatPkmTimestamp } from "@/lib/profile/pkm-profile-presentation";
import type { PkmSectionPreviewEntity, PkmSectionPreviewPresentation } from "@/lib/profile/pkm-section-preview";
import { pkmPreviewEntityTarget } from "@/lib/profile/pkm-section-preview";
import type { PkmVisibilityPosture } from "@/lib/services/personal-knowledge-model-service";
import { nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useLiveMirrorView } from "@/lib/pkm/use-live-mirror-view";
import { ROUTES } from "@/lib/navigation/routes";
import { LIVE_MEMORY_BOUNDARY_COPY, LIVE_MIRROR_HIDDEN_PREDICATES } from "@/lib/pkm/live-mirror-contract";
import { formatLiveMirrorDateTime, liveMirrorStatus, liveMirrorRecordRows, liveMirrorSourceRoute, liveMirrorSourceDescription, liveMirrorSourceStateLabel,
  liveMirrorClaimText, liveMirrorConflictKey, liveMirrorFixRoutes, liveMirrorHistoryAction, liveMirrorHistoryDetail, liveMirrorGapText, LIVE_MIRROR_HISTORY_FOOTER } from "@/lib/pkm/live-mirror-presentation";

export type NativeMemoryModel = {
  owner: string; active: boolean; detail: string | null; loading: boolean; metadataReady: boolean; sharingReady: boolean;
  metadataFailed: boolean; sharingFailed: boolean;
  domains: readonly PkmDomainPresentation[]; connections: readonly PkmAccessConnectionPresentation[];
  selectedDomain: PkmDomainPresentation | null; selectedConnection: PkmAccessConnectionPresentation | null;
  permissions: readonly PkmDomainPermissionPresentation[]; upgrade: PkmDomainUpgradePresentation | null;
  manifestLoading: boolean; manifestFailed: boolean; pendingPermissions: Readonly<Record<string, boolean>>;
  preview: { open: boolean; title: string; presentation: PkmSectionPreviewPresentation | null; loading: boolean; error: string | null; deletingEntityKey: string | null };
  openDomain: (key: string) => void; openConnection: (id: string) => void; openSharing: () => void; openRoot: () => void;
  refresh: () => void; navigate: (href: string) => void; closePreview: () => void;
  openRetainedDetails: () => void;
  openFinancialContext: () => void;
  previewPermission: (permission: PkmDomainPermissionPresentation) => Promise<void>;
  setPosture: (permission: PkmDomainPermissionPresentation, posture: PkmVisibilityPosture) => Promise<void>;
  removeEntity: (entity: PkmSectionPreviewEntity) => Promise<boolean>;
  editEntity: (entity: PkmSectionPreviewEntity) => void;
  revoke: (scope: string) => Promise<void>;
};

/** Presentation handles are opaque and die with the owner/query visit. They are
 * not record IDs, scopes, URLs, access tokens or an alternative operation store. */
class MemoryVisit {
  live = false;
  pending = false;
  private handles = new Map<string, string>();
  constructor(readonly active: boolean, readonly owner: string, readonly detail: string | null) {}
  handle(key: string) { let id = this.handles.get(key); if (!id) { id = crypto.randomUUID(); this.handles.set(key, id); } return id; }
  current() { const privacy = nativePrivacyObservation().state; return this.live && privacy?.appIsActive === true && !privacy.shielded; }
  retire() { this.live = false; this.handles.clear(); }
}
type Local = { query: string; pages: Partial<Record<NativeMemoryPageId, number>>; liveTab: "facts" | "history" | "preview";
  liveOpen: boolean; record: string | null; conflict: string | null; entity: string | null;
  confirmation: { kind: "entity" | "grant"; key: string; privacy: number } | null; outcome: string | null };
const initial = (): Local => ({ query: "", pages: {}, liveTab: "facts", liveOpen: false, record: null, conflict: null, entity: null, confirmation: null, outcome: null });
const retainedRoot = (value: Local): Local => ({ ...initial(), query: value.query, pages: { memory: value.pages.memory } });
// A replacement record may have the same display ordinal/title. Bind its
// opaque handle to the private target, not to its current list position.
const previewEntityKey = (index: number, entity: PkmSectionPreviewEntity) => JSON.stringify(pkmPreviewEntityTarget(entity) ?? [index, entity.key]);
const previewEntities = (presentation: PkmSectionPreviewPresentation | null) => presentation?.groups.flatMap((group, index) =>
  group.kind === "entities" ? group.items.map(entity => ({ key: previewEntityKey(index, entity), entity })) : []) ?? [];

/** Split by Unicode code point without dropping information or sending an
 * unbounded field through the bridge. Pagination bounds the projected replica. */
export function nativeMemoryText(value: string, maximum = 3000): string[] {
  const result: string[] = []; let part = "";
  for (const point of value) {
    if (part.length + point.length > maximum) { result.push(part); part = ""; }
    part += point;
  }
  if (part) result.push(part);
  return result;
}

/** One private presentation of the existing Memory and sharing owners. No
 * decryptor, writer, consent interpreter or network request exists here. */
function navigationText(value: string, maximum: number): string {
  return value.length <= maximum ? value || "Details" : `${nativeMemoryText(value, maximum - 1)[0]}…`;
}

export function useNativeMemory(model: NativeMemoryModel) {
  const visit = useMemo(() => new MemoryVisit(model.active, model.owner, model.detail), [model.active, model.owner, model.detail]);
  const [stored, setStored] = useState<{ owner: string; visit: MemoryVisit; value: Local } | null>(null);
  // Admission may be published by a descendant layout effect. Gate nested
  // state during render; a later effect is too late to prevent a stale path.
  const local = stored?.owner === model.owner ? stored.visit === visit ? stored.value : retainedRoot(stored.value) : initial();
  useLayoutEffect(() => { visit.live = visit.active; return () => visit.retire(); }, [visit]);
  useLayoutEffect(() => {
    setStored(previous => previous?.owner === visit.owner ? { owner: visit.owner, visit, value: retainedRoot(previous.value) } : null);
  }, [visit]);
  const mirror = useLiveMirrorView(model.active);
  if (!model.active) return { pages: [] as NativeProfilePage[], rows: new Map<string, (choice?: NativeDrawerChoice) => void | Promise<void>>(),
    back: () => false, ancestor: (_choice: { rowId?: string }) => false, nested: false, busy: false };
  const change = (update: (value: Local) => Local) => {
    if (visit.current()) setStored(previous => ({ owner: visit.owner, visit, value: update(previous?.owner === visit.owner
      ? previous.visit === visit ? previous.value : retainedRoot(previous.value) : initial()) }));
  };
  const actions = new Map<string, (choice?: NativeDrawerChoice) => void | Promise<void>>();
  const bind = (key: string, action: () => void | Promise<void>) => {
    const id = visit.handle(key); actions.set(id, () => { if (visit.current() && !visit.pending) return action(); }); return id;
  };
  const action = (key: string, label: string, callback: () => void | Promise<void>, extras: Partial<Omit<NativeDrawerRow, "id" | "label">> = {}): NativeDrawerRow =>
    ({ id: bind(key, callback), label: navigationText(label, 4096), enabled: true, ...extras,
      ...(extras.detail ? { detail: navigationText(extras.detail, 4096) } : {}) });
  const read = (key: string, text: string): NativeDrawerRow[] => nativeMemoryText(text).map((label, index) =>
    ({ id: visit.handle(`${key}:${index}`), label, enabled: true, readOnly: true }));
  const field = (key: string, label: string, value?: string | null) => read(key, value ? `${label}\n${value}` : label);
  const pages: NativeProfilePage[] = [];
  const page = (id: NativeMemoryPageId, title: string, content: NativeDrawerRow[]) => {
    if (title.length > 256) content = [...read(`${id}-full-title`, title), ...content];
    const index = Math.min(local.pages[id] ?? 0, Math.max(0, Math.ceil(content.length / 40) - 1));
    const rows = content.slice(index * 40, (index + 1) * 40);
    if (index) rows.push(action(`${id}-previous`, "Previous details", () => change(value => ({ ...value, pages: { ...value.pages, [id]: index - 1 } }))));
    if ((index + 1) * 40 < content.length) rows.push(action(`${id}-next`, "More details", () => change(value => ({ ...value, pages: { ...value.pages, [id]: index + 1 } }))));
    pages.push({ id, title: navigationText(title, 256), sections: [{ id: `section-${id}`, rows }] });
  };
  const root: NativeDrawerRow[] = [
    action("memory-live", "Live memory", () => change(value => ({ ...value, liveOpen: true })), { chevron: true, artworkId: "my-data" }),
    action("memory-sharing", "Manage sharing", model.openSharing, { chevron: true, artworkId: "security" }),
    action("memory-refresh", "Refresh", model.refresh),
    action("memory-browse", "Browse all memory", () => model.navigate(ROUTES.PKM), { chevron: true }),
    action("memory-retained", "Shared records & protected details", model.openRetainedDetails, { chevron: true }),
  ];
  if (!model.metadataReady) root.push(...read("memory-status", model.metadataFailed ? "Saved details are temporarily unavailable. Refresh to try again." : "Loading saved details…"));
  else if (!model.domains.length) root.push(...read("memory-empty", "No saved details yet"));
  else {
    const query = local.query.trim().toLowerCase();
    const matching = model.domains.filter(domain => !query || [domain.title, domain.summary, ...domain.sourceLabels, ...domain.sections].join(" ").toLowerCase().includes(query));
    for (const domain of matching) root.push(action(`domain:${domain.key}`, domain.title, () => model.openDomain(domain.key), { detail: domain.summary || undefined, chevron: true }));
    if (!matching.length) root.push(...read("memory-no-match", "No matching details. Try another search."));
  }
  page("memory", "Memory", root);
  if (model.domains.length >= 6 || local.query) {
    const id = visit.handle("memory-search");
    pages[0]!.memorySearch = { id, query: local.query };
    actions.set(id, choice => {
      if (visit.current() && typeof choice?.text === "string" && choice.text.length <= 256)
        change(value => ({ ...value, query: choice.text!, pages: { ...value.pages, memory: 0 } }));
    });
  }
  const domain = model.selectedDomain;
  if (model.detail?.startsWith("domain:")) {
    const content: NativeDrawerRow[] = domain ? [
      ...read("domain-summary", domain.summary),
      ...read("domain-access", domain.accessSummary),
      ...domain.sourceLabels.flatMap((source, index) => read(`domain-source-${index}`, source)),
      ...domain.highlights.flatMap((item, index) => read(`domain-highlight-${index}`, item)),
    ] : read("domain-missing", model.loading ? "Loading…" : "These details are no longer available.");
    if (domain?.key === "financial") content.push(action("financial-context-create", "Add financial context", model.openFinancialContext, { chevron: true }));
    if (model.manifestLoading) content.push(...read("domain-loading", "Preparing sharing controls…"));
    if (model.manifestFailed) content.push(...read("domain-error", "Sharing controls are unavailable. Go back and refresh."));
    for (const permission of model.permissions) {
      content.push(action(`preview:${permission.key}`, permission.label, () => model.previewPermission(permission), { detail: permission.description || undefined, chevron: true }));
      const enabled = model.upgrade?.canManagePermissions === true && !Object.values(model.pendingPermissions).some(Boolean) && !permission.disabledReason && !model.manifestLoading;
      const privateId = bind(`private:${permission.key}`, () => enabled && permission.visibilityPosture !== "private" ? model.setPosture(permission, "private") : undefined);
      const askId = bind(`ask:${permission.key}`, () => enabled && permission.visibilityPosture !== "consent_required" ? model.setPosture(permission, "consent_required") : undefined);
      content.push({ id: visit.handle(`posture:${permission.key}`), label: navigationText(`Sharing · ${permission.label}`, 4096), enabled, pending: !!model.pendingPermissions[permission.key],
        options: [{ id: privateId, label: "Private", selected: permission.visibilityPosture === "private" },
          { id: askId, label: "Ask first", selected: permission.visibilityPosture !== "private" }] });
      if (permission.disabledReason) content.push(...read(`reason:${permission.key}`, permission.disabledReason));
    }
    if (domain && !model.permissions.length && !model.manifestLoading) content.push(...read("domain-no-sections", model.upgrade?.description || "Section-level sharing is not ready yet."));
    page("memory-domain", domain?.title || "Memory details", content);
    if (model.preview.open) {
      const preview = model.preview;
      const content: NativeDrawerRow[] = [];
      if (preview.loading) content.push(...read("preview-loading", "Loading saved values…"));
      else if (preview.error) content.push(...read("preview-error", "Couldn't load this section. Go back and try again."));
      else if (preview.presentation) {
        const presentation = preview.presentation;
        if (presentation.description) content.push(...read("preview-description", presentation.description));
        if (presentation.summary) content.push(...read("preview-summary", presentation.summary));
        for (const [index, stat] of presentation.stats.entries()) content.push(...field(`stat-${index}`, stat.label, stat.value));
        for (const [index, group] of presentation.groups.entries()) {
          if (group.title) content.push(...read(`group-${index}`, group.title));
          if (group.description) content.push(...read(`group-description-${index}`, group.description));
          if (group.kind === "fields") for (const [at, item] of group.fields.entries()) content.push(...field(`field-${index}-${at}`, item.label, item.value));
          else if (group.kind === "entities") for (const entity of group.items) {
            const selection = previewEntityKey(index, entity);
            content.push(action(`entity:${selection}`, entity.title,
              () => change(value => ({ ...value, entity: selection })), { detail: entity.subtitle || undefined, chevron: true }));
          }
          else for (const [at, item] of group.items.entries()) content.push(...read(`item-${index}-${at}`, item));
        }
      } else content.push(...read("preview-empty", "No saved values are available yet."));
      page("memory-section", preview.title || "Saved values", content);
      const entity = previewEntities(preview.presentation).find(item => item.key === local.entity)?.entity;
      if (entity || local.entity) {
        const content = entity ? entity.fields.flatMap((item, index) => field(`entity-field-${index}`, item.label, item.value)) : read("entity-unavailable", "This saved entry is no longer available.");
        if (entity?.subtitle) content.unshift(...read("entity-subtitle", entity.subtitle));
        for (const [index, section] of (entity?.sections ?? []).entries()) {
          content.push(...read(`entity-group-${index}`, section.label));
          section.items.forEach((item, at) => content.push(...read(`entity-value-${index}-${at}`, item)));
        }
        if (entity?.editable) content.push(action("entity-edit", "Edit", () => model.editEntity(entity)));
        if (entity?.deletable) content.push(action("entity-remove", "Remove saved entry", () => change(value => ({ ...value,
          confirmation: { kind: "entity", key: local.entity!, privacy: nativePrivacyObservation().state!.generation } })), { destructive: true, enabled: !preview.deletingEntityKey }));
        page("memory-entity", entity?.title || "Saved entry", content);
      }
    }
  } else if (model.detail === "sharing" || model.detail?.startsWith("connection:")) {
    const content = !model.sharingReady ? read("sharing-status", model.sharingFailed ? "Access state unavailable. Go back and refresh." : "Checking active access…") :
      model.connections.length ? model.connections.map(connection => action(`connection:${connection.id}`, connection.requesterLabel, () => model.openConnection(connection.id),
        { detail: `${connection.accessCount} active access point${connection.accessCount === 1 ? "" : "s"} · ${connection.domains.join(" · ")}`, chevron: true })) : read("sharing-empty", "No active access right now");
    content.push(action("sharing-location", "Location sharing", () => model.navigate(ROUTES.ONE_LOCATION), { chevron: true }),
      action("sharing-consents", "Consent center", () => model.navigate(ROUTES.CONSENTS), { chevron: true }));
    page("memory-sharing", "Access & sharing", content);
    if (model.detail.startsWith("connection:")) {
      const connection = model.selectedConnection;
      const content: NativeDrawerRow[] = [];
      if (!connection) content.push(...read("connection-missing", model.loading ? "Loading…" : "This access is no longer available."));
      else for (const grant of connection.grants) {
        content.push(...field(`grant:${grant.id}`, grant.domainTitle, grant.readableAccessLabel));
        content.push(...field(`grant-expiry:${grant.id}`, "Expires", formatPkmTimestamp(grant.expiresAt)));
        content.push(action(`grant-revoke:${grant.id}`, "Revoke this access category", () => change(value => ({ ...value,
          confirmation: { kind: "grant", key: grant.id, privacy: nativePrivacyObservation().state!.generation } })), { destructive: true }));
      }
      page("memory-connection", connection?.requesterLabel || "Connection access", content);
    }
  }
  if (!model.detail && local.liveOpen) {
    const content: NativeDrawerRow[] = [];
    if (mirror.status !== "ready") content.push(...read("live-status", mirror.status === "locked" ? "Unlock your vault to view live memory." : "Loading live memory…"));
    else {
      const view = mirror.view, status = liveMirrorStatus(view.overall, view);
      content.push(...read("live-status", [status.headline, status.sub, LIVE_MEMORY_BOUNDARY_COPY].filter(Boolean).join("\n")));
      content.push({ id: visit.handle("live-tab"), label: "Show", enabled: true,
        options: (["facts", "history", "preview"] as const).map(tab => ({ id: bind(`live-tab-${tab}`, () => change(value => ({ ...value, liveTab: tab }))),
          label: ({ facts: "Facts", history: "History", preview: "Preview" })[tab], selected: local.liveTab === tab })) });
      const conflicts = (view.conflicts ?? []).filter(item => !(LIVE_MIRROR_HIDDEN_PREDICATES as readonly string[]).includes(item.predicate));
      const records = liveMirrorRecordRows(view.facts);
      if (local.liveTab === "facts") {
        for (const conflict of conflicts) content.push(action(`conflict:${liveMirrorConflictKey(conflict)}`, conflict.label,
          () => change(value => ({ ...value, conflict: liveMirrorConflictKey(conflict), record: null })), { detail: "Sources disagree", chevron: true }));
        for (const source of view.sources) {
          const route = source.kind ? liveMirrorSourceRoute(source.kind) : null;
          const detail = [liveMirrorSourceDescription(source, view.evaluatedAt), liveMirrorSourceStateLabel(source.state)].filter(Boolean).join(" · ");
          if (route) content.push(action(`source:${source.id}`, source.label, () => model.navigate(route.href), { detail: detail || undefined, chevron: true }));
          else content.push(...field(`source:${source.id}`, source.label, detail));
        }
        for (const record of records) content.push(action(`record:${record.key}`, record.ref, () => change(value => ({ ...value, record: record.key, conflict: null })), { detail: record.summary, chevron: true }));
      } else if (local.liveTab === "history") {
        for (const entry of view.history.entries) content.push(...field(`history:${entry.sequence}`, entry.ref,
          [entry.gap ? liveMirrorGapText(entry.gap) : liveMirrorHistoryAction(entry), formatLiveMirrorDateTime(entry.capturedAt),
            entry.gap ? null : liveMirrorHistoryDetail(entry, view.facts), entry.current ? "Now" : "Earlier"].filter(Boolean).join(" · ")));
        if (!view.history.entries.length) content.push(...read("history-empty", "No changes yet"));
        if (view.history.droppedCount) content.push(...read("history-dropped", `${view.history.droppedCount} older changes not kept`));
        content.push(...read("history-footer", LIVE_MIRROR_HISTORY_FOOTER));
      } else content.push(...read("live-preview", view.markdown.trim() || "Nothing to preview yet"));
      page("memory-live", "Live memory", content);
      const record = records.find(item => item.key === local.record), conflict = conflicts.find(item => liveMirrorConflictKey(item) === local.conflict);
      const details: NativeDrawerRow[] = [];
      if (record) {
        record.fields.forEach((item, index) => details.push(...field(`record-field-${index}`, item.label, item.value)));
        for (const [label, value] of [["Version", String(record.revision)], ["Changed", record.sourceUpdatedAt], ["Checked", record.verifiedAt], ["Saved", record.capturedAt]] as const)
          details.push(...field(`record-meta-${label}`, label, label === "Version" ? value : formatLiveMirrorDateTime(value) || "Unknown"));
        const route = liveMirrorSourceRoute(record.kind); if (route) details.push(action("record-source", route.label, () => model.navigate(route.href), { chevron: true }));
      } else if (conflict) {
        conflict.claims.forEach((claim, index) => { const text = liveMirrorClaimText(claim, conflict.predicate, view.evaluatedAt); details.push(...field(`claim-${index}`, text.label, [text.value, text.detail].filter(Boolean).join("\n"))); });
        liveMirrorFixRoutes([conflict]).forEach((route, index) => details.push(action(`fix-${index}`, route.label, () => model.navigate(route.href), { chevron: true })));
      }
      if (record || conflict) page("memory-record", "Source details", details);
    }
    if (mirror.status !== "ready") page("memory-live", "Live memory", content);
  }
  const confirmationVisible = !!local.confirmation && (local.confirmation.kind === "entity" ? pages.at(-1)?.id === "memory-entity" : pages.at(-1)?.id === "memory-connection");
  if (local.confirmation && confirmationVisible) {
    const selection = local.confirmation;
    const entity = previewEntities(model.preview.presentation).find(item => item.key === selection.key && item.entity.deletable)?.entity;
    const grant = model.selectedConnection?.grants.find(item => item.id === selection.key);
    const eligible = selection.privacy === nativePrivacyObservation().state?.generation && (selection.kind === "entity" ? !!entity : !!grant);
    page("memory-confirm", selection.kind === "entity" ? "Remove saved entry?" : "Revoke access?", [
      ...read("confirmation-copy", selection.kind === "entity" ? "Remove this saved entry from Memory?" : "Revoke this access category? This also affects other connections with the same access category."),
      ...(local.outcome ? read("confirmation-outcome", local.outcome) : []),
      action("confirmation-submit", visit.pending ? "Updating…" : selection.kind === "entity" ? "Remove" : "Revoke access", async () => {
        if (!eligible || visit.pending || nativePrivacyObservation().state?.generation !== selection.privacy) return;
        visit.pending = true; change(value => ({ ...value }));
        try {
          if (selection.kind === "entity" && entity && !await model.removeEntity(entity)) {
            change(value => ({ ...value, outcome: "Couldn't confirm removal. Refresh before trying again." })); return;
          }
          else if (selection.kind === "grant" && grant) await model.revoke(grant.scope);
          change(value => ({ ...value, confirmation: null, entity: selection.kind === "entity" ? null : value.entity, outcome: null }));
        } catch {
          change(value => ({ ...value, outcome: "Couldn't confirm this change. Refresh before trying again." }));
        } finally { visit.pending = false; change(value => ({ ...value })); }
      }, { destructive: true, enabled: eligible && !visit.pending, pending: visit.pending }),
      action("confirmation-cancel", "Cancel", () => change(value => ({ ...value, confirmation: null })), { enabled: !visit.pending }),
    ]);
  }
  const back = () => {
    if (visit.pending || model.preview.deletingEntityKey) return true;
    if (confirmationVisible) { change(value => ({ ...value, confirmation: null })); return true; }
    if (local.entity && model.preview.open) { change(value => ({ ...value, entity: null })); return true; }
    if (model.preview.open) { model.closePreview(); return true; }
    if (pages.some(page => page.id === "memory-record")) { change(value => ({ ...value, record: null, conflict: null })); return true; }
    if (local.liveOpen) { change(value => ({ ...value, liveOpen: false })); return true; }
    return false;
  };
  const ancestor = (choice: { rowId?: string }) => {
    if (!visit.current() || visit.pending || model.preview.deletingEntityKey || !pages.slice(0, -2).some(page => page.id === choice.rowId)) return false;
    change(() => initial());
    if (choice.rowId !== "memory-section") model.closePreview();
    if (choice.rowId === "memory") model.openRoot();
    else if (choice.rowId === "memory-sharing") model.openSharing();
    else if (choice.rowId === "memory-section") { /* Retain the current section and clear only its nested selection. */ }
    else if (choice.rowId === "memory-live") change(value => ({ ...value, liveOpen: true }));
    return true;
  };
  return { pages, rows: actions, back, ancestor, nested: local.liveOpen || confirmationVisible || model.preview.open,
    busy: visit.pending || !!model.preview.deletingEntityKey };
}
