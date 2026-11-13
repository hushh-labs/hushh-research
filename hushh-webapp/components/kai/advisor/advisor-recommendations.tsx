"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { BarChart3, Landmark, FileText, ScrollText } from "@/components/icons";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { buildPersonProfileRoute } from "@/lib/navigation/routes";
import {
  KaiProfileService,
  type KaiPreferences,
} from "@/lib/services/kai-profile-service";
import {
  requireFinanceSession,
  type FinanceShareContext,
} from "@/lib/services/finance-sharing-service";
import { getInvestingPersona } from "@/lib/kai/investing-persona";
import { advisorRequest } from "@/lib/advisor-review/service";
import type { AdvisorCandidate } from "@/lib/advisor-review/contract";
import {
  ADVISOR_SERVICES,
  advisorServiceLabel,
  matchAdvisorServices,
  normalizeAdvisorService,
  type AdvisorService,
} from "@/lib/advisor-review/matching";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import styles from "./advisor-review.module.css";

const serviceIcons = [BarChart3, Landmark, FileText, ScrollText];

export function AdvisorRecommendations({
  context,
  model,
  onChoose,
}: {
  context: FinanceShareContext;
  model?: DashboardViewModel;
  onChoose: (advisor: AdvisorCandidate) => void;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"choose" | "results">("choose");
  const [busy, setBusy] = useState<"loading" | "saving" | null>(null);
  const [preferences, setPreferences] = useState<KaiPreferences | null>(null);
  const [service, setService] = useState<AdvisorService | null>(null);
  const [matches, setMatches] = useState<
    ReturnType<typeof matchAdvisorServices<AdvisorCandidate>>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && !busy) content.current?.focus();
  }, [open, busy, stage]);
  const close = () => {
    if (saving.current) return;
    sequence.current++;
    abort.current?.abort();
    setOpen(false);
    setMatches([]);
    setPreferences(null);
    setError(null);
    setBusy(null);
  };
  useBackLayer(pathname, open ? 1 : 0, () => {
    close();
    return true;
  });
  useEffect(
    () => () => {
      sequence.current++;
      abort.current?.abort();
    },
    [],
  );

  const load = async (selected: AdvisorService, ticket: number) => {
    requireFinanceSession(context);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const result = await advisorRequest<{ items: AdvisorCandidate[] }>(
      context,
      "/candidates",
      "POST",
      {
        scope: "recommended",
        service: selected,
      },
      controller.signal,
    );
    requireFinanceSession(context);
    if (ticket !== sequence.current || controller.signal.aborted) return;
    if (
      !Array.isArray(result.items) ||
      result.items.length > 30 ||
      result.items.some(
        (person) =>
          !person ||
          typeof person.userId !== "string" ||
          typeof person.personRef !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(person.personRef) ||
          typeof person.name !== "string" ||
          !Array.isArray(person.servicesOffered) ||
          person.servicesOffered.some((value) => typeof value !== "string"),
      )
    )
      throw new Error(
        "Advisor details could not be checked. Please try again.",
      );
    setMatches(matchAdvisorServices(result.items, selected, context.userId));
    setService(selected);
    setStage("results");
  };

  const start = async () => {
    if (busy || !context.isCurrent()) return;
    const ticket = ++sequence.current;
    setOpen(true);
    setBusy("loading");
    setError(null);
    setMatches([]);
    try {
      const profile = await KaiProfileService.getProfile(context);
      requireFinanceSession(context);
      if (ticket !== sequence.current) return;
      setPreferences(profile.preferences);
      const selected = normalizeAdvisorService(
        profile.preferences.advisor_service,
      );
      if (selected) await load(selected, ticket);
      else setStage("choose");
    } catch {
      if (ticket === sequence.current && context.isCurrent())
        setError("Recommendations could not be loaded. Please try again.");
    } finally {
      if (ticket === sequence.current && context.isCurrent()) setBusy(null);
    }
  };

  const choose = async (selected: AdvisorService) => {
    if (busy || saving.current || !context.isCurrent()) return;
    const ticket = ++sequence.current;
    saving.current = true;
    setBusy("saving");
    setError(null);
    try {
      const profile = await KaiProfileService.savePreferences({
        ...context,
        mode: "edit",
        updates: { advisor_service: selected },
        beforeEffect: async () => requireFinanceSession(context),
      });
      requireFinanceSession(context);
      if (ticket !== sequence.current) return;
      setPreferences(profile.preferences);
      setService(selected);
      saving.current = false;
      setBusy("loading");
      await load(selected, ticket);
    } catch {
      if (ticket === sequence.current && context.isCurrent())
        setError(
          "Your choice or recommendations could not be confirmed. Please try again.",
        );
    } finally {
      saving.current = false;
      if (ticket === sequence.current && context.isCurrent()) setBusy(null);
    }
  };

  const visible = open && context.isCurrent();
  return (
    <>
      <ShellActionSurface
        variant="pill"
        data-voice-control-id="finance_recommend_advisor"
        disabled={!context.isCurrent()}
        onClick={() => void start()}
      >
        Recommend advisor
      </ShellActionSurface>
      <KaiControlSurface
        open={visible}
        onOpenChange={(value) => {
          if (!value) close();
        }}
        title={
          stage === "choose"
            ? "What do you need help with?"
            : "Advisors for you"
        }
        description={
          stage === "choose"
            ? "Choose one area. You can change it anytime."
            : service
              ? advisorServiceLabel(service)
              : "Matching advisors"
        }
        headerTextOverflow="wrap"
        desktopMaxWidthClassName="sm:!max-w-[34rem]"
      >
        <div
          ref={content}
          tabIndex={-1}
          className={`${styles.stack} outline-none`}
        >
          {busy ? (
            <p role="status">
              {busy === "saving"
                ? "Saving your choice…"
                : "Finding service matches…"}
            </p>
          ) : null}
          {error ? (
            <div role="alert">
              <p>{error}</p>
              <ShellActionSurface variant="pill" onClick={() => void start()}>
                Try again
              </ShellActionSurface>
            </div>
          ) : null}
          {!busy && !error && stage === "choose" ? (
            <SettingsGroup embedded density="comfortable" separatorInset>
              {ADVISOR_SERVICES.map((item, index) => (
                <SettingsRow
                  key={item.id}
                  icon={serviceIcons[index]}
                  iconTone="transparent"
                  title={item.label}
                  chevron
                  onClick={() => void choose(item.id)}
                />
              ))}
            </SettingsGroup>
          ) : null}
          {!busy && !error && stage === "results" && service ? (
            <>
              <div className={styles.row}>
                <p className="ui-text-helper-text">
                  {matches.length}{" "}
                  {matches.length === 1 ? "service match" : "service matches"}
                </p>
                <ShellActionSurface
                  variant="pill"
                  onClick={() => {
                    setStage("choose");
                    setMatches([]);
                  }}
                >
                  Change choice
                </ShellActionSurface>
              </div>
              {matches.length ? (
                <div className="divide-y divide-border">
                  {matches.map(({ advisor, reason }) => (
                    <section
                      className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0"
                      key={advisor.personRef}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <ConnectionPersonAvatar
                          label={advisor.name}
                          verified={advisor.verified}
                          size="list"
                        />
                        <div className="min-w-0 flex-1">
                          <h4
                            className="ui-text-row-label truncate"
                            title={advisor.name}
                          >
                            {advisor.name}
                          </h4>
                          <p className="ui-text-helper-text">{reason}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 pl-[52px]">
                        <Link
                          className="ui-text-trailing-action inline-flex min-h-11 items-center"
                          href={buildPersonProfileRoute(advisor.personRef, {
                            from: pathname,
                          })}
                        >
                          View profile
                        </Link>
                        <ShellActionSurface
                          variant="pill"
                          disabled={!advisor.ready}
                          onClick={() => {
                            close();
                            onChoose(advisor);
                          }}
                        >
                          {advisor.ready
                            ? "Review introduction"
                            : "Secure introduction unavailable"}
                        </ShellActionSurface>
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p role="status">
                  No verified advisors with this stated service are available in
                  your directory yet. Try another service or use Find an
                  advisor.
                </p>
              )}
              <details className="border-t border-border pt-2">
                <summary className="ui-text-helper-text flex min-h-11 cursor-pointer items-center">
                  How these matches work
                </summary>
                <p className="ui-text-helper-text pb-2">
                  These advisors list the service you chose. Their order does
                  not indicate quality.
                </p>
                {preferences || model ? (
                  <p className="ui-text-helper-text pb-2">
                    Your private context:{" "}
                    {preferences
                      ? getInvestingPersona(preferences).label
                      : "Persona not available"}
                    {model ? ` · ${model.holdings.length} holdings` : ""}. We
                    need comparable advisor information before using this to
                    rank investment-style fit.
                  </p>
                ) : null}
              </details>
            </>
          ) : null}
        </div>
      </KaiControlSurface>
    </>
  );
}
