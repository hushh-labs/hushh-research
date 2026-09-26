/** Wake an already approved direct relay. A hint never grants inference access. */
type ActivationPorts = {
  status: (
    deviceId: string,
  ) => Promise<{ inference_ready: boolean; state: string } | null>;
  hub: (url: string, init: RequestInit) => Promise<Response>;
};
export async function activatePuppyWhenIdle(
  deviceId: string,
  vaultOwnerToken: string | undefined,
  signal: AbortSignal | undefined,
  ports: ActivationPorts,
): Promise<void> {
  const initial = await ports.status(deviceId);
  if (initial?.inference_ready) return;
  if (initial?.state === "busy") throw new Error("LOCAL_MODEL_OVERLOADED");
  if (!vaultOwnerToken) throw new Error("PUPPY_ACTIVATION_REQUIRES_UNLOCK");
  const response = await ports.hub(
    `/api/account/trusted-devices/${encodeURIComponent(deviceId)}/puppy-activation`,
    {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${vaultOwnerToken}` },
    },
  );
  if (!response.ok)
    throw new Error(`PUPPY_ACTIVATION_UNAVAILABLE:${response.status}`);
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 2000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    const status = await ports.status(deviceId);
    if (status?.inference_ready) return;
    if (status?.state === "revoked") throw new Error("PUPPY_REVOKED");
  }
  throw new Error("PUPPY_OFFLINE");
}
