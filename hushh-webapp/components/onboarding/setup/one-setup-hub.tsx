"use client";

import { useMemo } from "react";
import { Sparkles, type LucideIcon } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { CapabilitySetupTile } from "@/components/onboarding/setup/capability-setup-tile";
import {
  CAPABILITY_SETUP_COPY,
  type CapabilitySetupCopy,
} from "@/lib/onboarding/capability-setup-copy";
import {
  getOneCapability,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import { useCapabilitySetupStates } from "@/lib/onboarding/use-capability-setup-states";
import {
  isCapabilitySetupActionable,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import { cn } from "@/lib/utils";

/**
 * OneSetupHub: the `/one/setup` hub screen.
 *
 * It is the calm home for "what's left to set up". It opts into the expensive
 * resolver enrichment (`enrichVault` + `enrichOauth`) so every tile shows an
 * honest state (Ready, Set up, N to review) or an honest blocked reason
 * ("Unlock to set up", "Connect to set up") instead of guessing.
 *
 * LAYOUT (Card Depth Model + recompose-by-breakpoint)
 * - Lives inside the normal app shell (`standard` chrome) so a person who has
 *   finished onboarding can still browse here without being trapped in a flow.
 * - Phone: a single scrollable column of full-width setup tiles.
 * - Tablet / desktop: a two-column grid. The shell itself owns the scroll; the
 *   header region stays put.
 * - One owns the voice: "Set up One", plain language, no system nouns.
 */
export function OneSetupHub() {
  const { byId, isLoading } = useCapabilitySetupStates({
    enrichVault: true,
    enrichOauth: true,
  });

  const items = useMemo(() => buildSetupItems(byId), [byId]);

  const total = items.length;
  const remaining = items.filter((item) => item.isActionable).length;
  const done = total - remaining;
  const allReady = total > 0 && remaining === 0;

  const summary = isLoading
    ? "Checking what's set up…"
    : allReady
      ? "Everything's set up. You're good to go."
      : `${done} of ${total} ready, ${remaining} left to set up.`;

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/setup",
        marker: "native-route-one-setup",
        authState: "authenticated",
        dataState: isLoading ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Set up One"
          title={allReady ? "You're all set" : "Finish setting up One"}
          description={summary}
          icon={Sparkles}
          accent="neutral"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <ol
          className="grid grid-cols-1 gap-2.5 md:grid-cols-2"
          aria-label="Setup steps"
        >
          {items.map((item) => (
            <li key={item.id} className={cn(item.isCurrent && "md:col-span-2")}>
              <CapabilitySetupTile
                title={item.copy.setupTitle}
                description={item.copy.setupBlurb}
                href={item.copy.href}
                icon={item.icon}
                tone={item.tone}
                status={item.status}
                isCurrent={item.isCurrent}
              />
            </li>
          ))}
        </ol>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

interface SetupItem {
  id: string;
  copy: CapabilitySetupCopy;
  status: CapabilityStatus;
  icon: LucideIcon;
  tone: OneCapabilityTone;
  isActionable: boolean;
  isCurrent: boolean;
}

function buildSetupItems(
  byId: Record<string, CapabilityStatus>,
): SetupItem[] {
  // Order: still-actionable capabilities first (so the next thing to do is at
  // the top), completed/ready ones after. Stable within each bucket by catalog
  // order so the list never jumps around between renders.
  const enriched = CAPABILITY_SETUP_COPY.flatMap((copy) => {
    const capability = getOneCapability(copy.id);
    if (!capability) return [];
    const status: CapabilityStatus = byId[copy.id] ?? {
      id: copy.id,
      state: "unknown",
      pendingCount: 0,
      prerequisite: null,
      requiresUnlock: false,
    };
    return [
      {
        id: copy.id,
        copy,
        status,
        icon: capability.icon,
        tone: capability.tone,
        isActionable: isCapabilitySetupActionable(status),
      },
    ];
  });

  const ordered = [
    ...enriched.filter((item) => item.isActionable),
    ...enriched.filter((item) => !item.isActionable),
  ];

  const firstActionableId = ordered.find((item) => item.isActionable)?.id ?? null;

  return ordered.map((item) => ({
    ...item,
    isCurrent: item.id === firstActionableId,
  }));
}
