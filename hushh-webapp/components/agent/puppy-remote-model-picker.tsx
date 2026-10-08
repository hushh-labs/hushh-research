"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Laptop, Loader2 } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/lib/morphy-ux/morphy";
import { usePuppyCatalog, type PuppyCatalog } from "@/lib/agent/use-puppy-catalog";
import { cn } from "@/lib/utils";

type Scope = "chat" | "global";
export type PuppyMachineState = "live" | "quiet" | "unavailable";

const STATE_DOT: Record<PuppyMachineState, string> = {
  live: "bg-[color:var(--app-success)]",
  quiet: "bg-[color:var(--app-warning)]",
  unavailable: "bg-muted-foreground/40",
};

function stateSentence(state: PuppyMachineState, machine: string): string {
  const Machine = machine.charAt(0).toUpperCase() + machine.slice(1);
  if (state === "live") return `${Machine} is ready.`;
  if (state === "quiet") return `${Machine} is resting. It wakes up when you send a message.`;
  return `${Machine} isn't reachable right now. Open Puppy on it to reconnect.`;
}

/** Use a model for this chat, or make it the machine's default. */
function ModelScopeDialog({ choice, hasTurns, pending, onCancel, onConfirm }: {
  choice: string | null;
  hasTurns: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (scope: Scope) => void;
}) {
  const [scope, setScope] = useState<Scope>("chat");
  useEffect(() => { if (choice) setScope("chat"); }, [choice]);
  return (
    <Dialog open={Boolean(choice)} onOpenChange={(value) => { if (!value) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Use {choice}?</DialogTitle>
          <DialogDescription>Pick where this model applies. An answer already running keeps its model.</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2" aria-label="Model change scope">
          {([["chat", "This chat", "Use it for the next message here."], ["global", "Every new chat", "Make it the default on this machine."]] as const).map(([value, title, detail]) => (
            <label key={value} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 text-sm">
              <input type="radio" name="puppy-model-scope" checked={scope === value} onChange={() => setScope(value)} />
              <span><strong>{title}</strong><span className="block text-xs text-muted-foreground">{detail}</span></span>
            </label>
          ))}
        </fieldset>
        {hasTurns && scope === "global" ? <p className="text-xs text-muted-foreground">This chat keeps its current model.</p> : null}
        <DialogFooter>
          <Button variant="muted" onClick={onCancel}>Cancel</Button>
          <Button disabled={pending} onClick={() => onConfirm(scope)}>Use this model</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The model list, which keeps showing the last list it had while it checks again. */
function ModelList({ catalog, selected, loading, locked, machine, onPick }: {
  catalog: PuppyCatalog | null;
  selected: string | null;
  loading: boolean;
  /** An answer is running; its model is fixed until it ends. */
  locked: boolean;
  machine: string;
  onPick: (model: string) => void;
}) {
  if (!catalog?.models.length) {
    return loading ? (
      <p className="flex min-h-10 items-center gap-2 px-2 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />Checking the models on {machine}…
      </p>
    ) : null;
  }
  return (
    <div className="max-h-60 overflow-y-auto" aria-busy={loading || undefined}>
      {locked ? <p className="px-2 pb-1 text-xs text-muted-foreground">You can switch models after this answer.</p> : null}
      {catalog.models.map(({ id }) => (
        <button key={id} type="button" aria-current={selected === id ? "true" : undefined} disabled={locked}
          className="flex min-h-10 w-full items-center gap-2 rounded-xl px-2 text-left text-sm hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
          onClick={() => onPick(id)}>
          <span className="min-w-0 flex-1 truncate">{id}</span>
          {selected === id ? <Check className="size-4 shrink-0 text-[color:var(--app-accent)]" aria-label="Current" /> : null}
        </button>
      ))}
    </div>
  );
}

/** The linked machine's models, with the read's own plain-words status and retry. */
function ModelSection({ error, onRetry, ...list }: Parameters<typeof ModelList>[0] & {
  error: string;
  onRetry: () => void;
}) {
  return (
    <>
      <div className="flex min-h-8 items-center justify-between px-2">
        <p className="text-xs font-medium">Models on {list.machine}</p>
        {list.loading && list.catalog?.models.length ? <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Checking for changes" /> : null}
      </div>
      <ModelList {...list} />
      {error ? <p className="px-2 py-2 text-xs leading-5 text-muted-foreground" role="status">{error}</p> : null}
      {error && !list.loading ? (
        <button type="button" className="min-h-8 px-2 text-xs font-medium text-[color:var(--app-accent)]" onClick={onRetry}>Try again</button>
      ) : null}
    </>
  );
}

/**
 * The Puppy header chip: which machine, whether it is ready, and which local
 * model answers. Opening it shows the machine's reported local models (never a
 * cloud model) and any chat details passed as `footer`.
 */
export function PuppyRemoteModelPicker({
  hushhId, deviceId, vaultOwnerToken, chatModel, busy, hasTurns, onChatModel, onGlobalModel,
  machineState = "unavailable", machine = "your computer", lastKnownModel = null, footer, memoryPhrase, onOpenChange,
}: {
  hushhId: string | null;
  deviceId: string | null;
  vaultOwnerToken: string | null;
  chatModel: string | null;
  busy: boolean;
  hasTurns: boolean;
  onChatModel: (model: string, catalogVersion: string) => void;
  onGlobalModel: (previousDefault: string, catalog: PuppyCatalog) => void;
  machineState?: PuppyMachineState;
  machine?: string;
  /** The model the machine last reported running, shown until a list arrives. */
  lastKnownModel?: string | null;
  footer?: ReactNode;
  /** The provider memory grant in words, read into the chip's accessible name. */
  memoryPhrase?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  const [choice, setChoice] = useState<string | null>(null);
  const choiceAfterClose = useRef<string | null>(null);
  const { catalog, loading, error, pending, load, applyGlobal } = usePuppyCatalog({ hushhId, deviceId, vaultOwnerToken, machine });

  useEffect(() => { if (open) void load(); }, [open, load]);

  function confirm(scope: Scope) {
    const model = choice;
    setChoice(null);
    if (!model || !catalog || !catalog.models.some(({ id }) => id === model)) return;
    if (scope === "chat") onChatModel(model, catalog.catalogVersion);
    else void applyGlobal(model, onGlobalModel);
  }

  const selected = chatModel ?? catalog?.defaultModel ?? lastKnownModel;
  const Machine = machine.charAt(0).toUpperCase() + machine.slice(1);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {/* Enabled whenever the agent is known: the memory grant inside is the
            agent's, so it must stay reachable mid-answer and with no device. */}
        <PopoverTrigger asChild>
          <button type="button" aria-label={["Choose Puppy model", memoryPhrase].filter(Boolean).join(". ")}
            title={memoryPhrase} data-testid="puppy-header-chip" disabled={!hushhId}
            className="inline-flex min-h-8 max-w-full items-center gap-2 rounded-full bg-foreground/[0.04] px-3 text-xs text-foreground transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
            <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[machineState])} aria-hidden />
            <span className="shrink-0 font-medium">{Machine}</span>
            {selected ? <span className="min-w-0 truncate text-muted-foreground">{selected}</span> : null}
            {pending ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-label="Model change pending" /> : null}
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-2" aria-label="Available local models"
          onCloseAutoFocus={(event) => {
            const picked = choiceAfterClose.current;
            if (!picked) return;
            event.preventDefault();
            choiceAfterClose.current = null;
            setChoice(picked);
          }}>
          <div className="flex items-start gap-2 px-2 pb-2 pt-1">
            <Laptop className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-xs leading-5 text-muted-foreground">{stateSentence(machineState, machine)}</p>
          </div>
          {deviceId && vaultOwnerToken ? (
            <ModelSection catalog={catalog} selected={selected} loading={loading} locked={busy} machine={machine}
              error={error} onRetry={() => void load()}
              onPick={(id) => { choiceAfterClose.current = id; setOpen(false); }} />
          ) : null}
          {footer ? <div className="mt-2 border-t border-border/60 pt-2">{footer}</div> : null}
        </PopoverContent>
      </Popover>
      <ModelScopeDialog choice={choice} hasTurns={hasTurns} pending={pending}
        onCancel={() => setChoice(null)} onConfirm={confirm} />
    </>
  );
}
