"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { type SharedWithYouCardModel, type SharedWithYouPerson } from "@/components/agent/consent/shared-with-you-card";
import { SharedWithYouCardView, type SharedWithYouItemView } from "@/components/agent/consent/shared-with-you-card-view";
import type { SharedWithMeCardItem } from "@/lib/agent/agui-structured-experiences";
import { buildConsentCenterHref, type ConsentSheetView } from "@/lib/consent/consent-sheet-route";
import { domainLabelFor } from "@/lib/consent/consent-scope-items";
import { resolveScopePhosphorIcon } from "@/lib/consent/scope-icon-resolver";
import type { ConsentHistoryTrailEvent } from "@/components/consent/consent-history-trails";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/lib/morphy-ux/button";
import { StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { cn } from "@/lib/utils";

function ResponsiveProfileSheet({
  open,
  onOpenChange,
  title,
  description,
  footer,
  backPathname,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  footer?: ReactNode;
  backPathname: string;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  useBackLayer(backPathname, open ? 20 : 0, () => {
    onOpenChange(false);
    return true;
  });

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="consent-presentation-surface max-h-[85dvh]">
          <DrawerHeader className="text-left">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>{description}</DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
            {children}
          </div>
          {footer ? (
            <DrawerFooter className="border-t border-border/60 pt-3">{footer}</DrawerFooter>
          ) : null}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog modal open={open} onOpenChange={onOpenChange}>
      <DialogContent className="consent-presentation-surface w-[calc(100%-2rem)] max-w-[32rem] max-h-[min(38rem,calc(100dvh-3rem))] gap-3 overflow-hidden p-4 sm:max-w-[32rem]">
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="[overflow-wrap:anywhere]">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
          {children}
        </div>
        {footer ? (
          <DialogFooter className="shrink-0 flex-row items-center justify-between border-t border-border/60 pt-3">
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function PersonSharedWithYouSheet({
  open,
  onOpenChange,
  person,
  items,
  model,
  onUnlock,
  backPathname,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: SharedWithYouPerson;
  items: SharedWithMeCardItem[];
  model: SharedWithYouCardModel;
  onUnlock?: () => void;
  backPathname: string;
}) {
  const domainByKey = useMemo(() => {
    const map = new Map<string, string | null | undefined>();
    for (const raw of items) {
      map.set(raw.key, raw.domain);
    }
    return map;
  }, [items]);

  const domainGroups = useMemo(() => {
    const map = new Map<string, { domainKey: string; domainLabel: string; views: SharedWithYouItemView[] }>();
    for (const view of model.items) {
      const rawDomain = domainByKey.get(view.key);
      const domainKey = (rawDomain || "shared").trim().toLowerCase() || "shared";
      const existing = map.get(domainKey);
      if (existing) {
        existing.views.push(view);
      } else {
        map.set(domainKey, {
          domainKey,
          domainLabel: rawDomain ? domainLabelFor(rawDomain) : "Shared information",
          views: [view],
        });
      }
    }
    return [...map.values()];
  }, [domainByKey, model.items]);

  const autoExpandSingle = domainGroups.length === 1 && model.items.length <= 2;
  const [expandedDomains, setExpandedDomains] = useState<ReadonlySet<string>>(() => new Set());

  const toggleDomain = (domainKey: string) => {
    setExpandedDomains((current) => {
      const next = new Set(current);
      if (next.has(domainKey)) next.delete(domainKey);
      else next.add(domainKey);
      return next;
    });
  };

  return (
    <ResponsiveProfileSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Shared by ${person.displayName}`}
      description="Decrypted on this device only while your vault is unlocked."
      backPathname={backPathname}
    >
      <div className="space-y-2.5" data-testid="person-profile-shared-sheet">
        {domainGroups.map((group) => {
          const isOpen = autoExpandSingle || expandedDomains.has(group.domainKey);
          const { Icon } = resolveScopePhosphorIcon({
            domain: group.domainKey,
            label: group.views[0]?.label ?? group.domainLabel,
          });
          return (
            <div
              key={group.domainKey}
              className="overflow-hidden rounded-2xl border border-border/60 bg-[color:var(--app-card-surface-default-solid)]"
            >
              {!autoExpandSingle ? (
                <button
                  type="button"
                  onClick={() => toggleDomain(group.domainKey)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:bg-[color:var(--app-accent-tint)]"
                  data-testid={`shared-domain-toggle-${group.domainKey}`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Icon className="size-4 shrink-0 text-[color:var(--app-accent)]" weight="regular" aria-hidden="true" />
                    <span className="truncate text-sm font-medium text-foreground">{group.domainLabel}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <span>{group.views.length} {group.views.length === 1 ? "item" : "items"}</span>
                    {isOpen ? (
                      <ChevronDown className="size-4" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="size-4" aria-hidden="true" />
                    )}
                  </span>
                </button>
              ) : null}
              {isOpen ? (
                <div className={cn(!autoExpandSingle && "border-t border-border/50 px-3.5 py-3", autoExpandSingle && "p-3.5")}>
                  <SharedWithYouCardView
                    person={{ displayName: person.displayName, photoUrl: person.photoUrl ?? null, personRef: person.personRef }}
                    status={model.status}
                    items={group.views}
                    variant="embedded"
                    onRetry={model.retry}
                    onUnlock={onUnlock}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </ResponsiveProfileSheet>
  );
}

export type PersonHistoryBundleSummary = {
  bundleId: string;
  title: string;
  subtitle: string | null | undefined;
  meta: string | null;
  statusLabel: string;
  statusTone: "ready" | "neutral";
  consentTab: ConsentSheetView;
  primaryRequestId: string | null;
  hasPending: boolean;
  detailsLoaded: boolean;
  loadingDetails: boolean;
  cancelling: boolean;
  events: ConsentHistoryTrailEvent[];
};

export function PersonRequestHistorySheet({
  open,
  onOpenChange,
  personName,
  bundles,
  returnFromPath,
  backPathname,
  onLoadBundleDetails,
  onCancelBundle,
  pagination,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personName: string;
  bundles: readonly PersonHistoryBundleSummary[];
  returnFromPath: string;
  backPathname: string;
  onLoadBundleDetails: (bundleId: string) => void;
  onCancelBundle: (bundleId: string) => void;
  pagination?: ReactNode;
}) {
  const [expandedBundles, setExpandedBundles] = useState<ReadonlySet<string>>(() => new Set());

  const toggleBundle = (bundle: PersonHistoryBundleSummary) => {
    const willOpen = !expandedBundles.has(bundle.bundleId);
    setExpandedBundles((current) => {
      const next = new Set(current);
      if (next.has(bundle.bundleId)) next.delete(bundle.bundleId);
      else next.add(bundle.bundleId);
      return next;
    });
    if (willOpen && !bundle.detailsLoaded && !bundle.loadingDetails) {
      onLoadBundleDetails(bundle.bundleId);
    }
  };

  return (
    <ResponsiveProfileSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Requests with ${personName}`}
      description="Tap any request to view item statuses or open it in Consent Center."
      backPathname={backPathname}
      footer={pagination}
    >
      <SettingsGroup density="compact" separatorInset testId="person-profile-history-sheet">
        {bundles.length === 0 ? (
          <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
            Loading requests…
          </p>
        ) : null}
        {bundles.map((bundle) => {
          const isOpen = expandedBundles.has(bundle.bundleId);
          const consentHref = buildConsentCenterHref(bundle.consentTab, {
            bundleId: bundle.bundleId,
            ...(bundle.primaryRequestId ? { requestId: bundle.primaryRequestId } : {}),
            requestView: "sent",
            from: returnFromPath,
          });
          return (
            <div key={bundle.bundleId} className="divide-y divide-border/40">
              <SettingsRow
                density="compact"
                title={bundle.title}
                description={[bundle.meta, bundle.subtitle].filter(Boolean).join(" · ") || undefined}
                onClick={() => toggleBundle(bundle)}
                ariaLabel={`Details for ${bundle.title}`}
                trailing={
                  <span className="flex items-center gap-2">
                    <StatusPill tone={bundle.statusTone}>{bundle.statusLabel}</StatusPill>
                    {isOpen ? (
                      <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                    )}
                  </span>
                }
              />
              {isOpen ? (
                <div
                  className="space-y-2.5 bg-muted/20 px-4 py-3 text-xs"
                  data-testid={bundle.detailsLoaded ? "person-profile-bundle-details" : undefined}
                >
                  {bundle.loadingDetails ? (
                    <p role="status" className="text-muted-foreground">Loading request details…</p>
                  ) : null}
                  {bundle.events.length ? (
                    <ul className="space-y-1.5">
                      {bundle.events.map((event) => (
                        <li key={event.key} className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-medium text-foreground">{event.detail || event.label}</span>
                          {event.detail ? (
                            <span className="text-muted-foreground">{event.label}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      data-consent-role="compact-action"
                      asChild
                      type="button"
                      size="compact"
                      variant="none"
                      effect="fade"
                    >
                      <Link href={consentHref}>Review request</Link>
                    </Button>
                    {bundle.hasPending ? (
                      <Button
                        data-consent-role="compact-action"
                        type="button"
                        size="compact"
                        variant="none"
                        effect="fade"
                        disabled={bundle.cancelling}
                        onClick={() => onCancelBundle(bundle.bundleId)}
                      >
                        {bundle.cancelling ? "Withdrawing…" : "Withdraw request"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </SettingsGroup>
    </ResponsiveProfileSheet>
  );
}
