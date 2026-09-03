"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Cloud, Cpu, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  assignPuppyModel,
  fetchPuppyModelOptions,
  type PuppyModel,
  type PuppyModelOptions,
} from "@/lib/services/puppy-one-service";
import { cn } from "@/lib/utils";

/**
 * Pick the model and reasoning effort Puppy One answers with.
 *
 * Three behaviours here exist to stop the control from lying about the runtime:
 *
 *   - Hermes writes the assignment to config, which only NEW sessions read. So
 *     applying a model ends the current session rather than leaving the label
 *     and the answering model out of step. The copy says so before the click.
 *   - Cloud providers are shown and labelled, not hidden. Puppy One's whole
 *     claim is that the work stays on this machine, and a picker that quietly
 *     omitted the alternatives could not show what choosing one gives up.
 *   - Only models that EXIST are offered. The route's gateway already drops
 *     unauthenticated providers and deduplicates ids, so none of that is
 *     re-derived here; the list is rendered as given. What is defended below is
 *     rendering itself -- a repeated id must not collide on a React key, and a
 *     provider that arrived carrying no models must not draw an empty heading,
 *     which is the dead row the owner was scrolling past in the first place.
 */

type PickerPayload = PuppyModelOptions;

export interface ModelSelection {
  provider: string;
  model: string;
  onDevice: boolean;
  reasoningEffort: string | null;
}

