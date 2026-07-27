"use client";

import { useEffect, useState } from "react";

import { apiJson } from "@/lib/services/api-client";

/**
 * "Your Agent One" — the first place a human SEES their own sovereign agent.
 *
 * Honest by construction. Until the always-on per-user pod is activated the state
 * is "reserved" (their agent identity is reserved and ready to activate); it
 * becomes "live" once a pod is provisioned. It reads the flag-safe status endpoint
 * (GET /api/one/personal-agent/status), which never 404s and never claims more
 * than is true, and it fails safe to "reserved" so it can never break the home.
 */

type AgentState = "reserved" | "active";

type StatusResponse = {
  state?: string;
  featureEnabled?: boolean;
  hushhId?: string;
};

const COPY: Record<
  AgentState,
  { badge: string; body: string; dotClass: string }
> = {
  reserved: {
    badge: "Reserved",
    body: "Reserved and ready to activate — your private agent, isolated to you alone.",
    dotClass: "bg-amber-500",
  },
  active: {
    badge: "Live",
    body: "Live and yours — always on, isolated to you alone.",
    dotClass: "bg-emerald-500",
  },
};

export function OneAgentPresence() {
  const [state, setState] = useState<AgentState>("reserved");

  useEffect(() => {
    let cancelled = false;
    apiJson<StatusResponse>("/api/one/personal-agent/status")
      .then((res) => {
        if (cancelled) return;
        setState(res?.state === "active" ? "active" : "reserved");
      })
      .catch(() => {
        // Fail safe: keep the honest "reserved" state; never break the home.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = COPY[state];

  return (
    <section
      aria-label="Your Agent One"
      className="flex items-center gap-3 rounded-[22px] border border-accent/15 bg-accent-surface/50 px-4 py-3.5 sm:px-5"
    >
      <span
        className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${copy.dotClass}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[14px] font-semibold text-foreground">
            <span aria-hidden className="mr-1">
              🤫
            </span>
            Your Agent One
          </span>
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {copy.badge}
          </span>
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">
          {copy.body}
        </span>
      </span>
    </section>
  );
}
