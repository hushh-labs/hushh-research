"use client";

import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown, FilePenLine, X, Loader2 } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

// =============================================================================
// GLOBAL STYLING TOKENS
// =============================================================================

const FIELD_TRIGGER_CLASSNAME =
  "flex min-h-10 w-full items-center justify-between gap-3 rounded-[16px] border px-3 py-2 text-left text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/70";

const COMMAND_ITEM_CLASSNAME =
  "rounded-[18px] border border-transparent px-3 py-3 transition-colors duration-300 hover:bg-primary/10 hover:text-foreground aria-selected:border-primary/25 aria-selected:bg-primary/15 aria-selected:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45";

const COMMAND_SHELL_CLASSNAME =
  "chrome-glass-surface top-[calc(var(--top-shell-reserved-height,0px)+0.75rem)] max-h-[min(70dvh,32rem)] w-[calc(100%-1rem)] translate-y-0 rounded-[28px] border border-white/55 p-0 shadow-2xl sm:top-1/2 sm:w-full sm:max-w-[52rem] sm:max-h-[min(76dvh,38rem)] sm:-translate-y-1/2 lg:max-w-[58rem] dark:border-white/12";

// =============================================================================
// UTILITY SCHEMAS & DATA ENGINES
// =============================================================================

export type CommandPickerOption<T = unknown> = {
  value: string;
  label: string;
  description?: string;
  supportingLabel?: string;
  keywords?: string[];
  data?: T;
};

