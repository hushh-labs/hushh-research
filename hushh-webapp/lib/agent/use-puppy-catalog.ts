"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";
import { deadlineSignal, whileNotAborted } from "@/lib/agent/puppy-abort";
import { puppyCatalogMessage, puppyCatalogProblem } from "@/lib/agent/puppy-turn-copy";
import { getAuthSessionGeneration, snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";

export type PuppyCatalog = Awaited<ReturnType<typeof ApiService.getPuppyDirectModels>>;

/** Stop the short checking animation while connection readiness continues. */
export const PUPPY_CATALOG_TIMEOUT_MS = 12_000;
/** Existing 120s pod wake + 35s device activation + 20s catalog, with transport margin. */
export const PUPPY_READINESS_TIMEOUT_MS = 180_000;

// Memory only (never browser storage): the last list each machine shared this
// session, so a slow or sleeping machine still shows something useful.
const lastKnown = new Map<string, PuppyCatalog>();

/** Test seam: forget every remembered list. */
export function resetPuppyCatalogMemory() {
  lastKnown.clear();
}

type Owner = { hushhId: string | null; deviceId: string | null; vaultOwnerToken: string | null };

const keyOf = ({ hushhId, deviceId }: Owner) => (hushhId && deviceId ? `${getAuthSessionGeneration()}:${hushhId}:${deviceId}` : "");

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
  const current = await ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken);
  if (!input.isCurrent()) return { outcome: "stale" };
  const operation = await ApiService.setPuppyGlobalModel({
      deviceId, vaultOwnerToken, model: input.model,
      catalogVersion: input.catalog.catalogVersion,
      expectedVersion: current.version,
      requestId: crypto.randomUUID(),
    });
  if (!input.isCurrent()) return { outcome: "stale" };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (!input.isCurrent()) return { outcome: "stale" };
    const result = await ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken);
    if (!input.isCurrent()) return { outcome: "stale" };
    if (result.id !== operation.id) return { outcome: "changed" };
    if (result.status === "applied") {
      const refreshed = await ApiService.getPuppyDirectModels(hushhId, deviceId, vaultOwnerToken);
      return input.isCurrent() ? { outcome: "applied", refreshed } : { outcome: "stale" };
    }
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
export function usePuppyCatalog({ hushhId, deviceId, vaultOwnerToken, machine = "your computer", prefetch = false, enabled = true }: Owner & { machine?: string; prefetch?: boolean; enabled?: boolean }) {
  // Stable across renders, so a dependent effect never re-reads on every paint.
  const owner = useMemo(() => ({ hushhId, deviceId, vaultOwnerToken }), [hushhId, deviceId, vaultOwnerToken]);
  const key = keyOf(owner);
  const [catalog, setCatalog] = useState<PuppyCatalog | null>(() => lastKnown.get(key) ?? null);
  const [catalogKey, setCatalogKey] = useState(key);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [waitingFor, setWaitingFor] = useState<"agent" | "machine" | null>(null);
  const generation = useRef(0);
  const attempts = useRef(0);
  const reading = useRef<(() => boolean) | null>(null);
  const changing = useRef<(() => boolean) | null>(null);
  const cancelRead = useRef<(() => void) | null>(null);

  useEffect(() => {
    generation.current += 1;
    cancelRead.current?.();
    cancelRead.current = null;
    reading.current = null;
    changing.current = null;
    setCatalogKey(key);
    setCatalog(lastKnown.get(key) ?? null);
    setPending(false);
    // A read for the previous owner can no longer clear its own spinner.
    setLoading(false);
    setError("");
    setWaitingFor(null);
    return () => { generation.current += 1; cancelRead.current?.(); };
  }, [key, owner.vaultOwnerToken, enabled]);

  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.visibilityState !== "hidden") return;
      attempts.current += 1;
      cancelRead.current?.();
      cancelRead.current = null;
      reading.current = null;
      setLoading(false);
      setWaitingFor(null);
      setError("");
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => document.removeEventListener("visibilitychange", stopWhenHidden);
  }, []);

  /** Whether a model change is still waiting on the machine. Bounded on its own, after the list. */
  const readPending = useCallback(async (mine: number) => {
    const { deviceId, vaultOwnerToken } = owner;
    const session = snapshotValidatedAuthSessionOwner();
    if (!deviceId || !vaultOwnerToken || !session) return;
    const deadline = deadlineSignal(PUPPY_CATALOG_TIMEOUT_MS);
    try {
      const selection = await whileNotAborted(ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken), deadline.signal);
      if (generation.current !== mine || !isValidatedAuthSessionOwnerCurrent(session)) return;
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
    const session = snapshotValidatedAuthSessionOwner();
    if (!enabled || !hushhId || !deviceId || !vaultOwnerToken || !session || reading.current?.() || document.visibilityState === "hidden") return;
    const mine = generation.current;
    const attempt = ++attempts.current;
    // Only the newest read for the current owner may change what is shown.
    const latest = () => generation.current === mine && attempts.current === attempt && isValidatedAuthSessionOwnerCurrent(session);
    reading.current = latest;
    const deadline = deadlineSignal(PUPPY_READINESS_TIMEOUT_MS);
    let agentAnswered = false;
    const displayTimer = setTimeout(() => {
      if (!latest()) return;
      setLoading(false);
      setWaitingFor(agentAnswered ? "machine" : "agent");
    }, PUPPY_CATALOG_TIMEOUT_MS);
    const cancel = () => { clearTimeout(displayTimer); deadline.cancel(); };
    cancelRead.current = cancel;
    setLoading(true);
    setError("");
    setWaitingFor(null);
    try {
      // Raced as well as signalled: waking the agent does not listen for the
      // signal yet, and the list must never wait on it past the deadline.
      const next = await whileNotAborted(
        ApiService.getPuppyDirectModels(hushhId, deviceId, vaultOwnerToken, deadline.signal, () => {
          agentAnswered = true;
          if (latest() && !deadline.signal.aborted) setWaitingFor(prior => prior ? "machine" : null);
        }),
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
      clearTimeout(displayTimer);
      if (cancelRead.current === cancel) cancelRead.current = null;
      if (latest()) { reading.current = null; setLoading(false); setWaitingFor(null); }
    }
    if (latest()) void readPending(mine);
  }, [owner, machine, readPending, enabled]);

  // One bounded readiness read on entering/returning to an unlocked Puppy view.
  // This uses the existing approved-device relay activation, never inference.
  useEffect(() => {
    if (!prefetch) return;
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [prefetch, load]);

  const applyGlobal = useCallback(async (model: string, onApplied: (previousDefault: string, refreshed: PuppyCatalog) => void) => {
    const { hushhId, deviceId, vaultOwnerToken } = owner;
    const session = snapshotValidatedAuthSessionOwner();
    if (!catalog || !hushhId || !deviceId || !vaultOwnerToken || !session || pending || changing.current?.()) return;
    const mine = generation.current;
    const current = () => generation.current === mine && isValidatedAuthSessionOwnerCurrent(session);
    changing.current = current;
    setError("");
    setPending(true);
    try {
      const result = await awaitGlobalModel({
        owner: { hushhId, deviceId, vaultOwnerToken }, model, catalog, machine,
        isCurrent: current,
      });
      if (!current() || result.outcome === "stale") return;
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
      if (!current()) return;
      setPending(false);
      setError("Couldn't change the default model. Refresh the list and try again.");
    } finally {
      if (changing.current === current) changing.current = null;
    }
  }, [catalog, owner, machine, pending]);

  const connectionMessage = waitingFor === "agent"
    ? "Waking Agent One. The model list will update here."
    : waitingFor === "machine" ? `Connecting to ${machine}. The model list will update here.` : "";
  return { catalog: catalogKey === key ? catalog : null, loading, error, connectionMessage, pending, load, applyGlobal };
}
