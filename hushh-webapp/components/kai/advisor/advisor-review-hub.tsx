"use client";

import { useEffect, useMemo, useState } from "react";
import { PortfolioAnalysis } from "@/components/kai/views/portfolio-briefing";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ChevronDown, Search } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import type { AdvisorReview } from "@/lib/advisor-review/contract";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import { AdvisorWorkspace } from "./advisor-workspace";
import { AdvisorRequestFlow } from "./advisor-request-flow";
import { PortfolioAgentReview } from "./portfolio-agent-review";
import styles from "./advisor-review.module.css";

export function AdvisorReviewHub({
  source,
  advisor = false,
  model,
}: {
  source?: FinanceSource;
  advisor?: boolean;
  model?: DashboardViewModel;
}) {
  const { capture, ready, session } = useFinanceShareContext();
  const [generation, setGeneration] = useState(0);
  const [creating, setCreating] = useState(false);
  const { context, workspaceKey } = useMemo(
    () => ({
      context: ready ? capture() : null,
      workspaceKey: `${session}:${generation}`,
    }),
    [capture, ready, session, generation],
  );
  const [state, setState] = useState<{
    context: typeof context;
    items: AdvisorReview[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const requested = search.get("advisorReview");
  const id = requested && /^[a-f0-9-]{36}$/i.test(requested) ? requested : null;
  const select = (value: string | null) => {
    const next = new URLSearchParams(search.toString());
    if (value) next.set("advisorReview", value);
    else next.delete("advisorReview");
    next.delete("advisorSection");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
      scroll: false,
    });
  };
  useBackLayer(pathname, id ? 1 : 0, () => {
    select(null);
    return true;
  });
  useEffect(() => {
    const visibility = () => {
      setState(null);
      setCreating(false);
      setGeneration((n) => n + 1);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!context) return;
    let disposed = false;
    void AdvisorReviewService.history(context)
      .then((result) => {
        if (!disposed && context.isCurrent()) {
          setState({ context, items: result.items });
          setError(null);
        }
      })
      .catch((e) => {
        if (!disposed && context.isCurrent())
          setError(
            e instanceof Error ? e.message : "Requests could not be checked.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [context, id, creating]);
  const items =
    state?.context === context
      ? state.items.filter((row) =>
          advisor ? row.direction === "received" : row.direction === "outgoing",
        )
      : [];
  const cardTitle = advisor ? "Review requests" : "Talk to an advisor";
  const requestRows = (
    <SettingsGroup
      embedded
      separatorInset
      shellClassName="bg-[color:var(--app-card-surface-compact)] shadow-none"
    >
      {items.map((row) => {
        const name = advisor ? row.ownerName : row.advisorName;
        return (
          <SettingsRow
            key={row.id}
            title={name}
            leading={<ConnectionPersonAvatar label={name} size="compact" />}
            description={row.status === "accepted"
              ? "Connected · introduction and plan"
              : <span className="capitalize">{row.status}</span>}
            chevron
            textOverflow="truncate"
            ariaLabel={`Open request with ${name}`}
            describeContent
            onClick={() => select(row.id)}
          />
        );
      })}
    </SettingsGroup>
  );
  const requestStatus = !context ? (
    <p className="ui-text-row-description" role="status">Unlock One to manage advisor requests.</p>
  ) : error ? (
    <p className="ui-text-row-description" role="alert">{error}</p>
  ) : !items.length ? (
    <p className="ui-text-row-description">
      {state?.context === context ? "No advisor requests yet." : "Checking requests…"}
    </p>
  ) : null;
  const advisorCard = advisor ? (
    <SurfaceCard role="region" aria-label={cardTitle}>
      <SurfaceCardContent className="space-y-3 p-4">
        <h2 className="ui-text-section-label">{cardTitle}</h2>
        <p className="ui-text-row-description">
          Accept a request to connect and open its approved Finance snapshot.
        </p>
        {requestStatus}
        {items.length ? requestRows : null}
      </SurfaceCardContent>
    </SurfaceCard>
  ) : (
    <SurfaceCard role="region" aria-label={cardTitle}>
      <SurfaceCardContent className="px-4 py-1.5">
        <Collapsible>
          <div className="flex flex-wrap items-center justify-between gap-x-2">
            <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-1.5 ui-text-section-label">
              Advisor requests{items.length ? ` · ${items.length}` : ""}
              <ChevronDown aria-hidden className="size-3 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            {source ? (
              <ShellActionSurface
                variant="pill"
                className="min-h-11 ui-text-compact-button-label"
                disabled={!context}
                onClick={() => setCreating(true)}
              >
                <Search aria-hidden="true" className="size-3.5" />
                Find an advisor
              </ShellActionSurface>
            ) : null}
          </div>
          <CollapsibleContent className="pb-2">
            {requestStatus}
            {items.length ? requestRows : null}
          </CollapsibleContent>
        </Collapsible>
      </SurfaceCardContent>
    </SurfaceCard>
  );

  return (
    <section
      className={styles.stack}
      aria-label={advisor ? "Advisor review requests" : "Human advisor review"}
    >
      {!advisor && context && source && model ? (
        <PortfolioAgentReview
          key={workspaceKey}
          context={context}
          source={source}
          scope={session}
        />
      ) : !advisor && source && model ? (
        <>
          <SurfaceCard>
            <SurfaceCardContent className="p-4">
              <h2 className="ui-text-section-label">Portfolio review</h2>
              <p className="ui-text-helper-text">Unlock One to view your portfolio review.</p>
            </SurfaceCardContent>
          </SurfaceCard>
          <PortfolioAnalysis />
        </>
      ) : null}
      {advisorCard}
      {context && creating && source ? (
        <AdvisorRequestFlow
          key={workspaceKey}
          context={context}
          source={source}
          onClose={() => setCreating(false)}
          onSent={(value) => {
            setCreating(false);
            select(value);
          }}
        />
      ) : null}
      {context && id && !creating ? (
        <AdvisorWorkspace
          key={`${id}:${workspaceKey}`}
          id={id}
          context={context}
          openPlan={search.get("advisorSection") === "plan"}
          onClose={() => select(null)}
        />
      ) : null}
    </section>
  );
}
