"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { AgentCard } from "@/components/dashboard/agent-card";
import { SectionHeader } from "@/components/app-ui/page-sections";
import { ApiService } from "@/lib/services/api-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { ROUTES } from "@/lib/navigation/routes";

function sageFixSeenKey(userId: string): string {
  return `sage_fix_seen_v1_${userId}`;
}

// Sage's "active" surface: rather than re-announcing the same passive take
// every time the dashboard loads, only push a bell notification when the
// specific suggested fix is new (or has changed) since the last time this
// user saw one -- avoids repeat-notifying for the same unresolved item on
// every /one visit.
function notifyIfNewSageFix(params: {
  userId: string;
  fix: { note_text?: string; from_display_name?: string; target_domain?: string; target_display_name?: string } | null | undefined;
}): void {
  if (typeof window === "undefined") return;
  const key = sageFixSeenKey(params.userId);
  const fix = params.fix;
  const signature = fix?.note_text && fix?.target_domain ? `${fix.target_domain}::${fix.note_text}` : "";

  let lastSeen: string | null = null;
  try {
    lastSeen = window.localStorage.getItem(key);
  } catch {
    lastSeen = null;
  }

  if (signature && signature !== lastSeen) {
    const taskId = AppBackgroundTaskService.startTask({
      userId: params.userId,
      kind: "sage_fix",
      title: "Sage found something to fix",
      description: `"${fix?.note_text}" looks filed under ${fix?.from_display_name}, not ${fix?.target_display_name}.`,
      routeHref: ROUTES.SAGE,
      visibility: "primary",
    });
    AppBackgroundTaskService.completeTask(taskId);
  }

  try {
    if (signature) {
      window.localStorage.setItem(key, signature);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Best-effort only -- a missed write just means this fix may re-notify once more.
  }
}

type CardState = {
  loading: boolean;
  metric: string | null;
  insight: string;
  meta: string | null;
};

const SAGE_IDLE: CardState = {
  loading: true,
  metric: null,
  insight: "Reading across everything Hushh knows about you…",
  meta: null,
};

function useSageCard(userId: string | null, vaultOwnerToken: string | null): CardState {
  const [state, setState] = useState<CardState>(SAGE_IDLE);

  useEffect(() => {
    if (!userId || !vaultOwnerToken) {
      setState((prev) => ({ ...prev, loading: false }));
      return;
    }

    let cancelled = false;

    async function run() {
      try {
        const metadata = await PersonalKnowledgeModelService.getMetadata(
          userId as string,
          false,
          vaultOwnerToken as string,
        );
        if (cancelled) return;

        if (metadata.domains.length === 0) {
          setState({
            loading: false,
            metric: null,
            insight: "Sage is still getting to know you.",
            meta: null,
          });
          return;
        }

        const briefingResponse = await ApiService.summarizeSageBriefing({
          vaultOwnerToken: vaultOwnerToken as string,
          domains: metadata.domains.map((d) => ({
            domain: d.key,
            displayName: d.displayName,
            summary: d.summary,
            attributeCount: d.attributeCount,
            lastUpdated: d.readableUpdatedAt || d.lastUpdated,
          })),
        });
        if (cancelled) return;

        const briefingData = briefingResponse.ok ? await briefingResponse.json() : null;
        notifyIfNewSageFix({ userId: userId as string, fix: briefingData?.suggested_fix });
        setState({
          loading: false,
          metric: String(metadata.totalAttributes),
          insight: briefingData?.text || "Not enough saved detail yet for a cross-domain read.",
          meta: `${metadata.domains.length} area${metadata.domains.length === 1 ? "" : "s"} of your life`,
        });
      } catch {
        if (!cancelled) {
          setState({
            loading: false,
            metric: null,
            insight: "Couldn't load Sage right now.",
            meta: null,
          });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [userId, vaultOwnerToken]);

  return state;
}

/**
 * "Today" board: Sage surfaced as a glanceable, quiet background-agent card,
 * above the static Workflows/Memory/Access tile grid -- the web counterpart
 * to desktop's Today section (Market Watch isn't part of this port; it's a
 * desktop/Electron-only surface).
 */
export function TodaySection({
  userId,
  vaultOwnerToken,
}: {
  userId: string | null;
  vaultOwnerToken: string | null;
}) {
  const sage = useSageCard(userId, vaultOwnerToken);

  return (
    <section
      aria-labelledby="one-section-today"
      className="space-y-3 rounded-2xl border border-emerald-500/14 bg-gradient-to-b from-emerald-500/[0.05] to-transparent p-3 dark:border-emerald-400/12 dark:from-emerald-400/[0.04] sm:p-4"
    >
      <SectionHeader
        id="one-section-today"
        title="Today"
        description="What Hushh has been keeping an eye on for you."
        icon={Sparkles}
        accent="emerald"
        className="px-0"
        testId="one-today-section"
      />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3">
        <AgentCard
          icon={Sparkles}
          tone="sage"
          title="Sage"
          metricLabel="Saved details"
          metric={sage.metric}
          insight={sage.insight}
          meta={sage.meta}
          href={ROUTES.SAGE}
          loading={sage.loading}
        />
      </div>
    </section>
  );
}
