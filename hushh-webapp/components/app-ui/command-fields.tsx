"use client";

import { useDeferredValue, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown, FilePenLine, X } from "lucide-react";

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

// 1. Defined standard class names at the top for better maintainability
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

// 2. Extracted the haystack generator logic outside the filter to avoid recreating the array in memory
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

// 3. Removed PopupEditorPanel as an internal component and moved it directly into PopupTextEditorField to avoid unnecessary prop drilling and re-renders.

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
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dynamicOptions, setDynamicOptions] = useState<CommandPickerOption<T>[]>([]);
  const [loading, setLoading] = useState(false);
  const deferredQuery = useDeferredValue(query);

  // 4. Fixed race conditions in loadOptions by utilizing an AbortController pattern (cleaner than manual `cancelled` boolean)
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
    if (loadOptions) return dynamicOptions;
    return filterCommandOptions(options, deferredQuery);
  }, [deferredQuery, dynamicOptions, loadOptions, options]);

  const selectedOption = useMemo(() => {
    const normalizedValue = value.trim().toLowerCase();
    // 5. Consolidated the search array to prevent redundant loops
    const allOptions = loadOptions ? dynamicOptions : options;
    return allOptions.find((option) => option.value.trim().toLowerCase() === normalizedValue) || null;
  }, [dynamicOptions, loadOptions, options, value]);

  const triggerValue = displayValue || selectedOption?.label || value;

  return (
    <>
      <div className="flex items-center gap-2">
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
            invalid ? "border-rose-300 dark:border-rose-500/50" : "border-border/80",
            triggerValue ? "bg-background text-foreground" : "bg-background text-muted-foreground",
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
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={searchPlaceholder}
          className="text-sm sm:text-[15px]"
        />
        <CommandList className="max-h-[min(56dvh,24rem)] p-2 sm:max-h-[min(62dvh,30rem)] sm:p-3">
          <CommandEmpty className="px-3 py-6 text-sm text-muted-foreground">
            {loading ? "Loading..." : emptyText}
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
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="truncate font-medium text-foreground">{option.label}</p>
                        {option.description ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {option.description}
                          </p>
                        ) : null}
                      </div>
                      {selected ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
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
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaId = useId();

  useEffect(() => {
    if (open) {
      setDraft(value); // Only sync draft when opening the dialog to avoid overriding user edits
    }
  }, [open, value]);

  const preview = value.trim();

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
          if (!nextOpen) setDraft(value); // Revert draft on explicit cancel/close
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

          <div className="overflow-y-auto px-4 py-4 sm:px-5">
            <label htmlFor={textareaId} className="sr-only">
              {typeof title === "string" ? title : placeholder}
            </label>

            <Textarea
              id={textareaId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={placeholder}
              className={cn(
                "min-h-[220px] resize-none rounded-[22px] border-border/80 bg-background/90 px-4 py-3 text-sm leading-6 sm:min-h-[260px]",
                invalid ? "border-rose-300 dark:border-rose-500/50" : "",
                textareaClassName
              )}
            />
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
              onClick={() => {
                onSave(draft);
                setOpen(false);
              }}
              className="w-full justify-center sm:w-auto"
            >
              {saveLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}