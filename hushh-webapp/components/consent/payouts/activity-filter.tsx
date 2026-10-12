"use client";

import { ChevronDown } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { PayoutActivityFilter } from "./activity-card";
import { ACTIVITY_FILTER_LABELS } from "./receipts/activity-copy";

const CARD_FILTERS: readonly PayoutActivityFilter[] = ["all", "earning", "redemption", "deposit", "adjustment"];

function isFilter(value: string): value is PayoutActivityFilter {
  return value in ACTIVITY_FILTER_LABELS;
}

/** "All ▾": which activity to show, and whether to show test activity instead of real. */
export function PayoutActivityFilterMenu({ value, onValueChange, testActivity, onTestActivityChange, includeCoins = false }: {
  value: PayoutActivityFilter;
  onValueChange: (value: PayoutActivityFilter) => void;
  testActivity: boolean;
  onTestActivityChange: (value: boolean) => void;
  /** The coin view (running balance) is offered in View all. */
  includeCoins?: boolean;
}) {
  const filters = includeCoins || value === "coins" ? [...CARD_FILTERS, "coins" as const] : CARD_FILTERS;
  const label = `${ACTIVITY_FILTER_LABELS[value]}${testActivity ? " · Test" : ""}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Show: ${label}`}
          className="profile-account-inline-action inline-flex min-h-11 items-center gap-1 rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {label}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => { if (isFilter(next)) onValueChange(next); }}>
          {filters.map((filter) => (
            <DropdownMenuRadioItem key={filter} value={filter}>{ACTIVITY_FILTER_LABELS[filter]}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={testActivity} onCheckedChange={(checked) => onTestActivityChange(checked === true)}>
          Test activity
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
