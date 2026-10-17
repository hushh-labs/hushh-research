"use client";

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { FilesService, type OrganizationJob } from "./service";

/** Reconcile existing work only; never resubmit an organization operation. */
export function useFilesJobReconciliation({
  ownerId, jobs, signal, setJobs,
}: {
  ownerId: string;
  jobs: readonly OrganizationJob[];
  signal: AbortSignal;
  setJobs: Dispatch<SetStateAction<OrganizationJob[]>>;
}) {
  const ids = jobs.filter((job) => ["queued", "running"].includes(job.state))
    .map((job) => job.file ?? job.id).sort().join("\n");
  const current = useRef(jobs);
  current.current = jobs;

  useEffect(() => {
    if (!ids || signal.aborted) return;
    const lifetime = new AbortController();
    const deadline = Date.now() + 10 * 60_000;
    const candidates = ids.split("\n");
    let index = 0;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => document.visibilityState !== "hidden" && navigator.onLine &&
      appInteractionCoordinator.getLifecycleSnapshot().state === "active";
    const schedule = () => {
      if (!lifetime.signal.aborted && !signal.aborted && Date.now() < deadline)
        timer = setTimeout(() => void read(), 5_000);
    };
    const read = async () => {
      if (inFlight || lifetime.signal.aborted || signal.aborted) return;
      if (timer !== undefined) clearTimeout(timer);
      if (Date.now() >= deadline) return;
      if (!active()) { schedule(); return; }
      const id = candidates[index++ % candidates.length];
      if (!id) return;
      const expected = current.current.find((job) => (job.file ?? job.id) === id);
      if (!expected || !["queued", "running"].includes(expected.state)) {
        schedule(); return;
      }
      inFlight = true;
      try {
        const requestSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(10_000)]);
        const observed = await FilesService.job(id, requestSignal);
        requestSignal.throwIfAborted();
        if (observed.id === expected.id)
          setJobs((previous) => previous.map((job) => job.id === observed.id ? observed : job));
      } catch { /* Keep the last observation; Refresh remains available. */ }
      finally { inFlight = false; schedule(); }
    };
    const foreground = () => { if (active()) void read(); };
    const unsubscribe = appInteractionCoordinator.subscribeLifecycle(foreground);
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("online", foreground);
    schedule();
    return () => {
      lifetime.abort();
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("online", foreground);
    };
  }, [ids, ownerId, signal, setJobs]);
}
