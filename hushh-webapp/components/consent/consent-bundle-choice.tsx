"use client";

/**
 * The owner's per-item choice on a grouped request (acceptance R5).
 *
 * A request for several items used to be all or nothing: the sheet, the Feed
 * and the Consent Center row could only allow or decline the whole request
 * (localhost run 4, R5). Every requested item is now its own row, all chosen
 * by default. Allow approves only the chosen items and declines the rest,
 * through the same per-item approve and deny calls the whole-request decision
 * already makes; there is no bulk endpoint and none is invented here.
 *
 * This file only draws and splits. It sends nothing.
 */
import { Checkbox } from "@/components/ui/checkbox";
import { joinInformationLabels } from "@/lib/consent/consent-owner-copy";

export type BundleChoiceItem = { key: string; label: string };

/** The chosen items to allow and the rest to decline, in request order. */
export function splitBundleChoice<T>(
  members: readonly T[],
  keyOf: (member: T) => string,
  chosen: ReadonlySet<string>,
): { allow: T[]; decline: T[] } {
  const allow: T[] = [];
  const decline: T[] = [];
  for (const member of members) (chosen.has(keyOf(member)) ? allow : decline).push(member);
  return { allow, decline };
}

/**
 * What an Allow would do, said plainly, only when it is not everything:
 * "Only Food preferences will be shared. Events won't be."
 */
export function bundleChoiceSummary(items: readonly BundleChoiceItem[], chosen: ReadonlySet<string>): string | null {
  const shared = items.filter((item) => chosen.has(item.key)).map((item) => item.label);
  const held = items.filter((item) => !chosen.has(item.key)).map((item) => item.label);
  if (!held.length) return null;
  if (!shared.length) return "Choose at least one item to allow, or use Don't allow.";
  const heldLabel = joinInformationLabels(held);
  return `Only ${joinInformationLabels(shared)} will be shared. ${heldLabel} won't be.`;
}

/** "Allow" for the whole request, "Allow 1 of 2" for part of it. */
export function bundleAllowLabel(total: number, chosen: number): string {
  return chosen >= total ? "Allow" : `Allow ${chosen} of ${total}`;
}

export function ConsentBundleChoice({
  items,
  chosen,
  onToggle,
  disabled = false,
}: {
  items: readonly BundleChoiceItem[];
  chosen: ReadonlySet<string>;
  onToggle: (key: string, include: boolean) => void;
  disabled?: boolean;
}) {
  const count = items.filter((item) => chosen.has(item.key)).length;
  const summary = bundleChoiceSummary(items, chosen);
  return (
    <fieldset className="min-w-0 space-y-1 sm:col-span-2" data-testid="consent-bundle-choice" disabled={disabled}>
      <legend className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
        {count === items.length ? `Access · ${items.length} items` : `Access · ${count} of ${items.length} items`}
      </legend>
      <ul className="divide-y divide-border/50">
        {items.map((item) => {
          const on = chosen.has(item.key);
          const id = `consent-bundle-choice-${item.key}`;
          return (
            <li key={item.key}>
              <label htmlFor={id} data-testid="consent-bundle-choice-row"
                className="flex min-h-11 cursor-pointer items-center gap-3 py-1.5 text-sm leading-5 text-foreground has-[:disabled]:cursor-default">
                <Checkbox id={id} checked={on} disabled={disabled}
                  onCheckedChange={(next) => onToggle(item.key, next === true)} />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.label}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {summary ? (
        <p role="status" aria-live="polite" data-testid="consent-bundle-choice-summary"
          className="pt-1 text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          {summary}
        </p>
      ) : null}
    </fieldset>
  );
}
