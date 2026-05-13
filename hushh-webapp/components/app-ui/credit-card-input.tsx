"use client";

import * as React from "react";
import { CreditCard } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface CreditCardInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  onValueChange?: (rawNumber: string) => void;
}

type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "unknown";

// Extracted utility to prevent recreation on every render
const detectCardBrand = (number: string): CardBrand => {
  if (number.startsWith("4")) return "visa";
  if (/^5[1-5]/.test(number) || /^2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d\d|7(?:[01]\d|20))/.test(number)) return "mastercard";
  if (/^3[47]/.test(number)) return "amex";
  if (/^6(?:011|5)/.test(number)) return "discover";
  return "unknown";
};

const formatCardNumber = (value: string, brand: CardBrand): string => {
  const digits = value.replace(/\D/g, "");
  
  if (brand === "amex") {
    // Amex format: 4-6-5 (e.g., 34xx xxxxxx xxxxx)
    const match = digits.match(/^(\d{0,4})(\d{0,6})(\d{0,5})$/);
    if (match) {
      return !match[2] ? match[1] : `${match[1]} ${match[2]}${match[3] ? ` ${match[3]}` : ""}`;
    }
  } else {
    // Standard format: 4-4-4-4
    const match = digits.match(/^(\d{0,4})(\d{0,4})(\d{0,4})(\d{0,4})$/);
    if (match) {
      return !match[2] ? match[1] : `${match[1]} ${match[2]}${match[3] ? ` ${match[3]}` : ""}${match[4] ? ` ${match[4]}` : ""}`;
    }
  }
  return digits;
};

/**
 * Accessible Credit Card Input
 * Automatically formats PANs (Primary Account Numbers) with correct spacing.
 * Detects card brands dynamically and restricts input to numerics.
 */
export const CreditCardInput = React.forwardRef<HTMLInputElement, CreditCardInputProps>(
  ({ className, onValueChange, value, defaultValue, ...props }, ref) => {
    const [internalValue, setInternalValue] = React.useState((value || defaultValue || "").toString());
    const [brand, setBrand] = React.useState<CardBrand>("unknown");

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const rawValue = e.target.value;
      const stripped = rawValue.replace(/\D/g, "");
      
      const currentBrand = detectCardBrand(stripped);
      setBrand(currentBrand);

      // Enforce max lengths (Amex is 15, others are typically 16)
      const maxLength = currentBrand === "amex" ? 15 : 16;
      const truncated = stripped.slice(0, maxLength);
      
      const formatted = formatCardNumber(truncated, currentBrand);
      
      setInternalValue(formatted);
      if (onValueChange) {
        onValueChange(truncated); // Always pass the raw, unformatted number back to the parent form
      }
    };

    // Brand Label Mapping for Screen Readers
    const brandLabels: Record<CardBrand, string> = {
      visa: "Visa",
      mastercard: "Mastercard",
      amex: "American Express",
      discover: "Discover",
      unknown: "Generic",
    };

    return (
      <div className="relative flex items-center w-full">
        {/* A11y: Screen readers should know what type of card has been detected */}
        <span className="sr-only" aria-live="polite">
          {brand !== "unknown" ? `${brandLabels[brand]} card detected` : ""}
        </span>

        <CreditCard 
          className={cn(
            "absolute left-3 size-5 transition-colors",
            brand !== "unknown" ? "text-primary" : "text-muted-foreground"
          )} 
          aria-hidden="true" 
        />
        
        <input
          ref={ref}
          type="text" // 'text' instead of 'number' prevents the browser's native spinner UI
          inputMode="numeric" // Forces the numeric keypad on iOS/Android
          autoComplete="cc-number"
          value={value !== undefined ? formatCardNumber(value.toString(), detectCardBrand(value.toString())) : internalValue}
          onChange={handleChange}
          placeholder="0000 0000 0000 0000"
          className={cn(
            "flex h-10 w-full rounded-md border border-input bg-transparent py-2 pl-10 pr-3 text-sm shadow-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            "tabular-nums tracking-wide", // tabular-nums prevents horizontal jittering when typing
            className
          )}
          {...props}
        />
      </div>
    );
  }
);

CreditCardInput.displayName = "CreditCardInput";