"use client";

import { useId } from "react";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard, StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { REQUEST_DURATION_OPTIONS } from "@/lib/agent/action-directive-summary";
import type { RequestablePersonScope } from "@/lib/services/person-profile-service";

/** The same editable, human-readable confirmation in Profile and Chat. */
export function InformationRequestReviewFields({
  scopes, purpose, durationHours, onPurposeChange, onDurationChange, disabled = false,
  testIdPrefix = "person-profile",
}: {
  scopes: RequestablePersonScope[];
  purpose: string;
  durationHours: number;
  onPurposeChange: (value: string) => void;
  onDurationChange: (value: number) => void;
  disabled?: boolean;
  testIdPrefix?: string;
}) {
  const hintId = useId();
  const durationName = useId();
  return <div className="consent-presentation-surface space-y-3">
    <SectionCard title="Requested information">
      <div className="space-y-2">
        {scopes.map(scope => <div key={scope.scopeRef} className="flex items-start justify-between gap-3 text-sm" data-testid={`${testIdPrefix}-scope-row-${scope.scopeRef}`}>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="block">{scope.label || "Selected information"}</span>
            {scope.wildcard ? <span data-consent-role="helper" className="block text-xs text-muted-foreground">Includes all available information in this area.</span> : null}
          </span>
          <StatusPill tone="neutral" className="min-w-0 max-w-[45%] text-center [overflow-wrap:anywhere]">{scope.sensitivity || "Standard"}</StatusPill>
        </div>)}
      </div>
    </SectionCard>
    {scopes.length > 50 ? <p data-consent-role="status" role="alert" className="text-sm text-destructive">Choose up to 50 fields for one request.</p> : null}
    <p data-consent-role="body" className="text-sm text-muted-foreground">They&rsquo;ll review your request. If sharing has a price, you&rsquo;ll confirm the exact amount before access. Sending this request won&rsquo;t charge you.</p>
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend data-consent-role="form-label" className="text-sm font-medium">Access duration</legend>
      <div className="grid grid-cols-2 gap-1 rounded-2xl bg-muted/70 p-1 sm:grid-cols-4" data-testid={`${testIdPrefix}-duration-options`}>
        {REQUEST_DURATION_OPTIONS.map(option => (
          <label key={option.hours} className="cursor-pointer rounded-xl has-[:disabled]:cursor-not-allowed">
            <input
              type="radio"
              name={durationName}
              value={option.hours}
              checked={durationHours === option.hours}
              onChange={() => onDurationChange(option.hours)}
              className="peer sr-only"
              data-testid={`${testIdPrefix}-duration-${option.hours}`}
            />
            <span className="ui-text-compact-button-label flex min-h-11 items-center justify-center rounded-xl px-1 text-center text-muted-foreground transition-[background-color,color,box-shadow] peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[-2px] peer-focus-visible:outline-[color:var(--app-accent)] peer-disabled:opacity-50">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
    <label data-consent-role="form-label" className="block space-y-2 text-sm font-medium">
      Purpose
      <Textarea value={purpose} disabled={disabled} onChange={event => onPurposeChange(event.target.value)} maxLength={500} data-consent-input="true"
        placeholder="Why do you need it, and how will you use it?" aria-describedby={hintId}
        data-testid={`${testIdPrefix}-purpose`} />
      <span id={hintId} data-consent-role="helper" className="text-xs font-normal text-muted-foreground">At least 8 characters.</span>
    </label>
  </div>;
}
