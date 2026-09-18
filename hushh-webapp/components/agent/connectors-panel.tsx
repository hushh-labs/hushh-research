"use client";

import { useCallback, useEffect, useState } from "react";
import { Plugs as PlugIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import {
  ExternalConnectorService,
  type ExternalConnectorSummary,
} from "@/lib/services/external-connector-service";
import { useVault } from "@/lib/vault/vault-context";

/**
 * The team's named next connectors (see the external-MCP-connector plan).
 * None of these has a registered `external_mcp_connectors` row yet -- listing
 * them here, disabled, tells a person what's coming without implying any of
 * them is one API call away. Real rows from the registry always render first
 * and never duplicate an id also listed here.
 */
const COMING_SOON_CONNECTORS: { id: string; displayName: string }[] = [
  { id: "google-workspace", displayName: "Google Workspace" },
  { id: "microsoft-graph", displayName: "Microsoft Graph" },
  { id: "notion", displayName: "Notion" },
  { id: "hubspot", displayName: "HubSpot" },
  { id: "shopify", displayName: "Shopify" },
  { id: "plaid", displayName: "Plaid" },
  { id: "circle", displayName: "Circle" },
];

export function ConnectorsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [showUnlock, setShowUnlock] = useState(false);
  const [connectors, setConnectors] = useState<ExternalConnectorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiKeyTarget, setApiKeyTarget] =
    useState<ExternalConnectorSummary | null>(null);

  const refresh = useCallback(async () => {
    if (!vaultOwnerToken) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await ExternalConnectorService.list(vaultOwnerToken);
      setConnectors(list);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load your connectors.",
      );
    } finally {
      setLoading(false);
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleConnectOAuth = useCallback(
    async (connector: ExternalConnectorSummary) => {
      if (!vaultOwnerToken) {
        setShowUnlock(true);
        return;
      }
      try {
        const redirectUri = `${window.location.origin}${ROUTES.PROFILE_CONNECTOR_OAUTH_RETURN}`;
        const { authorizeUrl } =
          await ExternalConnectorService.startOAuthConnect({
            vaultOwnerToken,
            connectorId: connector.connectorId,
            redirectUri,
          });
        window.location.assign(authorizeUrl);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : `Unable to connect ${connector.displayName}.`,
        );
      }
    },
    [vaultOwnerToken],
  );

  const handleDisconnect = useCallback(
    async (connector: ExternalConnectorSummary) => {
      if (!vaultOwnerToken) return;
      try {
        await ExternalConnectorService.disconnect({
          vaultOwnerToken,
          connectorId: connector.connectorId,
        });
        await refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : `Unable to disconnect ${connector.displayName}.`,
        );
      }
    },
    [refresh, vaultOwnerToken],
  );

  const registeredIds = new Set(connectors.map((c) => c.connectorId));
  const comingSoon = COMING_SOON_CONNECTORS.filter(
    (c) => !registeredIds.has(c.id),
  );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 sm:max-w-md"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-2">
              <PlugIcon className="h-5 w-5" aria-hidden="true" />
              MCP connections
            </SheetTitle>
            <SheetDescription>
              Connect outside services so Kai can use your own data from them.
              Disconnect any time.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {error ? (
              <p className="mb-3 text-sm text-[color:var(--app-destructive)]">
                {error}
              </p>
            ) : null}

            {loading ? (
              <p className="text-muted-foreground text-sm">
                Loading your connectors…
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {connectors.map((connector) => (
                  <Card key={connector.connectorId}>
                    <CardHeader className="flex-row items-center justify-between gap-4">
                      <div>
                        <CardTitle>{connector.displayName}</CardTitle>
                        <CardDescription>
                          {connector.description || " "}
                        </CardDescription>
                      </div>
                      {connector.status === "connected" ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void handleDisconnect(connector)}
                        >
                          Disconnect
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          onClick={() =>
                            connector.authStyle === "oauth"
                              ? void handleConnectOAuth(connector)
                              : setApiKeyTarget(connector)
                          }
                        >
                          Connect
                        </Button>
                      )}
                    </CardHeader>
                    {connector.status === "connected" &&
                    connector.accountLabel ? (
                      <CardContent className="pt-0">
                        <p className="text-muted-foreground text-xs">
                          Connected as {connector.accountLabel}
                        </p>
                      </CardContent>
                    ) : null}
                  </Card>
                ))}

                {comingSoon.length > 0 ? (
                  <>
                    <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Coming soon
                    </p>
                    <div className="divide-y divide-border rounded-lg border border-border">
                      {comingSoon.map((connector) => (
                        <div
                          key={connector.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 opacity-60"
                          aria-disabled="true"
                        >
                          <span className="text-sm font-medium">
                            {connector.displayName}
                          </span>
                          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Coming soon
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showUnlock}
          onOpenChange={setShowUnlock}
          title="Set up your private vault"
          description="Open your vault to manage connectors."
          onSuccess={() => {
            setShowUnlock(false);
            void refresh();
          }}
        />
      ) : null}

      <ApiKeyConnectDialog
        connector={apiKeyTarget}
        vaultOwnerToken={vaultOwnerToken}
        onClose={() => setApiKeyTarget(null)}
        onConnected={() => {
          setApiKeyTarget(null);
          void refresh();
        }}
      />
    </>
  );
}

function ApiKeyConnectDialog({
  connector,
  vaultOwnerToken,
  onClose,
  onConnected,
}: {
  connector: ExternalConnectorSummary | null;
  vaultOwnerToken: string | null | undefined;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setApiKey("");
    setError(null);
  }, [connector]);

  const handleSubmit = useCallback(async () => {
    if (!connector || !vaultOwnerToken || !apiKey.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await ExternalConnectorService.connectWithApiKey({
        vaultOwnerToken,
        connectorId: connector.connectorId,
        apiKey: apiKey.trim(),
      });
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save this key.");
    } finally {
      setSubmitting(false);
    }
  }, [apiKey, connector, onConnected, vaultOwnerToken]);

  return (
    <Dialog
      open={connector !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {connector?.displayName}</DialogTitle>
          <DialogDescription>
            Paste an API key for {connector?.displayName}. It's encrypted and
            only used to read your data through it.
          </DialogDescription>
        </DialogHeader>
        <Input
          type="password"
          autoComplete="off"
          placeholder="API key"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        {error ? (
          <p className="text-sm text-[color:var(--app-destructive)]">{error}</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!apiKey.trim() || submitting}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
