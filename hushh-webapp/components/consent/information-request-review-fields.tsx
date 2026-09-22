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
  return <div className="space-y-3">
    <SectionCard title="What you are asking for">
      <div className="space-y-2">
        {scopes.map(scope => <div key={scope.scopeRef} className="flex items-center justify-between gap-3 text-sm">
          <span>{scope.label || "Selected information"}</span>
          <StatusPill tone="neutral">{scope.sensitivity || "Standard"}</StatusPill>
        </div>)}
      </div>
    </SectionCard>
    {scopes.length > 50 ? <p role="alert" className="text-sm text-destructive">Choose up to 50 fields for one request.</p> : null}
    <label className="block space-y-2 text-sm font-medium">
      Access duration
      <select className="block min-h-11 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm font-normal"
        value={durationHours} disabled={disabled} onChange={event => onDurationChange(Number(event.target.value))}
        data-testid={`${testIdPrefix}-duration-select`}>
        {REQUEST_DURATION_OPTIONS.map(option => <option key={option.hours} value={option.hours}>{option.label}</option>)}
      </select>
    </label>
    <label className="block space-y-2 text-sm font-medium">
      Purpose
      <Textarea value={purpose} disabled={disabled} onChange={event => onPurposeChange(event.target.value)} maxLength={500}
        placeholder="Explain why you need these and how you will use them." aria-describedby={hintId}
        data-testid={`${testIdPrefix}-purpose`} />
      <span id={hintId} className="text-xs font-normal text-muted-foreground">Add at least 8 characters so the recipient can make an informed decision.</span>
    </label>
  </div>;
}
