"use client";

import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { ConnectorDetailAction, ConnectorsPanelPresentation } from "@/components/agent/connectors-panel";
import type { NativeDrawerChoice, NativeDrawerRow, NativeDrawerSection, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { NativeConnectorEditor, NativeConnectorForm } from "./native-connector-editor";
import { nativeMemoryText } from "./use-native-memory";
import { ownerPacketSections } from "@/components/consent/drive-packet-catalog";
import { ownerPacketTitle, ownerStatusLine } from "@/components/consent/packets/packet-copy";
import { connectorArtworkId } from "@/lib/profile/connector-artwork";
import { DRIVE_GROUP_DISCLOSURE } from "@/components/agent/drive-data-packets";

class ConnectorVisit {
  constructor(readonly owner: string, readonly active: boolean) {}
  live = false;
  private presentation: ConnectorsPanelPresentation | undefined;
  private editor: object | null = null;
  private handles = new Map<string, string>();
  handle(key: string) { let id = this.handles.get(key); if (!id) { id = crypto.randomUUID(); this.handles.set(key, id); } return id; }
  current() { const state = nativePrivacyObservation().state; return this.live && state?.appIsActive === true && !state.shielded; }
  activate() { this.live = this.active; }
  update(value: ConnectorsPanelPresentation | undefined, editor: object | null) { this.presentation = value; this.editor = editor; }
  ownsDraft(editor: object | null) { return this.live && editor !== null && this.editor === editor; }
  model() { return this.presentation; }
  retire() { this.live = false; this.handles.clear(); this.presentation = undefined; this.editor = null; }
}
type Local = { custom: string | null; drive: "files" | "packets" | "preparation" | "trust" | "groups" | null; revoke: string | null;
  rule: string | null; link: { network: "instagram" | "linkedin"; baseline: string } | null; page: Record<string, number>; failedEditor: boolean };
const initial = (): Local => ({ custom: null, drive: null, revoke: null, rule: null, link: null, page: {}, failedEditor: false });
const title = (value: string) => nativeMemoryText(value, 256)[0] || "Connector";
const body = (value: string) => nativeMemoryText(value, 4096)[0] || "Details";

/** Authored private presentation only. No service, credential, tool execution,
 * provider grant or second draft store is introduced by this adapter. */
export function useNativeConnectors(model: ConnectorsPanelPresentation | undefined, owner: string, active: boolean) {
  const visit = useMemo(() => new ConnectorVisit(owner, active), [owner, active]);
  const [stored, setStored] = useState<{ visit: ConnectorVisit; value: Local } | null>(null);
  const local = stored?.visit === visit ? stored.value : initial();
  useLayoutEffect(() => { visit.update(model, local.link); });
  useLayoutEffect(() => { visit.activate(); return () => visit.retire(); }, [visit]);
  const linkCurrent = useCallback(() => {
    const detail = visit.model()?.detail;
    return visit.ownsDraft(local.link) && local.link !== null && detail?.kind === "social" && detail.network === local.link.network && detail.current();
  }, [visit, local.link]);
  const change = useCallback((update: (value: Local) => Local) => {
    if (visit.current()) setStored(previous => ({ visit, value: update(previous?.visit === visit ? previous.value : initial()) }));
  }, [visit]);
  const removeCustom = useCallback(async () => {
    const custom = visit.model()?.custom;
    if (!visit.current() || !custom || custom.mutationPending()) return;
    if (custom.removing) await custom.remove(); else if (custom.removingInvalid) await custom.removeInvalid(); else return;
    if (!visit.model()?.custom?.removing && !visit.model()?.custom?.removingInvalid) change(value => ({ ...value, custom: null }));
  }, [visit, change]);
  const rows = new Map<string, (choice: NativeDrawerChoice) => Promise<void>>();
  const bind = (key: string, label: string, action: () => void | Promise<unknown>, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = visit.handle(key);
    rows.set(id, async () => { if (visit.current()) await action(); });
    return { id, label: body(label), enabled: true, ...extra };
  };
  const read = (key: string, label: string, detail?: string): NativeDrawerRow => ({
    id: visit.handle(key), label: body(label), ...(detail ? { detail } : {}), enabled: true, readOnly: true,
  });
  const text = (key: string, value: string): NativeDrawerRow[] => nativeMemoryText(value, 4096).map((chunk, index) => read(`${key}:${index}`, chunk));
  const action = (key: string, value?: ConnectorDetailAction): NativeDrawerRow[] => value ? [bind(key, value.label, value.run,
    { enabled: !value.disabled, ...(value.destructive ? { destructive: true } : {}) })] : [];
  const toggle = (key: string, label: string, selected: boolean, enabled: boolean, update: (next: boolean) => void): NativeDrawerRow => {
    const options = ([false, true] as const).map(next => {
      const choice = bind(`${key}:${next}`, next ? "On" : "Off", () => { if (enabled && selected !== next) update(next); });
      return { id: choice.id, label: choice.label, selected: selected === next };
    });
    return { id: visit.handle(key), label, enabled, toggle: true, options };
  };
  const pageRows = <T,>(key: string, values: readonly T[], project: (value: T, index: number) => NativeDrawerRow[]): NativeDrawerRow[] => {
    const page = Math.min(local.page[key] ?? 0, Math.max(0, Math.ceil(values.length / 40) - 1));
    return [...values.slice(page * 40, (page + 1) * 40).flatMap((value, index) => project(value, page * 40 + index)),
      ...(page > 0 ? [bind(`${key}:previous`, "Previous", () => change(state => ({ ...state, page: { ...state.page, [key]: page - 1 } })))] : []),
      ...((page + 1) * 40 < values.length ? [bind(`${key}:next`, "More", () => change(state => ({ ...state, page: { ...state.page, [key]: page + 1 } })))] : [])];
  };
  const catalog: NativeDrawerSection[] = [];
  if (model?.catalog.status !== "ready") catalog.push({ id: "connectors-state", rows: [read("state", model?.catalog.status === "locked" ?
    "Unlock your vault to manage connectors." : model?.catalog.status === "unavailable" ? "Connector catalog unavailable." : "Loading connectors…"),
    ...(model?.catalog.status === "unavailable" ? [bind("catalog-retry", "Retry", model.catalog.retry)] : [])] });
  for (const group of model?.catalog.groups ?? []) catalog.push({ id: `connectors-${group.title.toLowerCase()}`, title: group.title,
    rows: pageRows(`catalog:${group.title}`, group.entries, entry => [bind(`connector:${entry.id}`, entry.name,
      entry.onOpen ?? entry.action?.onClick ?? (() => undefined), { chevron: Boolean(entry.onOpen),
        detail: [entry.detail, entry.pending === "disconnect" ? "Disconnecting…" : entry.pending === "connect" ? "Connecting…" : entry.failure || entry.trailingText].filter(Boolean).join(" · ") || undefined,
        artworkId: connectorArtworkId(entry.id) ? `connector-${entry.id.replaceAll("_", "-")}` : "connectors", pending: Boolean(entry.pending),
        enabled: Boolean(entry.onOpen || entry.action && !entry.action.disabled) })]) });
  const custom = model?.custom;
  if (custom && !model?.catalog.query.trim()) {
    catalog.push({ id: "connectors-custom", title: "Custom connectors", rows: [
      ...(custom.status === "loading" ? [read("custom-loading", "Loading saved connectors…")] : custom.status === "failed" ? [read("custom-failed", "Could not load saved connectors.")] : []),
      ...pageRows("custom-list", custom.items, item => [bind(`custom:${item.connectorId}`, item.displayName,
        () => change(value => ({ ...value, custom: item.connectorId })), { chevron: true, artworkId: "connectors", enabled: !custom.busy,
          detail: !item.enabled ? "Blocked for new turns" : custom.authRequired[item.connectorId] ? "Sign-in needed" : custom.checkFailed[item.connectorId] ? "Connection check failed" :
            custom.catalogs[item.connectorId] ? `${custom.catalogs[item.connectorId]?.length ?? 0} tools discovered` : "Tools not checked" })]),
      ...pageRows("custom-invalid", custom.invalid, (item, index) => [item.removable ? bind(`invalid:${item.connectorId}`, `Remove saved connector ${index + 1}`,
        () => custom.requestRemoveInvalid(item), { enabled: !custom.busy, destructive: true, detail: "Its saved settings need repair." }) : read(`invalid:${index}`, `Saved connector ${index + 1}`, "Needs repair")]),
      bind("custom-add", "Add connector", custom.openEditor, { enabled: custom.status === "ready" && !custom.busy, symbol: "plus" }),
    ] });
  }
  const searchId = visit.handle("catalog-search");
  rows.set(searchId, async choice => { if (visit.current() && typeof choice.text === "string" && choice.text.length <= 256) model?.catalog.search(choice.text); });
  const pages: NativeProfilePage[] = [{ id: "connectors", title: "Connectors", sections: catalog,
    memorySearch: { id: searchId, query: model?.catalog.query ?? "" } }];
  const detail = model?.detail;
  if (model?.selectedConnector && detail) {
    let detailRows: NativeDrawerRow[] = [];
    if (detail.kind === "gmail") detailRows = [read("mail-account", detail.account, detail.status), ...action("mail-connect", detail.connect), ...action("mail-disconnect", detail.disconnect),
      ...action("mail-retry", detail.retry), ...(detail.connected ? [read("mail-read", "Read mail", "Allowed"), read("mail-send", "Send mail", detail.sendAllowed ? "Allowed · review required" : "Not enabled"),
        ...(detail.draftsAllowed ? [read("mail-drafts", "Drafts", "Allowed · review required")] : action("mail-drafts", detail.enableDrafts))] : []), ...action("mail-cancel", detail.cancelSignIn), ...text("mail-message", detail.message)];
    else if (detail.kind === "calendar") detailRows = [...text("calendar-description", detail.description), read("calendar-status", detail.status), ...action("calendar-connection", detail.connection),
      ...text("calendar-helper", detail.helper ?? ""), ...action("calendar-cancel", detail.cancelSignIn), ...action("calendar-retry", detail.retry), ...text("calendar-message", detail.message)];
    else if (detail.kind === "plaid") detailRows = [read("bank-status", detail.status), ...pageRows("banks", detail.banks, bank => [read(`bank:${bank.key}`, bank.name, bank.status),
      ...action(`bank-disconnect:${bank.key}`, bank.disconnect)]), ...action("bank-connect", detail.connect), ...text("bank-message", detail.message)];
    else if (detail.kind === "social") detailRows = [...text("social-note", "Your profile should be a public figure profile."), read("social-link", "Profile link", detail.link || "Not added"),
      bind("social-edit", "Edit profile link", () => change(value => ({ ...value, link: { network: detail.network, baseline: detail.link } })), { chevron: true })];
    else if (detail.kind === "drive") detailRows = [read("drive-account", detail.account, detail.status),
      ...detail.actions.flatMap((value, index) => action(`drive-action:${index}`, value)),
      ...detail.notes.flatMap((value, index) => text(`drive-note:${index}`, value)), ...text("drive-message", detail.message),
      ...(detail.background ? [read("drive-background-state", "Background Drive access", detail.background.description),
        ...(detail.background.enabled === null ? [] : [toggle("drive-background", "Background Drive access", detail.background.enabled, !detail.background.busy, detail.background.change)]),
        ...action("drive-background-retry", detail.background.retry)] : []),
      ...(detail.collection ? [bind("drive-preparation", "Prepare packets", () => change(value => ({ ...value, drive: "preparation" })), { detail: detail.collection.caption, chevron: true }),
        ...(detail.collection.status ? [bind("drive-packets", "Packets", () => change(value => ({ ...value, drive: "packets" })), { chevron: true })] : [])] : []),
      bind("drive-trust", "Trusted documents", () => change(value => ({ ...value, drive: "trust" })), { chevron: true }),
      ...(detail.groups ? [read("drive-groups-heading", "Data packets", detail.groups.caption),
        ...(detail.groups.overview?.groups.map(group => bind(`drive-group:${group.shelf}`, group.name,
          () => { detail.groups?.open(group.shelf); change(value => ({ ...value, drive: "groups" })); },
          { detail: `${detail.groups?.overview?.status.counts[group.shelf] ?? 0} files`, chevron: true, symbol: "folder" })) ?? []),
        ...(detail.groups.overview ? [bind("drive-group-kept", "Not sorted yet", () => { detail.groups?.open("kept"); change(value => ({ ...value, drive: "groups" })); },
          { detail: `${detail.groups.overview.status.counts.kept} files`, chevron: true }),
          ...(!detail.groups.overview.status.enabled ? text("drive-group-disclosure", DRIVE_GROUP_DISCLOSURE) : []),
          bind("drive-group-processing", detail.groups.saving ? "Saving…" : detail.groups.overview.status.enabled ? "Pause data packets" : "Prepare data packets",
            detail.groups.toggle, { enabled: detail.groups.canToggle }),
        ] : []),
        ...(detail.groups.failed === "overview" || detail.groups.failed === "processing" ? [bind("drive-group-retry", "Retry data packets", detail.groups.refresh)] : []),
      ] : []),
      ...(detail.files.length ? [bind("drive-files", "Previously added files", () => change(value => ({ ...value, drive: "files" })), { chevron: true })] : []),
    ];
    else if (detail.kind === "curated") detailRows = [...text("curated-description", detail.description), ...text("curated-account", detail.account ?? ""), read("curated-status", detail.status),
      ...action("curated-connect", detail.connect), ...action("curated-disconnect", detail.disconnect), ...action("curated-cancel", detail.cancelSignIn), ...text("curated-message", detail.message)];
    pages.push({ id: "connector-detail", title: title(model.selectedConnector.name), sections: [{ id: "connector-detail-content", rows: detailRows }] });
  }
  if (model?.selectedConnector && !detail) pages.push({ id: "connector-detail", title: title(model.selectedConnector.name), sections: [{ id: "connector-unavailable", rows: [
    read("connector-unavailable-copy", "This connector is unavailable."), bind("connector-unavailable-retry", "Retry", model.catalog.retry),
  ] }] });
  const drive = detail?.kind === "drive" ? detail : null;
  if (drive?.groups?.selected && local.drive === "groups") {
    const groups = drive.groups;
    pages.push({ id: "connector-group-files", title: title(groups.selectedName), sections: [{ id: "group-files-content", rows: [
      ...pageRows(`group-files:${groups.selected}`, groups.page?.items ?? [], file => [bind(`group-file:${file.ref}`, file.title, () => groups.openFile(file), { detail: file.day ?? "Open in Google Drive", chevron: true })]),
      ...(groups.loading ? text("group-files-loading", "Loading files…") : []),
      ...(groups.page && !groups.page.items.length && !groups.loading ? text("group-files-empty", "No indexed files in this folder yet.") : []),
      ...(groups.failed === "files" ? [read("group-files-error", "Couldn’t load files."), bind("group-files-retry", "Retry files", groups.retry, { enabled: !groups.loading })] : []),
      ...(groups.page?.nextCursor !== null && groups.page?.nextCursor !== undefined ? [bind("group-files-more", "Load more files", groups.more, { enabled: !groups.loading })] : []),
    ] }] });
  }
  if (drive && local.drive === "preparation" && drive.collection) {
    const collection = drive.collection, status = collection.status;
    const content = [read("preparation-caption", "Prepare packets", collection.caption),
      ...(status ? [toggle("preparation-switch", "Prepare packets", status.enabled, collection.canToggle, () => { void collection.toggle(); }),
        ...Object.entries(status.counts).map(([key, count]) => read(`preparation:${key}`, key[0]!.toUpperCase() + key.slice(1), count.toLocaleString())),
        ...text("preparation-last-index", status.lastIndexedAt ? `Last indexed ${new Date(status.lastIndexedAt).toLocaleString()}` : "No files indexed yet."),
        ...(collection.paused ? text("preparation-paused", "Saved packets were last verified before preparation paused.") : []),
      ] : []), ...(collection.error === "read" ? [bind("preparation-retry", "Retry preparation", collection.read, { enabled: !collection.busy })] : [])];
    pages.push({ id: "connector-preparation", title: "Prepare packets", sections: [{ id: "preparation-content", rows: content }] });
  }
  if (drive && local.drive === "files") pages.push({ id: "connector-files", title: "Previously added files", sections: [{ id: "drive-file-content", rows:
    pageRows("drive-files", drive.files, file => [read(`drive-file:${file.key}`, file.name, file.status),
      ...(file.changeBackground ? [toggle(`file-background:${file.key}`, "Prepare while you’re away", file.background, !drive.busy, file.changeBackground)] : []),
      ...action(`file-sync:${file.key}`, file.sync), ...action(`file-remove:${file.key}`, file.remove)]) }] });
  if (drive?.selection) pages.push({ id: "connector-selection", title: "Confirm selected files", sections: [{ id: "drive-selection-content", rows: [
    ...text("selection-copy", "Add these files to your One file list? Google access is not the same as sharing with another person."),
    ...pageRows("selected-files", drive.selection.files, (file, index) => text(`selected-file:${index}`, file.name)),
    ...(drive.selection.canPrepare ? [toggle("selection-background", "Prepare while you’re away", drive.selection.background, !drive.selection.busy, drive.selection.changeBackground)] : []),
    ...action("selection-confirm", drive.selection.confirm), ...action("selection-cancel", drive.selection.cancel),
  ] }] });
  if (drive && local.drive === "packets") {
    const catalog = drive.packets;
    pages.push({ id: "connector-packets", title: "Packets", sections: [{ id: "packet-list-content", rows: [
      ...pageRows("packets", catalog.packets, packet => [bind(`packet:${packet.packetId}:${packet.version}:${packet.listingRevision}`, ownerPacketTitle(packet), () => catalog.open(packet), { detail: ownerStatusLine(packet), chevron: true })]),
      ...(catalog.loaded && !catalog.packets.length && !catalog.error ? [read("packets-empty", catalog.preparationPaused ? "Preparation paused" : "Agent One is preparing your packets.")] : []),
      ...(catalog.error ? [read("packets-error", "Couldn’t load packets."), bind("packets-retry", "Retry", () => catalog.load(), { enabled: !catalog.busy })] : []),
      ...(catalog.busy && !catalog.loaded ? [read("packets-loading", "Loading packets…")] : []),
      ...(catalog.cursor ? [bind("packets-more", "Load more", () => catalog.load(catalog.cursor), { enabled: !catalog.busy })] : []),
    ] }] });
    if (drive.packet.packet) pages.push({ id: "connector-packet", title: title(ownerPacketTitle(drive.packet.packet)), sections: [
      ...ownerPacketSections(drive.packet.packet, drive.packet.amount).map(section => ({ id: `packet:${section.id}`, title: section.title,
        rows: (section.rows ?? []).flatMap(row => [read(`packet:${section.id}:${row.id}`, row.title, [row.description, row.value].filter(Boolean).join("\n") || undefined)]) })),
      { id: "packet-actions", rows: [...drive.packet.actions.map(value => bind(`packet-action:${value.id}`, value.label, () => value.onSelect?.(), { enabled: !value.disabled })), ...text("packet-message", drive.packet.message)] },
    ] });
  }
  if (drive && local.drive === "trust") {
    const trust = drive.trust;
    const content = [...(trust.rules.length ? text("trust-note", "Matching files may be shared without asking again while their original Drive connection is active.") : !trust.message ? [read("trust-empty", "None yet")] : []),
      ...pageRows("trust-rules", trust.rules, rule => [bind(`trust-person:${rule.ruleId}`, rule.recipientEmail,
        () => change(value => ({ ...value, rule: rule.ruleId })), { chevron: true, detail: rule.scope === "any_requested_drive_file" ? "Any requested Drive file" : rule.purpose.purpose })]),
      ...text("trust-message", trust.message)];
    pages.push({ id: "connector-trust", title: "Trusted documents", sections: [{ id: "trust-content", rows: content }] });
    const rule = trust.rules.find(value => value.ruleId === local.rule);
    if (rule) pages.push({ id: "connector-trust-rule", title: title(rule.recipientEmail), sections: [{ id: "trust-rule-content", rows: [
      ...(rule.scope === "any_requested_drive_file" ? text("trust-rule-all", "Any requested Drive file, including future files.") : [
        ...text("trust-rule-purpose", `Purpose: ${rule.purpose.purpose}`),
        ...(rule.purpose.periodStart && rule.purpose.periodEnd ? text("trust-rule-period", `${rule.purpose.periodStart} to ${rule.purpose.periodEnd}`) : []),
        ...text("trust-rule-exact", "Same request purpose and these exact files while their contents stay unchanged:"),
        ...pageRows(`trust-files:${rule.ruleId}`, rule.fileNames, (name, file) => text(`trust-file:${rule.ruleId}:${file}`, name)),
      ]), ...text("trust-rule-readiness", rule.readiness === "background_off" ? "Enable background preparation to handle requests while away." : rule.readiness === "reconnect_required" ? "Reconnect Drive to resume." : ""),
      bind(`trust-revoke:${rule.ruleId}`, "Revoke document trust", () => change(value => ({ ...value, revoke: rule.ruleId })), { enabled: !trust.busy, destructive: true }),
    ] }] });
    if (rule && local.revoke === rule.ruleId) pages.push({ id: "connector-trust-confirm", title: "Revoke document trust?", sections: [{ id: "trust-confirm-content", rows: [
      ...text("trust-confirm-copy", "Future requests will need approval. Existing Google access must be removed separately."),
      bind("trust-cancel", "Cancel", () => change(value => ({ ...value, revoke: null })), { enabled: !trust.busy }),
      bind("trust-confirm", "Revoke document trust", async () => { if (await trust.revoke(rule)) change(value => ({ ...value, revoke: null })); }, { enabled: !trust.busy, destructive: true }),
    ] }] });
  }
  if (!model?.selectedConnector && custom?.editing) pages.push({ id: "connector-custom", title: "Add connector", sections: [] });
  else if (!model?.selectedConnector && local.custom && custom) {
    const item = custom.items.find(value => value.connectorId === local.custom);
    const content: NativeDrawerRow[] = item ? [read("custom-status", item.displayName, !item.enabled ? "Blocked for new turns" : custom.authRequired[item.connectorId] ?
      item.authenticationKind === "api_key" ? "Saved credential rejected · remove and add again" : "Sign-in needed" : custom.checkFailed[item.connectorId] ? "Connection check failed" : "Saved connector"),
      ...(custom.canSignIn && item.authenticationKind !== "api_key" && (item.hasOAuthRegistration || item.authenticationKind === "oauth" || custom.authRequired[item.connectorId]) ?
        [bind("custom-sign-in", "Sign in", () => custom.connect(item), { enabled: !custom.busy && item.enabled })] : []),
      bind("custom-refresh", "Refresh tools", () => custom.refresh(item), { enabled: !custom.busy && item.enabled }),
      ...pageRows("custom-tools", custom.catalogs[item.connectorId] ?? [], tool => [bind(`tool:${tool.id}`, tool.name,
        () => custom.setToolBlocked(item, tool), { enabled: !custom.busy && item.enabled,
          detail: tool.permission === "blocked" ? "Blocked · Allow" : tool.review === "not_required" ? "Runs without asking · Block" : "Ask first · Block" })]),
      bind("custom-remove", "Remove connector", () => custom.requestRemove(item), { enabled: !custom.busy, destructive: true }),
    ] : [read("custom-missing", "Connector unavailable", "Go back to check the latest saved connectors.")];
    pages.push({ id: "connector-custom-detail", title: title(item?.displayName ?? "Custom connector"), sections: [{ id: "custom-detail-content", rows: content }] });
  }
  const confirmation = model?.confirmation;
  if (confirmation) pages.push({ id: "connector-confirm", title: title(confirmation.title), sections: [{ id: "connector-confirm-content", rows: [
    ...text("confirmation-description", confirmation.description), bind("confirm-cancel", "Cancel", confirmation.cancel, { enabled: !confirmation.busy }),
    bind("confirm-submit", confirmation.action, confirmation.confirm, { enabled: !confirmation.busy, destructive: true }),
  ] }] });
  if (custom?.removing || custom?.removingInvalid) pages.push({ id: "connector-custom-confirm", title: title(custom.removing ? `Remove ${custom.removing.displayName}?` : "Remove invalid connector?"), sections: [{ id: "custom-confirm-content", rows: [
    ...text("custom-confirm-copy", "This removes its saved settings from your vault. It does not revoke access at the provider or undo completed actions."),
    bind("custom-confirm-cancel", "Cancel", custom.cancelRemove, { enabled: !custom.busy }),
    bind("custom-confirm-remove", "Remove connector", removeCustom, { enabled: !custom.busy, destructive: true }),
  ] }] });
  const blocking = Boolean(custom?.busy || confirmation?.busy || drive?.busy || drive?.collection?.busy || drive?.groups?.saving || drive?.packet.busy || drive?.trust.busy);
  const navigationBlocked = () => {
    const model = visit.model(), drive = model?.detail?.kind === "drive" ? model.detail : null;
    return Boolean(model?.custom?.mutationPending() || model?.confirmation?.busy || drive?.mutationPending() || drive?.collection?.mutationPending() || drive?.groups?.mutationPending() || drive?.packet.mutationPending() || drive?.trust.mutationPending());
  };
  const back = () => {
    if (navigationBlocked()) return true;
    const current = visit.model();
    if (current?.custom?.removing || current?.custom?.removingInvalid) { current.custom.cancelRemove(); return true; }
    if (current?.confirmation) { current.confirmation.cancel(); return true; }
    if (drive?.packet.editingPrice) { drive.packet.cancelPrice(); return true; }
    if (drive?.selection) { drive.selection.cancel.run(); return true; }
    if (local.revoke) { change(value => ({ ...value, revoke: null })); return true; }
    if (local.rule) { change(value => ({ ...value, rule: null })); return true; }
    if (drive?.packets.opened) { drive.packets.close(); return true; }
    if (drive?.groups?.selected) { drive.groups.close(); change(value => ({ ...value, drive: null })); return true; }
    if (local.drive) { change(value => ({ ...value, drive: null })); return true; }
    if (current?.custom?.editing) { current.custom.nativeEditor.cancelEditor(); return true; }
    if (local.custom) { change(value => ({ ...value, custom: null })); return true; }
    return false;
  };
  const ancestor = (choice: { rowId?: string }) => {
    if (!visit.current() || navigationBlocked() || drive?.selection || !pages.slice(0, -2).some(page => page.id === choice.rowId)) return false;
    if (choice.rowId === "connectors") {
      custom?.nativeEditor.cancelEditor(); custom?.cancelRemove(); model?.confirmation?.cancel(); model?.catalog.show(); change(() => initial());
    } else if (choice.rowId === "connector-detail") {
      model?.confirmation?.cancel(); drive?.packets.close(); drive?.groups?.close(); change(value => ({ ...value, drive: null, rule: null, revoke: null }));
    } else if (choice.rowId === "connector-trust") change(value => ({ ...value, rule: null, revoke: null }));
    else if (choice.rowId === "connector-packets") drive?.packets.close();
    else if (choice.rowId === "connector-files") model?.confirmation?.cancel();
    else return false;
    return true;
  };
  return { pages, rows, blocking, navigationBlocked, back, ancestor, nested: pages.length > 1,
    mapped: Boolean(model),
    failed: local.failedEditor,
    formScene: custom?.editing ? "connector-custom-server" as const : detail?.kind === "social" && local.link?.network === detail.network
      ? "connector-profile-link" as const : drive?.packet.editingPrice ? "connector-packet-price" as const : null,
    editor: (destinationId: string) => {
      const onFallback = () => change(value => ({ ...value, failedEditor: true }));
      if (custom?.editing) return <NativeConnectorEditor model={custom.nativeEditor} owner={owner} destinationId={destinationId} onClose={custom.nativeEditor.cancelEditor} onFallback={onFallback} />;
      if (detail?.kind === "social" && local.link?.network === detail.network) return <NativeConnectorForm scene="connector-profile-link" owner={owner} destinationId={destinationId}
        model={{ current: linkCurrent, draft: { network: detail.network, link: detail.link }, canSave: true, busy: false, error: null,
          mutationPending: () => false, inputRevision: detail.inputRevision,
          changeDraft: (draft, expected) => linkCurrent() && "network" in draft && draft.network === detail.network && "link" in draft && detail.changeLink(draft.link, expected),
          save: async () => linkCurrent() }}
        onSaved={() => change(value => ({ ...value, link: null }))}
        onClose={() => { if (linkCurrent() && local.link) { detail.changeLink(local.link.baseline); change(value => ({ ...value, link: null })); } }} onFallback={onFallback} />;
      if (drive?.packet.editingPrice) {
        const packet = drive.packet;
        return <NativeConnectorForm scene="connector-packet-price" owner={owner} destinationId={destinationId}
          model={{ current: packet.editorCurrent, draft: { price: packet.price }, canSave: packet.amount !== null, busy: packet.busy,
            error: packet.amount === null ? "Enter $0.50–$500, up to two decimal places." : null, inputRevision: packet.inputRevision, mutationPending: packet.mutationPending,
            changeDraft: (draft, expected) => packet.editorCurrent() && "price" in draft && packet.changePrice(draft.price, expected),
            save: async () => packet.editorCurrent() && packet.amount !== null }}
          onSaved={() => { void packet.finishPrice(); }} onClose={packet.cancelPrice} onFallback={onFallback} />;
      }
      return null;
    },
  };
}
