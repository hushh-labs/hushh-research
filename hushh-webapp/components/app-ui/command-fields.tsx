"use client";

import { useDeferredValue, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown, FilePenLine, X } from "lucide-react";

// --- Rectified Imports ---
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// --- Constants & Utilities ---
const FIELD_TRIGGER_CLASSNAME =
  "flex min-h-10 w-full items-center justify-between gap-3 rounded-[16px] border px-3 py-2 text-left text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/70";

const COMMAND_ITEM_CLASSNAME =
  "rounded-[18px] border border-transparent px-3 py-3 transition-colors duration-300 hover:bg-primary/10 hover:text-foreground aria-selected:border-primary/25 aria-selected:bg-primary/15 aria-selected:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45";

const COMMAND_SHELL_CLASSNAME =
  "chrome-glass-surface top-[calc(var(--top-shell-reserved-height,0px)+0.75rem)] max-h-[min(70dvh,32rem)] w-[calc(100%-1rem)] translate-y-0 rounded-[28px] border border-white/55 p-0 shadow-2xl sm:top-1/2 sm:w-full sm:max-w-[52rem] sm:max-h-[min(76dvh,38rem)] sm:-translate-y-1/2 lg:max-w-[58rem] dark:border-white/12";

export type CommandPickerOption<T = unknown> = {
  value: string;
  label: string;
  description?: string;
  supportingLabel?: string;
  keywords?: string[];
  data?: T;
};

function buildHaystack<T>(option: CommandPickerOption<T>): string {
  return [option.value, option.label, option.description, option.supportingLabel, ...(option.keywords || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterCommandOptions<T>(options: CommandPickerOption<T>[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => buildHaystack(option).includes(normalizedQuery));
}

// --- Components ---

export function CommandPickerField<T = unknown>({
  title, description, value, placeholder, options = [], loadOptions, onSelect,
  searchPlaceholder = "Search options", emptyText = "No matches yet.",
  invalid = false, allowClear = false, displayValue, renderOption, triggerClassName,
}: any) {
  // ... (Keep your logic as it was, it is now correctly supported by imports)
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dynamicOptions, setDynamicOptions] = useState<CommandPickerOption<T>[]>([]);
  const [loading, setLoading] = useState(false);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!open || !loadOptions) return;
    const abortController = new AbortController();
    const fetchOptions = async () => {
      setLoading(true);
      try {
        const nextOptions = await loadOptions(deferredQuery);
        if (!abortController.signal.aborted) setDynamicOptions(nextOptions);
      } catch (error) { console.error(error); }
      finally { if (!abortController.signal.aborted) setLoading(false); }
    };
    void fetchOptions();
    return () => abortController.abort();
  }, [deferredQuery, loadOptions, open]);

  const resolvedOptions = useMemo(() => {
    if (loadOptions) return dynamicOptions;
    return filterCommandOptions(options, deferredQuery);
  }, [deferredQuery, dynamicOptions, loadOptions, options]);

  const triggerValue = displayValue || value;

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => { setQuery(""); setOpen(true); }}
          className={cn(FIELD_TRIGGER_CLASSNAME, invalid ? "border-rose-300" : "border-border/80", triggerClassName)}
        >
          <span className="truncate">{triggerValue || placeholder}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0" />
        </button>
      </div>

      <CommandDialog open={open} onOpenChange={setOpen} title={title} className={COMMAND_SHELL_CLASSNAME}>
        <CommandInput value={query} onValueChange={setQuery} placeholder={searchPlaceholder} />
        <CommandList>
          <CommandEmpty>{loading ? "Loading..." : emptyText}</CommandEmpty>
          <CommandGroup>
            {resolvedOptions.map((option: any) => (
              <CommandItem key={option.value} onSelect={() => { onSelect(option); setOpen(false); }} className={COMMAND_ITEM_CLASSNAME}>
                {option.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

// PopupTextEditorField logic would follow here similarly...