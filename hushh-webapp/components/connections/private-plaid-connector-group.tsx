"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ConnectorVectorGlyph } from "@/components/agent/connector-brand-mark";
import {
  ConnectorConfirm,
  connectorConfirmCopy,
} from "@/components/agent/connector-confirm";
import type {
  ConnectorDetailAction,
  ConnectorDetailPresentation,
  ConnectorsPanelPresentation,
} from "@/components/agent/connectors-panel";
import { ScopeTariffEditor } from "@/components/consent/scope-tariff-editor";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { connectorAccessPurpose } from "@/lib/agent/connector-access-copy";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import type { CustomConnectorAccess } from "@/lib/connections/custom-connector-setup";
import { summarizePlaidVaultProjection } from "@/lib/kai/plaid-vault/projection-summary";
import {
  connectVaultPlaid,
  disconnectVaultPlaid,
  refreshVaultConnections,
  vaultConnections,
} from "@/lib/kai/plaid-vault/vault-sync";
import { usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

export type PrivatePlaidBankEntry = {
  key: string;
  name: string;
  status: string;
  amountLabel: string | null;
  lastRefreshedLabel: string | null;
  needsRelink: boolean;
};

function formatRefreshedTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

export function usePrivatePlaidConnectorModel({
  open,
  access,
  visitKey,
}: {
  open: boolean;
  access: CustomConnectorAccess | null;
  visitKey?: string | null;
}) {
  const vaultEpoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  const authUserId = owner?.userId;
  const authGeneration = owner?.generation;
  const visit = useMemo(
    () => ({
      open,
      userId: access?.userId ?? null,
      vaultOwnerToken: access?.vaultOwnerToken ?? null,
      vaultEpoch,
      visitKey,
      auth:
        authUserId && authGeneration !== undefined
          ? { userId: authUserId, generation: authGeneration }
          : null,
    }),
    [open, access?.userId, access?.vaultOwnerToken, vaultEpoch, visitKey, authUserId, authGeneration],
  );
  const liveVisit = useRef<typeof visit | null>(null);
  const inFlight = useRef<object | null>(null);
  const [busyAction, setBusyAction] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [message, setMessage] = useState("");
  const [confirmItemId, setConfirmItemId] = useState<string | null>(null);

  useLayoutEffect(() => {
    liveVisit.current = visit;
    inFlight.current = null;
    setBusyAction(null);
    setMessage("");
    setConfirmItemId(null);
    return () => {
      if (liveVisit.current === visit) liveVisit.current = null;
    };
  }, [visit]);

  const isCurrent = useCallback(
    () =>
      Boolean(
        liveVisit.current === visit &&
          visit.open &&
          visit.userId &&
          visit.vaultOwnerToken &&
          visit.auth &&
          isValidatedAuthSessionOwnerCurrent(visit.auth) &&
          isVaultSessionEpochCurrent(visit.vaultEpoch),
      ),
    [visit],
  );

  const financial = usePkmDomainResource({
    userId: access?.userId ?? "",
    domain: "financial",
    vaultKey: access?.vaultKey ?? null,
    vaultOwnerToken: access?.vaultOwnerToken ?? null,
    enabled: Boolean(open && access),
  }) as {
    data: { data?: Record<string, unknown> } | null;
    loading: boolean;
    error: string | null;
    refresh?: (options?: { force?: boolean }) => Promise<unknown>;
  };

  const projectionSummary = summarizePlaidVaultProjection(financial.data?.data);
  const connectionMap = vaultConnections(financial.data?.data);
  const banks: PrivatePlaidBankEntry[] = Object.entries(connectionMap).map(
    ([itemId, connection]) => ({
      key: itemId,
      name: connection.institution_name || "Bank connection",
      status: connection.status === "needs_relink" ? "Reconnect needed" : "Connected",
      amountLabel: projectionSummary.byItemId[itemId]?.summaryLabel ?? null,
      lastRefreshedLabel: formatRefreshedTime(connection.last_refreshed_at),
      needsRelink: connection.status === "needs_relink",
    }),
  );

  const [scopeHandlesByMachineScope, setScopeHandlesByMachineScope] = useState<
    Record<string, string>
  >(() => {
    const userId = access?.userId;
    if (!userId || typeof PersonalKnowledgeModelService?.peekAvailableScopes !== "function") {
      return {};
    }
    const warm = PersonalKnowledgeModelService.peekAvailableScopes(userId);
    if (!warm || warm.userId !== userId || !Array.isArray(warm.scopeEntries)) {
      return {};
    }
    const next: Record<string, string> = {};
    for (const entry of warm.scopeEntries) {
      if (
        entry &&
        entry.domain === "financial" &&
        typeof entry.scope === "string" &&
        typeof entry.scope_handle === "string" &&
        entry.scope_handle.trim()
      ) {
        next[entry.scope] = entry.scope_handle.trim();
      }
    }
    return next;
  });

  useEffect(() => {
    const userId = access?.userId;
    const token = access?.vaultOwnerToken;
    if (
      !open ||
      !userId ||
      !token ||
      banks.length === 0 ||
      typeof PersonalKnowledgeModelService?.getAvailableScopes !== "function"
    ) {
      return;
    }
    let active = true;
    void PersonalKnowledgeModelService.getAvailableScopes(userId, token)
      .then((result) => {
        if (!active || !isCurrent() || result.userId !== userId) return;
        const next: Record<string, string> = {};
        for (const entry of result.scopeEntries ?? []) {
          if (
            entry &&
            entry.domain === "financial" &&
            typeof entry.scope === "string" &&
            typeof entry.scope_handle === "string" &&
            entry.scope_handle.trim()
          ) {
            next[entry.scope] = entry.scope_handle.trim();
          }
        }
        setScopeHandlesByMachineScope(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [open, access?.userId, access?.vaultOwnerToken, banks.length, isCurrent]);

  const runGuarded = async (
    kind: "connect" | "refresh" | "disconnect",
    work: (resolvedAccess: CustomConnectorAccess, stillCurrent: () => boolean) => Promise<void>,
  ) => {
    if (!access || inFlight.current || !isCurrent()) return;
    const token = {};
    inFlight.current = token;
    const stillCurrent = () => liveVisit.current === visit && inFlight.current === token && isCurrent();
    setBusyAction(kind);
    setMessage("");
    try {
      await work(access, stillCurrent);
    } finally {
      if (inFlight.current === token) {
        inFlight.current = null;
        if (liveVisit.current === visit && isCurrent()) {
          setBusyAction(null);
        }
      }
    }
  };

  const connect = async () => {
    await runGuarded("connect", async (resolvedAccess, stillCurrent) => {
      setMessage("Opening Plaid bank link…");
      try {
        const result = await connectVaultPlaid({
          userId: resolvedAccess.userId,
          vaultKey: resolvedAccess.vaultKey,
          vaultOwnerToken: resolvedAccess.vaultOwnerToken,
          originSurface: "agentone_chat",
        });
        if (!stillCurrent()) return;
        if (result.status === "connected") {
          const refreshed = await financial.refresh?.({ force: true });
          const { syncPlaidPostureToPersonalWikiBestEffort } = await import(
            "@/lib/kai/plaid-vault/wiki-posture-sync"
          );
          await syncPlaidPostureToPersonalWikiBestEffort({
            userId: resolvedAccess.userId,
            vaultKey: resolvedAccess.vaultKey,
            vaultOwnerToken: resolvedAccess.vaultOwnerToken,
            financial:
              refreshed && typeof refreshed === "object" && "data" in refreshed
                ? (refreshed as { data?: Record<string, unknown> }).data
                : financial.data?.data,
          });
          if (stillCurrent()) {
            const successText = result.institutionName
              ? `${result.institutionName} connected.`
              : "Bank connected.";
            setMessage(successText);
            morphyToast.success(successText);
          }
        } else if (result.status === "blocked") {
          setMessage(result.reason);
          morphyToast.error(result.reason);
        } else {
          setMessage("");
        }
      } catch {
        if (stillCurrent()) {
          const errorText = "Could not connect that bank. Try again.";
          setMessage(errorText);
          morphyToast.error(errorText);
        }
      }
    });
  };

  const refreshLive = async () => {
    await runGuarded("refresh", async (resolvedAccess, stillCurrent) => {
      setMessage("Refreshing bank balances…");
      try {
        const outcome = await refreshVaultConnections({
          userId: resolvedAccess.userId,
          vaultKey: resolvedAccess.vaultKey,
          vaultOwnerToken: resolvedAccess.vaultOwnerToken,
          financial: financial.data?.data,
          force: true,
        });
        if (!stillCurrent()) return;
        const refreshed = await financial.refresh?.({ force: true });
        if (outcome.refreshed > 0) {
          const { syncPlaidPostureToPersonalWikiBestEffort } = await import(
            "@/lib/kai/plaid-vault/wiki-posture-sync"
          );
          await syncPlaidPostureToPersonalWikiBestEffort({
            userId: resolvedAccess.userId,
            vaultKey: resolvedAccess.vaultKey,
            vaultOwnerToken: resolvedAccess.vaultOwnerToken,
            financial:
              refreshed && typeof refreshed === "object" && "data" in refreshed
                ? (refreshed as { data?: Record<string, unknown> }).data
                : financial.data?.data,
          });
        }
        if (!stillCurrent()) return;
        if (outcome.needsRelink.length > 0) {
          const relinkText = "Reconnect needed on at least one bank.";
          setMessage(relinkText);
          morphyToast.error(relinkText);
        } else if (outcome.refreshed > 0) {
          const refreshedText = "Bank balances updated.";
          setMessage(refreshedText);
          morphyToast.success(refreshedText);
        } else if (outcome.failed > 0) {
          const failText = "Could not refresh all bank records. Try again.";
          setMessage(failText);
          morphyToast.error(failText);
        } else {
          setMessage("Balances are up to date.");
        }
      } catch {
        if (stillCurrent()) {
          const errorText = "Could not refresh bank balances. Try again.";
          setMessage(errorText);
          morphyToast.error(errorText);
        }
      }
    });
  };

  const confirmDisconnect = async () => {
    const itemId = confirmItemId;
    if (!itemId) return;
    await runGuarded("disconnect", async (resolvedAccess, stillCurrent) => {
      setMessage("Disconnecting bank…");
      try {
        const removed = await disconnectVaultPlaid({
          userId: resolvedAccess.userId,
          vaultKey: resolvedAccess.vaultKey,
          vaultOwnerToken: resolvedAccess.vaultOwnerToken,
          itemId,
          financial: financial.data?.data,
        });
        if (!stillCurrent()) return;
        setConfirmItemId(null);
        await financial.refresh?.({ force: true });
        if (stillCurrent()) {
          setMessage(removed ? "Bank disconnected." : "Could not disconnect that bank. Try again.");
        }
      } catch {
        if (stillCurrent()) {
          setConfirmItemId(null);
          setMessage("Could not disconnect that bank. Try again.");
        }
      }
    });
  };

  const requestDisconnect = (itemId: string) => {
    if (!access || busyAction !== null || !isCurrent()) return;
    setConfirmItemId(itemId);
  };

  const cancelDisconnect = () => {
    if (busyAction === "disconnect") return;
    setConfirmItemId(null);
  };

  const busy = busyAction !== null;
  const needsRelinkCount = banks.filter((bank) => bank.needsRelink).length;
  const statusLabel = !access
    ? "Sign in and unlock your vault to connect a bank."
    : financial.error
      ? "Could not check bank connections."
      : financial.loading
        ? "Checking bank connections…"
        : needsRelinkCount > 0
          ? `${banks.length} linked · Reconnect needed`
          : banks.length > 0
            ? `${banks.length} connected ${banks.length === 1 ? "bank" : "banks"} · Live snapshot ready`
            : "Not connected · Connect a bank for real-time financial insights";

  const detailPresentation: Extract<ConnectorDetailPresentation, { kind: "plaid" }> = {
    kind: "plaid",
    status: statusLabel,
    message:
      busyAction === "connect"
        ? "Connecting bank…"
        : busyAction === "refresh"
          ? "Refreshing live bank data…"
          : busyAction === "disconnect"
            ? "Disconnecting bank…"
            : message,
    banks: banks.map((bank) => ({
      key: bank.key,
      name: bank.name,
      status: [bank.status, bank.amountLabel].filter(Boolean).join(" · "),
      disconnect: {
        label: "Disconnect",
        disabled: !access || busy,
        destructive: true,
        run: () => requestDisconnect(bank.key),
      } satisfies ConnectorDetailAction,
    })),
    ...(access && !financial.loading && !financial.error
      ? {
          connect: {
            label: banks.length > 0 ? "Add bank" : "Connect a bank",
            disabled: busy,
            run: () => {
              void connect();
            },
          } satisfies ConnectorDetailAction,
        }
      : {}),
  };

  const confirmation: ConnectorsPanelPresentation["confirmation"] = confirmItemId
    ? {
        ...connectorConfirmCopy(`plaid:${confirmItemId}`),
        busy: busyAction === "disconnect",
        confirm: () => {
          void confirmDisconnect();
        },
        cancel: cancelDisconnect,
      }
    : null;

  return {
    access,
    banks,
    projectionSummary,
    scopeHandlesByMachineScope,
    connected: banks.length > 0,
    loading: financial.loading,
    error: financial.error,
    busy,
    busyAction,
    message,
    statusLabel,
    confirmItemId,
    connect,
    refreshLive,
    requestDisconnect,
    confirmDisconnect,
    cancelDisconnect,
    detailPresentation,
    confirmation,
  };
}

export type PrivatePlaidConnectorModel = ReturnType<typeof usePrivatePlaidConnectorModel>;

export function PrivatePlaidConnectorGroup({
  model,
  showAccessDetails = false,
  onSelectConnector,
}: {
  model: PrivatePlaidConnectorModel;
  showAccessDetails?: boolean;
  onSelectConnector?: () => void;
}) {
  const {
    access,
    banks,
    projectionSummary,
    loading,
    error,
    busy,
    busyAction,
    message,
    statusLabel,
    confirmItemId,
    connect,
    refreshLive,
    requestDisconnect,
    confirmDisconnect,
    cancelDisconnect,
  } = model;

  if (onSelectConnector) {
    return (
      <section className="space-y-2" data-testid="private-plaid-connectors" aria-label="Plaid bank connections">
        <SettingsGroup title="Banking & Finance" separatorInset testId="private-plaid-settings-group">
          <SettingsRow
            testId="private-connector-row-plaid"
            leading={<ConnectorVectorGlyph id="plaid" variant="profile" />}
            title="Plaid"
            description={
              showAccessDetails ? (
                <>
                  <span>{statusLabel}</span>
                  <span className="block pt-0.5">{connectorAccessPurpose("plaid")}</span>
                </>
              ) : (
                statusLabel
              )
            }
            textOverflow={showAccessDetails ? undefined : "truncate"}
            onClick={onSelectConnector}
            chevron
          />
        </SettingsGroup>
      </section>
    );
  }

  return (
    <section className="space-y-2" data-testid="private-plaid-connectors" aria-label="Plaid bank connections">
      <SettingsGroup title="Banking & Finance" separatorInset testId="private-plaid-settings-group">
        <SettingsRow
          testId="private-connector-row-plaid"
          leading={<ConnectorVectorGlyph id="plaid" variant="profile" />}
          title="Plaid"
          description={
            showAccessDetails ? (
              <>
                <span>{statusLabel}</span>
                <span className="block pt-1">{connectorAccessPurpose("plaid")}</span>
              </>
            ) : (
              statusLabel
            )
          }
          textOverflow={showAccessDetails ? undefined : "truncate"}
          trailing={
            <div className="flex flex-wrap items-center gap-2">
              {banks.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="row"
                  data-connector-action="secondary"
                  disabled={!access || busy || loading}
                  onClick={() => void refreshLive()}
                >
                  {busyAction === "refresh" ? "Refreshing…" : "Refresh live"}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="row"
                data-connector-action="primary"
                disabled={!access || busy || loading || Boolean(error)}
                onClick={() => void connect()}
              >
                {busyAction === "connect"
                  ? "Connecting…"
                  : banks.length > 0
                    ? "Add bank"
                    : "Connect"}
              </Button>
            </div>
          }
        />
        {banks.length > 0 && projectionSummary.hasData ? (
          <SettingsRow
            testId="private-plaid-projection-summary"
            leading={<ConnectorVectorGlyph id="plaid" variant="profile" />}
            title="Account summary"
            description={
              [
                projectionSummary.totalsLine,
                "Shared details update on sync",
              ]
                .filter(Boolean)
                .join(" · ")
            }
          />
        ) : null}
        {banks.map((bank) => (
          <SettingsRow
            key={bank.key}
            testId={`private-plaid-bank-${bank.key}`}
            leading={<ConnectorVectorGlyph id="plaid" variant="profile" />}
            title={bank.name}
            description={
              [
                bank.status,
                bank.amountLabel,
                bank.lastRefreshedLabel ? `Updated ${bank.lastRefreshedLabel}` : null,
              ]
                .filter(Boolean)
                .join(" · ")
            }
            trailing={
              <Button
                type="button"
                variant="outline"
                size="compact"
                data-connector-action="destructive"
                disabled={!access || busy}
                onClick={() => requestDisconnect(bank.key)}
              >
                Disconnect
              </Button>
            }
          />
        ))}
      </SettingsGroup>
      {message ? (
        <p role="status" aria-live="polite" className="px-1.5 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      <ConnectorConfirm
        target={confirmItemId ? `plaid:${confirmItemId}` : null}
        busy={busyAction === "disconnect"}
        onConfirm={() => void confirmDisconnect()}
        onCancel={cancelDisconnect}
      />
    </section>
  );
}

export function PrivatePlaidConnectorDetail({
  model,
  showAccessDetails = false,
}: {
  model: PrivatePlaidConnectorModel;
  showAccessDetails?: boolean;
}) {
  const {
    access,
    banks,
    projectionSummary,
    scopeHandlesByMachineScope,
    loading,
    error,
    busy,
    busyAction,
    message,
    statusLabel,
    confirmItemId,
    connect,
    refreshLive,
    requestDisconnect,
    confirmDisconnect,
    cancelDisconnect,
  } = model;

  return (
    <div className="space-y-4" aria-label="Plaid connection details">
      <SettingsGroup title="Banking & Finance" separatorInset testId="private-plaid-detail-overview">
        <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
          <ConnectorVectorGlyph id="plaid" variant="profile" className="mt-0.5" />
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-semibold leading-tight text-foreground">Plaid</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{statusLabel}</p>
            {showAccessDetails ? (
              <p className="text-xs leading-relaxed text-muted-foreground">{connectorAccessPurpose("plaid")}</p>
            ) : null}
          </div>
        </div>
        {banks.length > 0 && projectionSummary.hasData ? (
          <div
            data-testid="private-plaid-projection-summary"
            className="space-y-2.5 border-t border-[color:var(--app-separator)] px-4 py-3.5 text-xs leading-relaxed text-muted-foreground"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                Account summary
              </p>
              <span className="text-[11px] text-muted-foreground">Updates on sync</span>
            </div>
            {projectionSummary.metrics.length > 0 ? (
              <dl className="grid grid-cols-3 gap-2">
                {projectionSummary.metrics.map((metric) => (
                  <div
                    key={metric.key}
                    className="rounded-xl border border-[color:var(--app-border)]/70 bg-foreground/[0.02] px-2.5 py-2"
                  >
                    <dt className="text-[11px] font-medium text-muted-foreground">
                      {metric.label}{" "}
                    </dt>
                    <dd className="mt-0.5 text-[14px] font-semibold tabular-nums tracking-[-0.015em] text-foreground">
                      {metric.formatted}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : projectionSummary.totalsLine ? (
              <p className="text-foreground/90 tabular-nums">{projectionSummary.totalsLine}</p>
            ) : null}
          </div>
        ) : null}
        <div className="border-t border-[color:var(--app-separator)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2" data-connector-action-bar="true">
            <Button
              type="button"
              variant="default"
              size="compact"
              data-connector-action="primary"
              disabled={!access || busy || loading || Boolean(error)}
              onClick={() => void connect()}
            >
              {busyAction === "connect"
                ? "Connecting…"
                : banks.length > 0
                  ? "Add bank"
                  : "Connect a bank"}
            </Button>
            {banks.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="compact"
                data-connector-action="secondary"
                disabled={!access || busy || loading}
                onClick={() => void refreshLive()}
              >
                {busyAction === "refresh" ? "Refreshing…" : "Refresh live"}
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsGroup>

      {banks.length > 0 && projectionSummary.scopes.length > 0 ? (
        <SettingsGroup
          title="Shareable data & pricing"
          separatorInset
          testId="private-plaid-shareable-scopes-group"
        >
          {projectionSummary.scopes.map((scope) => {
            const scopeHandle = scopeHandlesByMachineScope[scope.machineScope];
            return (
              <SettingsRow
                key={scope.machineScope}
                testId={`private-plaid-scope-${scope.key}`}
                title={scope.label}
                description={
                  scope.valueLabel
                    ? `${scope.valueLabel} · Ask first before sharing`
                    : "Ask first before sharing"
                }
                trailingInteractive={Boolean(scopeHandle)}
                stackTrailingOnMobile={Boolean(scopeHandle)}
                trailing={
                  scopeHandle ? (
                    <ScopeTariffEditor
                      scopeHandle={scopeHandle}
                      machineScope={scope.machineScope}
                      label={`Financial · ${scope.label}`}
                      showSavedPrice
                    />
                  ) : (
                    <span className="text-xs font-medium text-muted-foreground">Ask first</span>
                  )
                }
              />
            );
          })}
        </SettingsGroup>
      ) : null}

      {banks.length > 0 ? (
        <SettingsGroup title="Connected banks" separatorInset testId="private-plaid-banks-group">
          {banks.map((bank) => (
            <SettingsRow
              key={bank.key}
              testId={`private-plaid-bank-${bank.key}`}
              title={bank.name}
              description={
                [
                  bank.status === "Connected" ? null : bank.status,
                  bank.amountLabel,
                  bank.lastRefreshedLabel ? `Updated ${bank.lastRefreshedLabel}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              }
              trailing={
                <Button
                  type="button"
                  variant="outline"
                  size="compact"
                  data-connector-action="destructive"
                  disabled={!access || busy}
                  onClick={() => requestDisconnect(bank.key)}
                >
                  Disconnect
                </Button>
              }
            />
          ))}
        </SettingsGroup>
      ) : null}

      {message ? (
        <p role="status" aria-live="polite" className="sr-only">
          {message}
        </p>
      ) : null}
      <ConnectorConfirm
        target={confirmItemId ? `plaid:${confirmItemId}` : null}
        busy={busyAction === "disconnect"}
        onConfirm={() => void confirmDisconnect()}
        onCancel={cancelDisconnect}
      />
    </div>
  );
}
