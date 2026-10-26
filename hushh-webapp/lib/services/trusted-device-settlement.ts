import type { OwnerPodTransport } from "./owner-pod-endpoint";

export type DeviceRevocationSettlement = {
  hub: Response;
  pod: { delivered: true; pending: null } | { delivered: false; pending: unknown } |
    { delivered: false; pending: null; unpinned: true };
};

/** Replay only a confirmed hub receipt; this adapter never dispatches a hub revoke. */
export async function settleTrustedDeviceRevocation(hub: Response, deviceId: string, uid: string | undefined,
  current: () => boolean, transport: () => Promise<OwnerPodTransport>, requireCompleted = false): Promise<DeviceRevocationSettlement> {
  const ownerPod = await import("./owner-pod-endpoint");
  let pod: DeviceRevocationSettlement["pod"] = { delivered: false, pending: null, unpinned: true };
  if (!hub.ok) return { hub, pod };
  const receipt = await hub.clone().json().catch(() => ({}));
  if ((requireCompleted || receipt.state !== undefined) && (receipt.state !== "completed" || receipt.success !== true)) return { hub, pod: { delivered: false, pending: null } };
  const version = receipt.podBindingVersion;
  if (!current()) return { hub, pod: { delivered: false, pending: null } };
  if (uid && (await ownerPod.loadPinnedEndpoint(uid).catch(() => null))) {
    if (!current() || !Number.isInteger(version) || version < 0) return { hub, pod: { delivered: false, pending: null } };
    try {
      const port = await transport();
      if (!current()) return { hub, pod: { delivered: false, pending: null } };
      pod = await ownerPod.revokeAtPod(uid, deviceId, port, { atVersion: Math.max(1, version) });
    } catch { pod = { delivered: false, pending: null }; }
  }
  return { hub, pod };
}
