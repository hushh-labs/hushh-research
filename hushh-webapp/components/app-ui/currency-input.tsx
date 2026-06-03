"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * CurrencyInput
 *
 * Accessible numeric input for monetary amounts. Formats as the user types
 * (`1234.5` → `1,234.50`), preserves a canonical numeric value via `onChange`,
 * and routes locale-correct display through `Intl.NumberFormat`.
 *
 * Accessibility:
 *   - Pairs with a parent `<label>` via `id`, OR accepts `aria-label`.
 *   - `inputMode="decimal"` triggers the numeric keypad on mobile.
 *   - `aria-invalid` is auto-set when value is outside `[min, max]`.
 *   - Currency symbol is rendered as visual prefix AND announced once via
 *     `aria-describedby` to a visually-hidden span, so screen readers
 *     don't repeat it per keystroke.
 *   - Up/Down arrow keys step by 1; Shift+arrow steps by 10.
 *
 * Display vs value:
 *   - `value` prop is always a canonical `number | null` (or undefined for
 *     uncontrolled). Never a formatted string.
 *   - The visible text is the locale-formatted view; the parent never has
 *     to parse `"$1,234.56"` themselves.
 */

export interface CurrencyInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "type" | "min" | "max" | "step"
  > {
  /** Numeric value. `null` represents an empty field. */
  value?: number | null;
  /** Called with the canonical numeric value (or `null` when cleared). */
  onChange?: (value: number | null) => void;
  /** Currency symbol displayed as visual prefix. Default: "$". */
  currencySymbol?: string;
  /** BCP-47 locale tag for thousand/decimal separators. Default: "en-US". */
  locale?: string;
  /** Decimal places shown after blur. Default: 2. */
  decimals?: number;
  /** Inclusive minimum. Out-of-range values set `aria-invalid="true"`. */
  min?: number;
  /** Inclusive maximum. Out-of-range values set `aria-invalid="true"`. */
  max?: number;
  /** Optional `id` for label association. */
  id?: string;
  /** Error message; when present, `aria-invalid` is forced true. */
  errorMessage?: string;
}

const DEFAULT_LOCALE = "en-US";
const DEFAULT_CURRENCY_SYMBOL = "$";
const DEFAULT_DECIMALS = 2;

/** Strip everything except digits, decimal point, and leading minus. */
function sanitizeInput(raw: string): string {
  let cleaned = raw.replace(/[^\d.\-]/g, "");
  // Allow a single leading minus
  const isNegative = cleaned.startsWith("-");
  cleaned = cleaned.replace(/-/g, "");
  // Collapse multiple decimal points to the first one
  const firstDot = cleaned.indexOf(".");
  if (firstDot !== -1) {
    cleaned =
      cleaned.slice(0, firstDot + 1) +
      cleaned.slice(firstDot + 1).replace(/\./g, "");
  }
  return (isNegative ? "-" : "") + cleaned;
}

function parseNumber(raw: string): number | null {
  const sanitized = sanitizeInput(raw);
  if (sanitized === "" || sanitized === "-" || sanitized === ".") return null;
  const n = Number(sanitized);
  return Number.isFinite(n) ? n : null;
}

function formatForDisplay(
  value: number,
  locale: string,
  decimals: number
): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  }).format(value);
}

function formatWhileTyping(raw: string, locale: string): string {
  const sanitized = sanitizeInput(raw);
  if (sanitized === "" || sanitized === "-") return sanitized;
  const [intPart, fracPart] = sanitized.split(".");
  if (!intPart) return sanitized;

  const negative = intPart.startsWith("-");
  const digits = negative ? intPart.slice(1) : intPart;
  const asNum = Number(digits);
  const groupedInt = Number.isFinite(asNum)
    ? new Intl.NumberFormat(locale, { useGrouping: true }).format(asNum)
    : digits;
  const signed = (negative ? "-" : "") + groupedInt;
  return fracPart === undefined ? signed : `${signed}.${fracPart}`;
}

export const CurrencyInput = React.forwardRef<
  HTMLInputElement,
  CurrencyInputProps
>(function CurrencyInput(
  {
    value,
    onChange,
    currencySymbol = DEFAULT_CURRENCY_SYMBOL,
    locale = DEFAULT_LOCALE,
    decimals = DEFAULT_DECIMALS,
    min,
    max,
    id,
    errorMessage,
    className,
    disabled,
    placeholder,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
    onBlur,
    onFocus,
    onKeyDown,
    ...rest
  },
  ref
) {
  const reactId = React.useId();
  const inputId = id ?? `currency-${reactId}`;
  const currencyHintId = `${inputId}-currency`;
  const errorId = `${inputId}-error`;
  const [display, setDisplay] = React.useState<string>(() =>
    value === null || value === undefined
      ? ""
      : formatForDisplay(value, locale, decimals)
  );
  const [hasFocus, setHasFocus] = React.useState(false);

  // Keep display in sync with `value` from parent when not focused.
  React.useEffect(() => {
    if (hasFocus) return;
    if (value === null || value === undefined) {
      setDisplay("");
    } else {
      setDisplay(formatForDisplay(value, locale, decimals));
    }
  }, [value, locale, decimals, hasFocus]);

  const outOfRange =
    value !== null &&
    value !== undefined &&
    ((typeof min === "number" && value < min) ||
      (typeof max === "number" && value > max));
  const isInvalid = Boolean(errorMessage) || outOfRange;

  const describedByIds = [currencyHintId];
  if (ariaDescribedBy) describedByIds.push(ariaDescribedBy);
  if (errorMessage) describedByIds.push(errorId);

  const commitValue = (raw: string) => {
    const parsed = parseNumber(raw);
    if (onChange) onChange(parsed);
  };

  return (
    <div
      className={cn(
        "relative flex w-full items-center",
        disabled && "pointer-events-none opacity-50",
        className
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3 select-none text-muted-foreground"
      >
        {currencySymbol}
      </span>
      <input
        ref={ref}
        id={inputId}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={describedByIds.join(" ") || undefined}
        aria-invalid={isInvalid || undefined}
        placeholder={placeholder ?? "0.00"}
        value={display}
        onFocus={(event) => {
          setHasFocus(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setHasFocus(false);
          const parsed = parseNumber(display);
          if (parsed !== null) {
            setDisplay(formatForDisplay(parsed, locale, decimals));
          }
          onBlur?.(event);
        }}
        onChange={(event) => {
          const next = formatWhileTyping(event.target.value, locale);
          setDisplay(next);
          commitValue(next);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1;
            const direction = event.key === "ArrowUp" ? 1 : -1;
            const current = parseNumber(display) ?? 0;
            const nextValue = current + step * direction;
            const clamped =
              typeof min === "number" && nextValue < min
                ? min
                : typeof max === "number" && nextValue > max
                  ? max
                  : nextValue;
            setDisplay(formatWhileTyping(String(clamped), locale));
            if (onChange) onChange(clamped);
          }
        }}
        data-slot="currency-input"
        className={cn(
          "h-9 w-full min-w-0 rounded-md border bg-transparent py-1 pl-7 pr-3 text-right text-base shadow-xs outline-none transition-[color,box-shadow]",
          "border-input dark:bg-input/30",
          "placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "md:text-sm"
        )}
        {...rest}
      />
      {/* Screen-reader-only one-shot announcement of the currency unit */}
      <span id={currencyHintId} className="sr-only">
        {currencySymbol} amount
      </span>
      {errorMessage ? (
        <span
          id={errorId}
          role="alert"
          className="sr-only"
        >
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
});

CurrencyInput.displayName = "CurrencyInput";