export function PuppyModelPicker({
  onApplied,
  className,
}: {
  /** Called once the assignment lands, so the caller can start a new session. */
  onApplied: (selection: ModelSelection) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<PickerPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState("");
  const [effort, setEffort] = useState("medium");
  const [confirm, setConfirm] = useState<{
    provider: string;
    model: string;
    message: string;
    onDevice: boolean;
  } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPayload(await fetchPuppyModelOptions());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !payload) void load();
  }, [open, payload, load]);

  const apply = useCallback(
    async (
      provider: string,
      model: string,
      confirmExpensive: boolean,
      /**
       * The GATEWAY's own answer for this provider, as rendered in the row.
       *
       * Not the POST response's `onDevice`: that route has no provider list to
       * look the answer up in and decides from a hardcoded three-name set, so
       * a gateway-reported local provider with any other slug is labelled "on
       * this machine" in the row and then told, in writing, that it runs off
       * it. The label the person read and the sentence the transcript writes
       * now come from one source.
       */
      providerOnDevice: boolean,
    ) => {
      setApplying(`${provider}:${model}`);
      setError("");
      try {
        const result = await assignPuppyModel({
          provider,
          model,
          reasoningEffort: effort,
          confirmExpensive,
        });
        if (result.confirmRequired) {
          // Hermes flags a per-token model as a question, not an error. Ask it
          // rather than answering on the owner's behalf.
          setConfirm({
            provider,
            model,
            onDevice: providerOnDevice,
            message: result.confirmMessage ?? "This model bills per token.",
          });
          return;
        }
        if (!result.ok) {
          setError(result.error ?? "Could not change the model.");
          return;
        }
        setConfirm(null);
        setOpen(false);
        onApplied({
          provider,
          model,
          onDevice: providerOnDevice,
          reasoningEffort: effort,
        });
        setPayload((prior) =>
          prior ? { ...prior, current: { provider, model } } : prior,
        );
      } finally {
        setApplying("");
      }
    },
    [effort, onApplied],
  );

  const current = payload?.current;
  const label = current?.model ? shortModelName(current.model) : "model";
  // A heading with nothing under it is exactly the dead row this change exists
  // to remove, so a provider that arrives with no models is not drawn at all.
  const groups = (payload?.providers ?? []).filter(
    (provider) => Array.isArray(provider.models) && provider.models.length > 0,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground",
            className,
          )}
          title="Choose the model and reasoning effort"
        >
          {label}
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border/60 px-3 py-2">
          <p className="text-xs font-medium">Model</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Applies to your next message. The current session keeps its model.
          </p>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {loading ? (
            <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
              <Loader2 className="mx-auto size-4 animate-spin" aria-hidden />
            </p>
          ) : payload?.reachable === false ? (
            <p className="px-3 py-4 text-[11px] text-muted-foreground">
              Puppy One is not answering on this machine.
            </p>
          ) : groups.length ? (
            groups.map((provider) => (
              <div key={provider.id} className="px-1 py-1">
                <p className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {provider.onDevice ? (
                    <Cpu className="size-3" aria-hidden />
                  ) : (
                    <Cloud className="size-3" aria-hidden />
                  )}
                  {provider.name}
                  <span className="font-normal normal-case tracking-normal">
                    {provider.onDevice ? "on this machine" : "leaves this machine"}
                  </span>
                </p>
                {provider.models.map((model, index) => {
                  const busy = applying === `${provider.id}:${model.id}`;
                  const selected =
                    current?.model === model.id &&
                    current?.provider === provider.id;
                  return (
                    <button
                      // The position is in the key because the id alone is not
                      // guaranteed unique HERE: the gateway deduplicates, and a
                      // payload that did not would otherwise collide on the key
                      // and drop a row. Both entries render; neither throws.
                      key={`${provider.id}:${model.id}:${index}`}
                      type="button"
                      disabled={Boolean(applying)}
                      onClick={() =>
                        void apply(
                          provider.id,
                          model.id,
                          false,
                          provider.onDevice,
                        )
                      }
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        "hover:bg-muted disabled:opacity-60",
                        selected && "bg-muted",
                      )}
                    >
                      {busy ? (
                        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
                      ) : selected ? (
                        <Check className="size-3 shrink-0" aria-hidden />
                      ) : (
                        <span className="size-3 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {shortModelName(model.id)}
                      </span>
                      <ModelBuild model={model} />
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <p className="px-3 py-4 text-[11px] text-muted-foreground">
              No models are configured yet.
            </p>
          )}
        </div>

        <div className="border-t border-border/60 px-3 py-2">
          <label
            className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor="puppy-reasoning-effort"
          >
            Reasoning
          </label>
          <div className="mt-1 flex flex-wrap gap-1" id="puppy-reasoning-effort">
            {(payload?.reasoningEfforts ?? ["none", "low", "medium", "high"]).map(
              (option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setEffort(option)}
                  aria-pressed={effort === option}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                    effort === option
                      ? "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option}
                </button>
              ),
            )}
          </div>
        </div>

        {confirm ? (
          <div className="border-t border-border/60 bg-muted/40 px-3 py-2">
            <p className="text-[11px] text-foreground">{confirm.message}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                className="h-7 text-[11px]"
                onClick={() =>
                  void apply(
                    confirm.provider,
                    confirm.model,
                    true,
                    confirm.onDevice,
                  )
                }
              >
                Use it anyway
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px]"
                onClick={() => setConfirm(null)}
              >
                Keep current
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="border-t border-border/60 px-3 py-2 text-[11px] text-destructive">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * What this model actually is, at the right edge of its row.
 *
 * The variant is the answer to the owner's question -- MLX and GGUF are two
 * different runtimes for the same weights, and which one a row is decides
 * whether it runs well on this machine -- so it is the only part styled as a
 * chip. Quantization sits beside it as plain text and the loaded dot is a dot,
 * because three chips on one 320px row would make the model name, the thing
 * being chosen, the least legible part of it.
 *
 * Each part renders only when the gateway reported it. A null variant means
 * unknown, not an error, and unknown renders nothing: no chip, no placeholder,
 * no guess.
 */
function ModelBuild({ model }: { model: PuppyModel }) {
  // Only the loaded state earns a mark. "not-loaded" is the ordinary case and
  // needs no ink, and a state this build does not recognise is not mapped onto
  // either one.
  const loaded = model.state === "loaded";
  if (!model.variant && !model.quantization && !loaded) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {model.variant ? (
        <span className="rounded-sm border border-border/70 px-1 py-px text-[9px] font-medium uppercase leading-[1.4] tracking-wide text-muted-foreground">
          {model.variant}
        </span>
      ) : null}
      {model.quantization ? (
        <span className="text-[10px] leading-none text-muted-foreground">
          {model.quantization}
        </span>
      ) : null}
      {loaded ? (
        <span className="flex items-center" title="Already loaded in memory">
          <span
            className="size-1.5 rounded-full bg-[color:var(--app-accent-deep)]"
            aria-hidden
          />
          <span className="sr-only">already loaded in memory</span>
        </span>
      ) : null}
    </span>
  );
}

/** Drop the vendor prefix; the provider row above already carries it. */
function shortModelName(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}
