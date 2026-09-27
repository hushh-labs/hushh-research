"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Check, FileUp, Plus } from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import {
  buildFirstRunAgentActions,
  buildFirstRunConnectorActions,
  type FirstRunLaunch,
} from "@/lib/agent/agent-first-run-actions";
import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import { ROUTES } from "@/lib/navigation/routes";
import { getOneCapability } from "@/lib/onboarding/one-capabilities";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { cn } from "@/lib/utils";

const CHIP_CLASS =
  "inline-flex !min-h-11 max-w-full items-center gap-2 !rounded-2xl border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] !px-3.5 !py-2 text-left text-sm font-medium text-foreground shadow-[var(--app-glass-shadow)] transition-colors duration-150 hover:bg-[color:var(--app-shell-surface-bg-hover)] active:opacity-90 disabled:pointer-events-none disabled:opacity-60";

/** Reads Drive's status once; Gmail and Calendar use their shared status hooks. */
function useDriveConnected(vaultOwnerToken: string | null): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!vaultOwnerToken) return;
    let active = true;
    ExternalConnectorService.overview(vaultOwnerToken)
      .then((overview) => {
        if (!active) return;
        const drive = overview.connectors.find((item) => item.connectorId === "google_drive");
        setConnected(drive ? ["connected", "verifying"].includes(drive.status) : null);
      })
      .catch(() => {
        if (active) setConnected(null);
      });
    return () => {
      active = false;
    };
  }, [vaultOwnerToken]);
  return connected;
}

function ActionGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="mt-4 first:mt-0">
      <p className="px-1 text-xs font-medium text-muted-foreground">{title}</p>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function ActionChip({
  label,
  done,
  doneLabel,
  icon,
  disabled,
  onSelect,
}: {
  label: string;
  done: boolean | null;
  doneLabel: string;
  icon: ReactNode;
  disabled: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={done ? `${label}, ${doneLabel}` : label}
      data-first-run-done={done ? "true" : undefined}
      onClick={(event) => onSelect(event.currentTarget)}
      className={CHIP_CLASS}
    >
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 whitespace-normal leading-5">{label}</span>
      {done ? (
        <Check className="size-4 shrink-0 text-[color:var(--app-accent-deep)]" aria-hidden="true" />
      ) : null}
    </button>
  );
}

/**
 * First-run action surface inside the post-setup welcome message: connect
 * accounts and set up agents through flows that already exist. Rendered once,
 * at assistant-message width; it owns no connection logic of its own.
 */
export function AgentFirstRunActions({
  vaultOwnerToken,
  hasPortfolioData,
  memoryHasItems,
  disabled,
  onOpenConnector,
  onNavigate,
}: {
  vaultOwnerToken: string | null;
  hasPortfolioData: boolean;
  memoryHasItems: boolean;
  disabled: boolean;
  onOpenConnector: (
    provider: "gmail" | "drive" | "calendar" | undefined,
    trigger: HTMLButtonElement,
  ) => void;
  onNavigate: (href: string) => void;
}) {
  const { user } = useAuth();
  const idTokenProvider = useCallback(
    () => user?.getIdToken() ?? Promise.resolve(""),
    [user],
  );
  const gmail = useGmailConnectorStatus({
    userId: user?.uid,
    idTokenProvider: user ? idTokenProvider : null,
    routeHref: ROUTES.HOME,
  });
  const calendar = useCalendarConnectionStatus({
    userId: user?.uid ?? null,
    idTokenProvider: user ? idTokenProvider : null,
    enabled: Boolean(vaultOwnerToken),
  });
  const driveConnected = useDriveConnected(vaultOwnerToken);

  const connectors = buildFirstRunConnectorActions({
    gmail: gmail.status ? Boolean(gmail.status.connected && !gmail.status.needs_reauth) : null,
    googleDrive: driveConnected,
    calendar: calendar.loaded && !calendar.error ? calendar.connected : null,
  });
  const agents = buildFirstRunAgentActions({ hasPortfolioData, memoryHasItems });

  const launch = (target: FirstRunLaunch, trigger: HTMLButtonElement) => {
    if (target.kind === "route") {
      onNavigate(target.href);
      return;
    }
    onOpenConnector(target.provider ?? undefined, trigger);
  };

  return (
    <div data-testid="agent-first-run-actions" className="mt-3">
      <ActionGroup title="Connect">
        {connectors.map((action) => (
          <ActionChip
            key={action.id}
            label={action.label}
            done={action.connected}
            doneLabel="connected"
            disabled={disabled}
            onSelect={(trigger) => launch(action.launch, trigger)}
            icon={
              action.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- local static SVG, same asset the connectors drawer uses.
                <img
                  src={`/icons/connectors/${action.logo}.svg`}
                  alt=""
                  className={cn("size-5 object-contain", action.logo === "plaid" && "dark:invert")}
                />
              ) : action.id === "statement_import" ? (
                <FileUp className="size-4 text-muted-foreground" />
              ) : (
                <Plus className="size-4 text-muted-foreground" />
              )
            }
          />
        ))}
      </ActionGroup>
      <ActionGroup title="Set up an agent">
        {agents.map((action) => {
          const icon = getOneCapability(action.capabilityId)?.icon;
          const Glyph = icon?.kind === "custom" ? icon.component : null;
          return (
            <ActionChip
              key={action.capabilityId}
              label={action.label}
              done={action.ready}
              doneLabel="set up"
              disabled={disabled}
              onSelect={(trigger) => launch(action.launch, trigger)}
              icon={Glyph ? <Glyph size={20} className="size-5" /> : null}
            />
          );
        })}
      </ActionGroup>
    </div>
  );
}
