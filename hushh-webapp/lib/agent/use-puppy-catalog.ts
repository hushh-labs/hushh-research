"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";
import { deadlineSignal, whileNotAborted } from "@/lib/agent/puppy-abort";
import { puppyCatalogMessage, puppyCatalogProblem } from "@/lib/agent/puppy-turn-copy";

export type PuppyCatalog = Awaited<ReturnType<typeof ApiService.getPuppyDirectModels>>;

/** A model list read never spins forever: past this, show the last list and say so. */
export const PUPPY_CATALOG_TIMEOUT_MS = 12_000;

// Memory only (never browser storage): the last list each machine shared this
// session, so a slow or sleeping machine still shows something useful.
const lastKnown = new Map<string, PuppyCatalog>();

/** Test seam: forget every remembered list. */
export function resetPuppyCatalogMemory() {
  lastKnown.clear();
}

type Owner = { hushhId: string | null; deviceId: string | null; vaultOwnerToken: string | null };

const keyOf = ({ hushhId, deviceId }: Owner) => (hushhId && deviceId ? `${hushhId}:${deviceId}` : "");

const capitalized = (phrase: string) => phrase.charAt(0).toUpperCase() + phrase.slice(1);

/** Ask the machine to change its default and wait, bounded, for its own word. */
async function awaitGlobalModel(input: {
  owner: Required<{ [K in keyof Owner]: string }>;
  model: string;
  catalog: PuppyCatalog;
  machine: string;
  isCurrent: () => boolean;
}): Promise<{ outcome: "applied"; refreshed: PuppyCatalog } | { outcome: "refused" | "changed" | "waiting" | "stale" }> {
  const { deviceId, vaultOwnerToken, hushhId } = input.owner;
  const Machine = capitalized(input.machine);
  const current = await ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken);
  const operation = await morphyToast.promise(
    ApiService.setPuppyGlobalModel({
      deviceId, vaultOwnerToken, model: input.model,
      catalogVersion: input.catalog.catalogVersion,
      expectedVersion: current.version,
      requestId: crypto.randomUUID(),
    }),
    {
      loading: `Asking ${input.machine} to change its default…`,
      success: `Sent. Waiting for ${input.machine} to confirm.`,
      error: `${Machine} didn't accept that. Check its connection and try again.`,
    },
  ).unwrap() as { id: string };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (!input.isCurrent()) return { outcome: "stale" };
    const result = await ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken);
    if (!input.isCurrent()) return { outcome: "stale" };
    if (result.id !== operation.id) return { outcome: "changed" };
    if (result.status === "applied")
      return { outcome: "applied", refreshed: await ApiService.getPuppyDirectModels(hushhId, deviceId, vaultOwnerToken) };
    if (result.status === "refused" || result.status === "expired") return { outcome: "refused" };
  }
  // The device may be asleep. Its command stays pending until the server
  // reports an acknowledgement or expiry; never claim a completed switch.
  return { outcome: "waiting" };
}

function globalMessage(outcome: "changed" | "refused" | "waiting", machine: string): string {
  if (outcome === "changed") return `The model request changed. Check ${machine} before trying again.`;
  if (outcome === "refused") return `${capitalized(machine)} didn't switch. Its default is unchanged.`;
  return `Still waiting for ${machine}. Check again once it's awake.`;
}

/** The trusted machine's reported local models, with a bounded read and a memory fallback. */
export function usePuppyCatalog({ hushhId, deviceId, vaultOwnerToken, machine = "your computer" }: Owner & { machine?: string }) {
  // Stable across renders, so a dependent effect never re-reads on every paint.
  const owner = useMemo(() => ({ hushhId, deviceId, vaultOwnerToken }), [hushhId, deviceId, vaultOwnerToken]);
  const key = keyOf(owner);
  const [catalog, setCatalog] = useState<PuppyCatalog | null>(() => lastKnown.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const attempts = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setCatalog(lastKnown.get(key) ?? null);
    setPending(false);
    // A read for the previous owner can no longer clear its own spinner.
    setLoading(false);
    setError("");
    return () => { generation.current += 1; };
  }, [key, owner.vaultOwnerToken]);

  /** Whether a model change is still waiting on the machine. Bounded on its own, after the list. */
  const readPending = useCallback(async (mine: number) => {
    const { deviceId, vaultOwnerToken } = owner;
    if (!deviceId || !vaultOwnerToken) return;
    const deadline = deadlineSignal(PUPPY_CATALOG_TIMEOUT_MS);
    try {
      const selection = await whileNotAborted(ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken), deadline.signal);
      if (generation.current !== mine) return;
      if (selection.status === "pending") setPending(true);
      else if (["applied", "refused", "expired"].includes(selection.status)) setPending(false);
    } catch {
      // The list stands on its own; an unanswered read leaves the mark as it was.
    } finally {
      deadline.clear();
    }
  }, [owner]);

  const load = useCallback(async () => {
    const { hushhId, deviceId, vaultOwnerToken } = owner;
    if (!hushhId || !deviceId || !vaultOwnerToken) return;
    const mine = generation.current;
    const attempt = ++attempts.current;
    // Only the newest read for the current owner may change what is shown.
    const latest = () => generation.current === mine && attempts.current === attempt;
    const deadline = deadlineSignal(PUPPY_CATALOG_TIMEOUT_MS);
    let agentAnswered = false;
    setLoading(true);
    setError("");
    try {
      // Raced as well as signalled: waking the agent does not listen for the
      // signal yet, and the list must never wait on it past the deadline.
      const next = await whileNotAborted(
        ApiService.getPuppyDirectModels(hushhId, deviceId, vaultOwnerToken, deadline.signal, () => { agentAnswered = true; }),
        deadline.signal,
      );
      if (!latest()) return;
      if (next.status === "available") {
        lastKnown.set(keyOf(owner), next);
        setCatalog(next);
      } else {
        setError(puppyCatalogMessage("not-shared", machine, lastKnown.has(keyOf(owner))));
      }
    } catch (cause) {
      if (!latest()) return;
      const problem = puppyCatalogProblem(cause, deadline.signal.aborted, agentAnswered);
      setError(puppyCatalogMessage(problem, machine, lastKnown.has(keyOf(owner))));
    } finally {
      deadline.clear();
      if (latest()) setLoading(false);
    }
    void readPending(mine);
  }, [owner, machine, readPending]);

  const applyGlobal = useCallback(async (model: string, onApplied: (previousDefault: string, refreshed: PuppyCatalog) => void) => {
    const { hushhId, deviceId, vaultOwnerToken } = owner;
    if (!catalog || !hushhId || !deviceId || !vaultOwnerToken) return;
    const mine = generation.current;
    setError("");
    setPending(true);
    try {
      const result = await awaitGlobalModel({
        owner: { hushhId, deviceId, vaultOwnerToken }, model, catalog, machine,
        isCurrent: () => generation.current === mine,
      });
      if (result.outcome === "stale") return;
      if (result.outcome === "applied") {
        lastKnown.set(keyOf(owner), result.refreshed);
        setCatalog(result.refreshed);
        onApplied(catalog.defaultModel, result.refreshed);
        setPending(false);
        morphyToast.success(`${capitalized(machine)} confirmed the new default model.`);
        return;
      }
      if (result.outcome !== "waiting") setPending(false);
      setError(globalMessage(result.outcome, machine));
    } catch {
      setPending(false);
      setError("Couldn't change the default model. Refresh the list and try again.");
    }
  }, [catalog, owner, machine]);

  return { catalog, loading, error, pending, load, applyGlobal };
}