function buildHaystack<T>(option: CommandPickerOption<T>): string {
  return [
    option.value,
    option.label,
    option.description,
    option.supportingLabel,
    ...(option.keywords || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterCommandOptions<T>(options: CommandPickerOption<T>[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => buildHaystack(option).includes(normalizedQuery));
}

/**
 * Feature: Highlight matching characters inside picker elements
 */
function HighlightedText({ text, match }: { text: string; match: string }) {
  if (!match.trim() || !text) return <span className="truncate">{text}</span>;
  
  const regex = new RegExp(`(${match.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")})`, "gi");
  const segments = text.split(regex);

  return (
    <span className="truncate">
      {segments.map((segment, index) => 
        regex.test(segment) ? (
          <mark key={index} className="bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 rounded-sm px-0.5 font-semibold">
            {segment}
          </mark>
        ) : (
          segment
        )
      )}
    </span>
  );
}

// =============================================================================
// 1. COMMAND PICKER FIELD COMPONENT
// =============================================================================

export function CommandPickerField<T = unknown>({
  title,
  description,
  value,
  placeholder,
  options = [],
  loadOptions,
  onSelect,
  searchPlaceholder = "Search options",
  emptyText = "No matches yet.",
  invalid = false,
  allowClear = false,
  displayValue,
  renderOption,
  triggerClassName,
  maxRenderItems = 80, // Virtual chunk threshold feature prevents sub-list freezing
}: {
  title: ReactNode;
  description?: ReactNode;
  value: string;
  placeholder: string;
  options?: CommandPickerOption<T>[];
  loadOptions?: (query: string) => Promise<CommandPickerOption<T>[]>;
  onSelect: (option: CommandPickerOption<T> | null) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  invalid?: boolean;
  allowClear?: boolean;
  displayValue?: string;
  renderOption?: (option: CommandPickerOption<T>, selected: boolean) => ReactNode;
  triggerClassName?: string;
  maxRenderItems?: number;
}) {
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
        if (!abortController.signal.aborted) {
          setDynamicOptions(nextOptions);
        }
      } catch (error) {
        console.error("Failed to load options:", error);
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void fetchOptions();

    return () => {
      abortController.abort();
    };
  }, [deferredQuery, loadOptions, open]);

  const resolvedOptions = useMemo(() => {
    const list = loadOptions ? dynamicOptions : filterCommandOptions(options, deferredQuery);
    return list.slice(0, maxRenderItems); // Paginate view allocations smoothly
  }, [deferredQuery, dynamicOptions, loadOptions, options, maxRenderItems]);

  const selectedOption = useMemo(() => {
    const normalizedValue = value.trim().toLowerCase();
    const allOptions = loadOptions ? dynamicOptions : options;
    return allOptions.find((option) => option.value.trim().toLowerCase() === normalizedValue) || null;
  }, [dynamicOptions, loadOptions, options, value]);

  const triggerValue = displayValue || selectedOption?.label || value;

  return (
    <>
      <div className="flex items-center gap-2 w-full">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
          className={cn(
            FIELD_TRIGGER_CLASSNAME,
            invalid ? "border-rose-300 dark:border-rose-500/50" : "border-border/80 bg-background",
            triggerValue ? "text-foreground" : "text-muted-foreground",
            triggerClassName
          )}
        >
          <span className="truncate font-medium tracking-tight">{triggerValue || placeholder}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground/80" aria-hidden="true" />
        </button>
        {allowClear && value ? (
          <Button
            variant="none"
            effect="fade"
            size="sm"
            onClick={() => onSelect(null)}
            className="h-10 rounded-[14px] px-3"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <CommandDialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery("");
        }}
        title={typeof title === "string" ? title : "Select option"}
        description={typeof description === "string" ? description : "Search and select an option."}
        className={COMMAND_SHELL_CLASSNAME}
      >
        <div className="relative flex items-center border-b border-border/40">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
            className="text-sm sm:text-[15px] flex-1"
          />
          {loading && (
            <Loader2 className="absolute right-4 h-4 w-4 animate-spin text-muted-foreground/70" />
          )}
        </div>
        
        <CommandList className="max-h-[min(56dvh,24rem)] p-2 sm:max-h-[min(62dvh,30rem)] sm:p-3">
          <CommandEmpty className="px-3 py-6 text-sm text-center text-muted-foreground">
            {loading ? (
              <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Gathering parameters...</span>
            ) : (
              emptyText
            )}
          </CommandEmpty>
          
          <CommandGroup heading={query.trim() ? "Matches" : "Options"}>
            {resolvedOptions.map((option) => {
              const selected = option.value === value;
              return (
                <CommandItem
                  key={option.value}
                  value={buildHaystack(option)}
                  onSelect={() => {
                    onSelect(option);
                    setOpen(false);
                  }}
                  className={COMMAND_ITEM_CLASSNAME}
                  aria-selected={selected}
                >
                  {renderOption ? (
                    renderOption(option, selected)
                  ) : (
                    <>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="truncate font-medium text-foreground">
                          <HighlightedText text={option.label} match={deferredQuery} />
                        </p>
                        {option.description ? (
                          <p className="truncate text-xs text-muted-foreground/90">
                            <HighlightedText text={option.description} match={deferredQuery} />
                          </p>
                        ) : null}
                      </div>
                      {selected && <Check className="h-4 w-4 text-primary shrink-0 ml-2" aria-hidden="true" />}
                    </>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

// =============================================================================
// 2. POPUP TEXT EDITOR FIELD COMPONENT
// =============================================================================

export function PopupTextEditorField({
  title,
  description,
  value,
  placeholder,
  onSave,
  invalid = false,
  previewPlaceholder,
  saveLabel = "Apply",
  triggerClassName,
  previewClassName,
  textareaClassName,
  maxLength = 1000, // Feature: Enforced max-length constraints
}: {
  title: ReactNode;
  description?: ReactNode;
  value: string;
  placeholder: string;
  onSave: (value: string) => void;
  invalid?: boolean;
  previewPlaceholder?: string;
  saveLabel?: string;
  triggerClassName?: string;
  previewClassName?: string;
  textareaClassName?: string;
  maxLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) {
      setDraft(value);
    }
  }, [open, value]);

  const preview = value.trim();
  const isOverLimit = draft.length > maxLength;

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn(
          "group flex min-h-[76px] w-full items-start justify-between gap-3 rounded-[16px] border px-3 py-3 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-ring/70",
          invalid ? "border-rose-300 dark:border-rose-500/50" : "border-border/80 bg-background hover:border-border",
          triggerClassName
        )}
      >
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "line-clamp-3 text-sm leading-5",
              preview ? "text-foreground" : "text-muted-foreground",
              previewClassName
            )}
          >
            {preview || previewPlaceholder || placeholder}
          </p>
        </div>
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/70 text-muted-foreground transition group-hover:bg-muted" aria-hidden="true">
          <FilePenLine className="h-4 w-4" />
        </span>
      </button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setDraft(value);
        }}
        modal
      >
        <DialogContent className={cn(COMMAND_SHELL_CLASSNAME, "bg-[rgba(245,245,247,0.92)] backdrop-blur-xl dark:bg-[rgba(29,29,31,0.92)]")}>
          <DialogHeader className="border-b border-black/10 px-5 py-4 dark:border-white/10">
            <DialogTitle className="text-base font-semibold tracking-tight">{title}</DialogTitle>
            {description ? (
              <DialogDescription className="text-sm leading-6">{description}</DialogDescription>
            ) : null}
          </DialogHeader>

          <div className="overflow-y-auto px-4 py-4 sm:px-5 space-y-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={placeholder}
              className={cn(
                "min-h-[220px] resize-none rounded-[22px] border-border/80 bg-background/90 px-4 py-3 text-sm leading-6 sm:min-h-[260px] transition-colors focus-visible:ring-1",
                isOverLimit || invalid ? "border-rose-400 focus-visible:ring-rose-400" : "",
                textareaClassName
              )}
            />
            {/* Real-time metrics visualization footer banner */}
            <div className="flex items-center justify-end px-1 text-xs">
              <span className={cn("font-medium", isOverLimit ? "text-rose-500 font-semibold" : "text-muted-foreground/80")}>
                {draft.length} / {maxLength} characters
              </span>
            </div>
          </div>

          <DialogFooter className="border-t border-black/10 px-5 py-4 dark:border-white/10">
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => {
                setOpen(false);
                setDraft(value);
              }}
              className="w-full justify-center sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              variant="blue-gradient"
              effect="fill"
              size="sm"
              disabled={isOverLimit}
              onClick={() => {
                onSave(draft);
                setOpen(false);
              }}
              className="w-full justify-center sm:w-auto data-[disabled=true]:opacity-50"
            >
              {saveLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}