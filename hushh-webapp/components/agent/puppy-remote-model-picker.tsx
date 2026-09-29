"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Cpu, Loader2 } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";

type Catalog = Awaited<ReturnType<typeof ApiService.getPuppyDirectModels>>;
type Scope = "chat" | "global";

/** Remote control is limited to models the trusted machine reported as local. */
export function PuppyRemoteModelPicker({
  hushhId,
  deviceId,
  vaultOwnerToken,
  chatModel,
  busy,
  hasTurns,
  onChatModel,
  onGlobalModel,
}: {
  hushhId: string | null;
  deviceId: string | null;
  vaultOwnerToken: string | null;
  chatModel: string | null;
  busy: boolean;
  hasTurns: boolean;
  onChatModel: (model: string, catalogVersion: string) => void;
  onGlobalModel: (previousDefault: string, catalog: Catalog) => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("chat");
  const [applying, setApplying] = useState(false);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = generation.current + 1;
    generation.current = current;
    setCatalog(null);
    setChoice(null);
    setPending(false);
    setError("");
    return () => { generation.current += 1; };
  }, [hushhId, deviceId, vaultOwnerToken]);

  const load = useCallback(async () => {
    if (!hushhId || !deviceId || !vaultOwnerToken) return;
    const currentGeneration = generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await ApiService.getPuppyDirectModels(hushhId, deviceId, vaultOwnerToken);
      if (generation.current !== currentGeneration) return;
      setCatalog(next);
      if (next.status !== "available") setError("Your machine has not reported its local models yet.");
      const selection = await ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken).catch(() => null);
      if (generation.current !== currentGeneration) return;
      if (selection?.status === "pending") setPending(true);
      else if (selection?.status === "applied" || selection?.status === "refused" || selection?.status === "expired")
        setPending(false);
    } catch {
      if (generation.current === currentGeneration)
        setError("Couldn’t check models on your machine. Try again when it is awake.");
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [hushhId, deviceId, vaultOwnerToken]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function apply() {
    if (!choice || !catalog || !deviceId || !vaultOwnerToken || !hushhId || applying || pending) return;
    if (catalog.status !== "available" || !catalog.models.some(({ id }) => id === choice)) return;
    if (scope === "chat") {
      onChatModel(choice, catalog.catalogVersion);
      setChoice(null);
      setOpen(false);
      return;
    }
    setApplying(true);
    setError("");
    try {
      const current = await ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken);
      const operation = await morphyToast.promise(
        ApiService.setPuppyGlobalModel({
          deviceId, vaultOwnerToken, model: choice,
          catalogVersion: catalog.catalogVersion,
          expectedVersion: current.version,
          requestId: crypto.randomUUID(),
        }),
        {
          loading: "Asking your machine to change its default…",
          success: "Request sent to your machine. Waiting for confirmation.",
          error: "Your machine did not accept the request. Check its connection and try again.",
        },
      ).unwrap() as { id: string };
      const currentGeneration = generation.current;
      setPending(true);
      setChoice(null);
      setOpen(false);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (generation.current !== currentGeneration) return;
        const result = await ApiService.getPuppyModelSelection(deviceId, vaultOwnerToken);
        if (generation.current !== currentGeneration) return;
        if (result.id !== operation.id) {
          setPending(false);
          setError("The model request changed. Check your machine before trying again.");
          return;
        }
        if (result.status === "applied") {
          const refreshed = await ApiService.getPuppyDirectModels(hushhId, deviceId, vaultOwnerToken);
          setCatalog(refreshed);
          onGlobalModel(catalog.defaultModel, refreshed);
          setPending(false);
          morphyToast.success("Your machine confirmed the new default model.");
          return;
        }
        if (result.status === "refused" || result.status === "expired") {
          setPending(false);
          setError("Your machine did not apply that model. Its current default is unchanged.");
          return;
        }
      }
      // The device may be asleep. Its command remains pending until the server
      // reports an acknowledgement or expiry; never claim a completed switch.
      setError("Still waiting for your machine. Check again when it is awake.");
    } catch {
      setPending(false);
      setError("Couldn’t change the default model. Refresh the list and try again.");
    } finally {
      setApplying(false);
    }
  }

  const selected = chatModel ?? catalog?.defaultModel ?? null;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choose Puppy model"
          disabled={busy || applying || pending || !hushhId || !deviceId || !vaultOwnerToken}
          className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
        >
          <Cpu className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{selected ?? "Local model"}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-2" aria-label="Available local models">
            <p className="px-2 py-1 text-xs font-medium">On this machine</p>
            {loading ? <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Checking installed models…</p> : null}
            {!loading && catalog?.status === "available" ? (
              <div className="max-h-60 overflow-y-auto">
                {catalog.models.map(({ id }) => (
                  <button key={id} type="button" aria-current={selected === id ? "true" : undefined}
                    className="flex min-h-10 w-full items-center rounded-lg px-2 text-left text-xs hover:bg-muted"
                    onClick={() => { setChoice(id); setScope("chat"); setOpen(false); }}>
                    <span className="min-w-0 truncate">{id}</span>
                    {selected === id ? <span className="ml-auto pl-2 text-muted-foreground">Current</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {error ? <p className="px-2 py-2 text-xs text-muted-foreground">{error}</p> : null}
            <button type="button" className="mt-1 min-h-9 px-2 text-xs underline-offset-2 hover:underline" onClick={() => void load()}>Refresh available models</button>
        </PopoverContent>
      </Popover>
      {pending ? (
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" role="status">
          Model change pending
          <button type="button" className="underline underline-offset-2" disabled={loading} onClick={() => void load()}>
            Check status
          </button>
        </span>
      ) : null}
      {!open && error ? <span className="text-xs text-muted-foreground" role="status">{error}</span> : null}
      <Dialog open={Boolean(choice)} onOpenChange={(value) => { if (!value && !applying) setChoice(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Use {choice}?</DialogTitle>
            <DialogDescription>Choose where this local model applies. A running answer keeps its current model.</DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-2" aria-label="Model change scope">
            <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 text-sm">
              <input type="radio" name="puppy-model-scope" checked={scope === "chat"} onChange={() => setScope("chat")} />
              <span><strong>This chat</strong><span className="block text-xs text-muted-foreground">Use it for the next turn in this conversation.</span></span>
            </label>
            <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 text-sm">
              <input type="radio" name="puppy-model-scope" checked={scope === "global"} onChange={() => setScope("global")} />
              <span><strong>Global</strong><span className="block text-xs text-muted-foreground">Set the default for future Puppy chats on this machine.</span></span>
            </label>
          </fieldset>
          {hasTurns && scope === "global" ? <p className="text-xs text-muted-foreground">This chat keeps its current model.</p> : null}
          <DialogFooter>
            <Button variant="muted" disabled={applying} onClick={() => setChoice(null)}>Cancel</Button>
            <Button disabled={applying || pending} onClick={() => void apply()}>{applying ? "Waiting…" : "Confirm change"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
