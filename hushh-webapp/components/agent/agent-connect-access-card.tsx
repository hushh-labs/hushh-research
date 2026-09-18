"use client";

import { Check, ShieldCheck } from "@/components/icons";

import { Button } from "@/components/ui/button";

export type AgentConnectAccessCardProps = {
  title: string;
  bullets: string[];
  ctaLabel: string;
  busy?: boolean;
  onConnect: () => void;
  onDismiss: () => void;
};

/**
 * A one-time, inline "access request" card shown at the top of a fresh Agent
 * One chat when a readable data source (Gmail today) isn't connected yet.
 *
 * Visually modeled on SpecialistConsentRequiredCard's shell (same green
 * roundel + card treatment), but a distinct component: that card's props
 * (agentId/requiredScope) and "route to /one/consents" semantics are for the
 * PKM/vault-scope consent flow, not an OAuth-connect action, and its copy is
 * scope language rather than the plain-language privacy bullets this card
 * needs. Purely client-side -- see agent-chat-workspace.tsx's wiring, which
 * drives this off useGmailConnectorStatus() rather than a backend directive.
 */
export function AgentConnectAccessCard({
  title,
  bullets,
  ctaLabel,
  busy,
  onConnect,
  onDismiss,
}: AgentConnectAccessCardProps) {
  return (
    <div
      data-testid="agent-connect-access-card"
      className="rounded-2xl border border-[#6b8f71]/35 bg-[#6b8f71]/5 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#6b8f71]/10 text-[#426548]">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <ul className="mt-2 space-y-1.5">
            {bullets.map((bullet) => (
              <li
                key={bullet}
                className="flex items-start gap-2 text-sm text-foreground/75"
              >
                <Check
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#426548]"
                  aria-hidden="true"
                />
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          data-testid="agent-connect-access-cta"
          size="sm"
          disabled={busy}
          onClick={onConnect}
        >
          {busy ? "Connecting…" : ctaLabel}
        </Button>
        <Button
          data-testid="agent-connect-access-dismiss"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onDismiss}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
