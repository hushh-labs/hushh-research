"use client";

import { useMemo, useState } from "react";
import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import type { NativeDrawerRow, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { deriveSyncDisplay } from "@/lib/trusted-device/sync-display";
import { UNLINK_WARNING, type TrustedDevicesModel } from "./use-trusted-devices-model";

/** Closed feature projection, not a second device or routing store. Opaque
 * handles bind visible rows to the existing shared model's current callbacks. */
export function useNativeTrustedDevices(model: TrustedDevicesModel, owner: string, enabled: boolean) {
  const handles = useMemo(() => ({ owner, byId: new Map((enabled ? model.devices : []).map(device =>
    [device.device_id, `device-${crypto.randomUUID()}`])) }), [owner, model.devices, enabled]);
  const handleFor = (id: string) => handles.byId.get(id)!;
  const [pagination, setPagination] = useState({ owner, offset: 0 });
  if (!enabled) return { pages: [] as NativeProfilePage[], rows: new Map() as NativeDrawerActions["rows"] };
  const offset = pagination.owner === owner ? Math.min(pagination.offset, Math.max(0, Math.ceil(model.devices.length / 100) - 1) * 100) : 0;
  const actions = new Map<string, () => void | Promise<void>>();
  const rows: NativeDrawerRow[] = model.devices.slice(offset, offset + 100).map(device => {
    const id = handleFor(device.device_id);
    actions.set(id, () => model.choose(device.device_id));
    return { id, label: device.device_name, detail: deriveSyncDisplay(device, Date.now()).label,
      artworkId: "devices", enabled: !model.busy && !model.uncertain && device.status === "active",
      ...(device.status === "active" ? { chevron: true } : { readOnly: true }) };
  });
  actions.set("devices-refresh", model.refresh);
  actions.set("devices-confirmation-refresh", model.refresh);
  actions.set("devices-previous", () => setPagination({ owner, offset: Math.max(0, offset - 100) }));
  actions.set("devices-next", () => setPagination({ owner, offset: offset + 100 }));
  const pages: NativeProfilePage[] = [{ id: "devices", title: "Trusted devices", sections: [
    { id: "devices-list", rows: rows.length ? rows : [{ id: "devices-empty", label: model.loading ? "Loading devices…" : "No trusted devices are connected.",
      enabled: true, readOnly: true, pending: model.loading }] },
    { id: "devices-status", rows: [
      ...(model.error ? [{ id: "devices-error", label: model.error, enabled: true, readOnly: true }] : []),
      { id: "devices-refresh", label: model.refreshing ? "Refreshing…" : "Refresh", enabled: !model.busy && !model.refreshing, pending: model.refreshing },
      ...(offset > 0 ? [{ id: "devices-previous", label: "Previous devices", enabled: !model.busy }] : []),
      ...(offset + 100 < model.devices.length ? [{ id: "devices-next", label: "More devices", enabled: !model.busy }] : []),
    ] },
  ] }];
  if (model.confirmation) {
    const confirmId = `${handleFor(model.confirmation.device_id)}-unlink`;
    actions.set(confirmId, model.confirm);
    actions.set("devices-cancel", model.cancel);
    pages.push({ id: "device-unlink", title: model.confirmation.device_name, sections: [{ id: "devices-confirmation", rows: [
      { id: "devices-confirmation-description", label: `Unlink ${model.confirmation.device_name}?`, detail: UNLINK_WARNING, enabled: true, readOnly: true },
      ...(model.error ? [{ id: "devices-confirmation-error", label: model.error, enabled: true, readOnly: true }] : []),
      { id: confirmId, label: model.busy ? "Unlinking…" : "Unlink device", enabled: !model.busy && !model.uncertain, pending: model.busy, destructive: true },
      ...(model.uncertain ? [{ id: "devices-confirmation-refresh", label: "Refresh", enabled: !model.busy && !model.refreshing, pending: model.refreshing }] : []),
      { id: "devices-cancel", label: "Cancel", enabled: !model.busy },
    ] }] });
  }
  return { pages, rows: actions as NativeDrawerActions["rows"] };
}
