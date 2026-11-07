"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Search } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import type { AdvisorReview } from "@/lib/advisor-review/contract";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import { AdvisorWorkspace } from "./advisor-workspace";
import { AdvisorRequestFlow } from "./advisor-request-flow";
import { PortfolioAgentReview } from "./portfolio-agent-review";
import { PortfolioPersona } from "./portfolio-persona";
import styles from "./advisor-review.module.css";

export function AdvisorReviewHub({
  source,
  advisor = false,
  model,
  children,
}: {
  source?: FinanceSource;
  advisor?: boolean;
  model?: DashboardViewModel;
  children?: ReactNode;
}) {
  const { capture, ready, session } = useFinanceShareContext();
  const [generation, setGeneration] = useState(0);
  const [personaRevision, setPersonaRevision] = useState(0);
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
          model={model}
          scope={session}
          personaRevision={personaRevision}
          onFindAdvisor={() => setCreating(true)}
        />
      ) : null}
      {children}
      {!advisor && context ? (
        <PortfolioPersona
          key={workspaceKey}
          context={context}
          onSaved={() => setPersonaRevision((revision) => revision + 1)}
        />
      ) : null}
      <div className={styles.card}>
        <div className={styles.row}>
          <div>
            <h2 className="ui-text-section-label">
              {advisor ? "Review requests" : "A human second opinion"}
            </h2>
            <p className="ui-text-helper-text">
              {advisor
                ? "Accept a request to connect and open its approved Finance snapshot."
                : "Choose a verified advisor, connect and arrange an introduction."}
            </p>
          </div>
          {source ? (
            <ShellActionSurface
              variant="pill"
              className={styles.primary}
              disabled={!context}
              onClick={() => setCreating(true)}
            >
              Find an advisor
            </ShellActionSurface>
          ) : null}
        </div>
        {!context ? (
          <p role="status">Unlock One to manage advisor requests.</p>
        ) : null}
        {!context ? (
          <p className="ui-text-row-description" role="status">
            Unlock One to manage advisor requests.
          </p>
        ) : null}
        {error ? <p className="ui-text-row-description" role="alert">{error}</p> : null}
        {context && !items.length && !error ? (
          <p className="ui-text-row-description">
            {state?.context === context
              ? "No advisor requests yet."
              : "Checking requests…"}
          </p>
        ) : null}
        {items.length ? (
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
        ) : null}
        {source ? (
          <div className="mt-auto flex justify-end">
            <ShellActionSurface
              variant="pill"
              className="min-h-11 ui-text-compact-button-label"
              disabled={!context}
              onClick={() => setCreating(true)}
            >
              <Search aria-hidden="true" className="size-3.5" />
              Find an advisor
            </ShellActionSurface>
          </div>
        ) : null}
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
          model={model}
          scope={session}
          personaRevision={personaRevision}
          persona={<PortfolioPersona context={context} onSaved={() => setPersonaRevision((revision) => revision + 1)} />}
          onFindAdvisor={() => setCreating(true)}
        />
      ) : null}
      {renderAnalysis ? renderAnalysis(advisorCard) : advisorCard}
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
          onClose={() => select(null)}
        />
      ) : null}
    </section>
  );
}
