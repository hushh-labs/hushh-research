// Only machine I/O is replaced. Render the actual sheet, notices and Radix controls.
export const isLocalHost = () => true;
export const usePuppyLink = () => null;
export async function fetchPuppyResources() {
  return { configured: true, reachable: true,
    agent: { model: "google/gemma-4-12b", on_device: true, on_device_gate: true },
    machine: { ram_used_pct: 41.2, disk_free_gb: 54.7 },
    link: location.hash === "#expired" ? { session: "expired", remedy: "/synthetic-reconnect-command-with-a-deliberately-long-unbroken-device-reference" } : { session: "ok" } };
}
export async function fetchPuppyJobs() { return { configured: true, reachable: true, jobs: [] }; }
export async function refreshPuppyLink() {}
export async function setPuppyJobPaused() { return { ok: true }; }

export async function fetchPuppyModelOptions() { throw new Error("Model execution is outside this layout fixture"); }
export async function assignPuppyModel() { throw new Error("Model assignment is outside this layout fixture"); }
