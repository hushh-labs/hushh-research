"use client";

import { useId } from "react";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { SegmentedControl } from "@/lib/morphy-ux/ui/segmented-control";
import { REQUEST_DURATION_OPTIONS } from "@/lib/agent/action-directive-summary";
import type { RequestablePersonScope } from "@/lib/services/person-profile-service";
import styles from "./information-request-review-fields.module.css";

const durationOptions = REQUEST_DURATION_OPTIONS.map(option => ({ value: String(option.hours), label: option.label }));

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
  return <div className="consent-presentation-surface space-y-3">
    <section className="space-y-2" aria-label="Requested information">
      <h3 data-consent-role="form-label" className="text-sm font-medium">Requested information</h3>
      <div className="space-y-2">
        {scopes.map(scope => <div key={scope.scopeRef} className="flex items-start justify-between gap-3 text-sm" data-testid={`${testIdPrefix}-scope-row-${scope.scopeRef}`}>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="block">{scope.label || "Selected information"}</span>
            {scope.wildcard ? <span data-consent-role="helper" className="block text-xs text-muted-foreground">Includes all available information in this area.</span> : null}
          </span>
          <StatusPill tone="neutral" className="min-w-0 max-w-[45%] text-center [overflow-wrap:anywhere]">{scope.sensitivity || "Standard"}</StatusPill>
        </div>)}
      </div>
    </section>
    {scopes.length > 50 ? <p data-consent-role="status" role="alert" className="text-sm text-destructive">Choose up to 50 fields for one request.</p> : null}
    <label data-consent-role="form-label" className="block space-y-2 text-sm font-medium">
      Purpose
      <Textarea value={purpose} disabled={disabled} onChange={event => onPurposeChange(event.target.value)} required minLength={8} maxLength={500} rows={2} className="min-h-20" data-consent-input="true"
        placeholder="Why do you need it, and how will you use it?" aria-describedby={hintId}
        data-testid={`${testIdPrefix}-purpose`} />
      <span id={hintId} data-consent-role="helper" className="text-xs font-normal text-muted-foreground">At least 8 characters.</span>
    </label>
    <fieldset disabled={disabled} className="min-w-0 space-y-2" data-testid={`${testIdPrefix}-duration`}>
      <legend data-consent-role="form-label" className="text-sm font-medium">Access duration</legend>
      <SegmentedControl ariaLabel="Access duration" value={String(durationHours)} options={durationOptions}
        onValueChange={value => onDurationChange(Number(value))} disabled={disabled} size="lg" mobileColumns={2} className={styles.duration} />
    </fieldset>
    <p data-consent-role="body" className="text-sm text-muted-foreground">They&rsquo;ll review your request. If sharing has a price, you&rsquo;ll confirm the exact amount before access. Sending this request won&rsquo;t charge you.</p>
  </div>;
}
