"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { BarChart3, Landmark, FileText, ScrollText } from "@/components/icons";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { KaiProfileService } from "@/lib/services/kai-profile-service";
import { requireFinanceSession, type FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { advisorRequest } from "@/lib/advisor-review/service";
import type { AdvisorCandidate } from "@/lib/advisor-review/contract";
import { ADVISOR_SERVICES, matchAdvisorServices, normalizeAdvisorService, type AdvisorService } from "@/lib/advisor-review/matching";
import finance from "@/components/kai/shared/finance-workspace.module.css";

const serviceIcons = [BarChart3, Landmark, FileText, ScrollText];

export function useAdvisorRecommendations(context: FinanceShareContext, query: string) {
  const pathname = usePathname();
  const [enabled, setEnabled] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [service, setService] = useState<AdvisorService | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<ReturnType<typeof matchAdvisorServices<AdvisorCandidate>>>([]);
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const pending = useRef(false);

  const clear = useCallback(() => {
    if (saving.current) return false;
    sequence.current++;
    abort.current?.abort();
    pending.current = false;
    setEnabled(false);
    setService(null);
    setChoosing(false);
    setMatches([]);
    setError(null);
    setBusy(false);
    return true;
  }, []);
  useBackLayer(pathname, enabled ? 2 : 0, () => { clear(); return true; });
  useEffect(() => () => {
    sequence.current++;
    abort.current?.abort();
  }, [context]);

  const start = async () => {
    if (pending.current || !context.isCurrent()) return;
    const ticket = ++sequence.current;
    pending.current = true;
    setEnabled(true);
    setBusy(true);
    setError(null);
    setMatches([]);
    try {
      const profile = await KaiProfileService.getProfile(context);
      requireFinanceSession(context);
      if (ticket !== sequence.current) return;
      const selected = normalizeAdvisorService(profile.preferences.advisor_service);
      setService(selected);
      setChoosing(!selected);
    } catch {
      if (ticket === sequence.current && context.isCurrent())
        setError("Recommendations could not be loaded. Please try again.");
    } finally {
      if (ticket === sequence.current && context.isCurrent()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const choose = async (selected: AdvisorService) => {
    if (pending.current || !context.isCurrent()) return;
    const ticket = ++sequence.current;
    saving.current = true;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await KaiProfileService.savePreferences({
        ...context,
        mode: "edit",
        updates: { advisor_service: selected },
        beforeEffect: async () => requireFinanceSession(context),
      });
      requireFinanceSession(context);
      if (ticket !== sequence.current) return;
      setService(selected);
      setChoosing(false);
    } catch {
      if (ticket === sequence.current && context.isCurrent())
        setError("Your choice could not be saved. Please try again.");
    } finally {
      saving.current = false;
      if (ticket === sequence.current && context.isCurrent()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (!enabled || !service || choosing) return;
    const ticket = ++sequence.current;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setMatches([]);
    void (async () => {
      try {
        requireFinanceSession(context);
        const result = await advisorRequest<{ items: AdvisorCandidate[] }>(
          context, "/candidates", "POST",
          { scope: "recommended", service, ...(query ? { query } : {}) }, controller.signal,
        );
        requireFinanceSession(context);
        if (ticket !== sequence.current || controller.signal.aborted) return;
        if (!Array.isArray(result.items) || result.items.length > 30 || result.items.some(person =>
          !person || typeof person.userId !== "string" || typeof person.name !== "string" ||
          typeof person.personRef !== "string" || !/^[0-9a-f-]{36}$/i.test(person.personRef) ||
          !Array.isArray(person.servicesOffered) || person.servicesOffered.some(value => typeof value !== "string"),
        )) throw new Error("Invalid advisor response");
        setMatches(matchAdvisorServices(result.items, service, context.userId));
      } catch {
        if (ticket === sequence.current && context.isCurrent() && !controller.signal.aborted)
          setError("Recommendations could not be loaded. Please try again.");
      } finally {
        if (ticket === sequence.current && context.isCurrent() && !controller.signal.aborted) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [context, enabled, service, choosing, query, attempt]);

  return {
    enabled, choosing, service, busy, error, matches, clear, choose,
    toggle: () => enabled ? clear() : void start(),
    retry: () => service && !choosing ? setAttempt(value => value + 1) : void start(),
    changeChoice: () => {
      if (saving.current) return;
      sequence.current++;
      abort.current?.abort();
      setChoosing(true);
      setBusy(false);
      setMatches([]);
      setError(null);
    },
  };
}

export function AdvisorRecommendations({ controller }: {
  controller: ReturnType<typeof useAdvisorRecommendations>;
}) {
  return (
    <KaiControlSurface
      open={controller.enabled && controller.choosing}
      onOpenChange={open => { if (!open) controller.clear(); }}
      title="What do you need help with?"
      description="Choose one area. You can change it anytime."
      surfaceClassName={finance.detail}
      headerTextOverflow="wrap"
      desktopMaxWidthClassName="sm:!max-w-[34rem]"
    >
      {controller.error ? <p role="alert" className="ui-text-helper-text">{controller.error}</p> : null}
      <SettingsGroup embedded density="comfortable" separatorInset>
        {ADVISOR_SERVICES.map((item, index) => (
          <SettingsRow key={item.id} icon={serviceIcons[index]} iconTone="transparent"
            title={item.label} chevron disabled={controller.busy}
            onClick={() => void controller.choose(item.id)} />
        ))}
      </SettingsGroup>
      {controller.busy ? <p role="status" className="ui-text-helper-text">Saving your choice…</p> : null}
    </KaiControlSurface>
  );
}
