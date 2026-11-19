"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
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
  return new Date(parsed).toLocaleString();
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
            setMessage(
              result.institutionName
                ? `${result.institutionName} connected.`
                : "Bank connected.",
            );
          }
        } else if (result.status === "blocked") {
          setMessage(result.reason);
        } else {
          setMessage("");
        }
      } catch {
        if (stillCurrent()) setMessage("Could not connect that bank. Try again.");
      }
    });
  };

  const refreshLive = async () => {
    await runGuarded("refresh", async (resolvedAccess, stillCurrent) => {
      setMessage("Refreshing live bank data…");
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
          setMessage("At least one bank needs re-authentication before refreshing.");
        } else if (outcome.refreshed > 0) {
          setMessage("Live bank snapshot updated.");
        } else if (outcome.failed > 0) {
          setMessage("Could not refresh all bank records. Try again.");
        } else {
          setMessage("Bank records are already up to date.");
        }
      } catch {
        if (stillCurrent()) setMessage("Could not refresh live bank data. Try again.");
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
}: {
  model: PrivatePlaidConnectorModel;
  showAccessDetails?: boolean;
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

  return (
    <section className="space-y-2" data-testid="private-plaid-connectors" aria-label="Plaid bank connections">
      <SettingsGroup title="Banking & Finance" testId="private-plaid-settings-group">
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
          trailing={
            <div className="flex flex-wrap items-center gap-2">
              {banks.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="compact"
                  disabled={!access || busy || loading}
                  onClick={() => void refreshLive()}
                >
                  {busyAction === "refresh" ? "Refreshing…" : "Refresh live"}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="compact"
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
            title="Live scope projection"
            description={
              <>
                {projectionSummary.totalsLine ? (
                  <span>{projectionSummary.totalsLine}</span>
                ) : null}
                {projectionSummary.projectedScopesLine ? (
                  <span className="block pt-0.5">{projectionSummary.projectedScopesLine}</span>
                ) : null}
                <span className="block pt-0.5">
                  Active ongoing shares update automatically on sync.
                </span>
              </>
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
