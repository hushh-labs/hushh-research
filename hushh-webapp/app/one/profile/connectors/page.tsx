"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
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
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import {
  ExternalConnectorService,
  type ExternalConnectorSummary,
} from "@/lib/services/external-connector-service";
import { useVault } from "@/lib/vault/vault-context";

export default function ExternalConnectorsPage() {
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
        err instanceof Error
          ? err.message
          : "Unable to load your connectors.",
      );
    } finally {
      setLoading(false);
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-[calc(var(--app-bottom-inset)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/profile/connectors",
        marker: "native-route-profile-connectors",
        authState: user ? "authenticated" : "pending",
        dataState: loading ? "loading" : "loaded",
      }}
    >
      <NativeTestBeacon
        routeId="/one/profile/connectors"
        marker="native-route-profile-connectors"
        authState={user ? "authenticated" : "pending"}
        dataState={loading ? "loading" : "loaded"}
      />
      <AppPageContentRegion>
        <div className="mb-6">
          <h1 className="text-xl font-semibold">Connectors</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Connect outside services so Kai can use your own data from them.
            Disconnect any time.
          </p>
        </div>

        {error ? (
          <p className="mb-4 text-sm text-[color:var(--app-destructive)]">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="text-muted-foreground text-sm">
            Loading your connectors…
          </p>
        ) : connectors.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No connectors are available yet.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {connectors.map((connector) => (
              <Card key={connector.connectorId}>
                <CardHeader className="flex-row items-center justify-between gap-4">
                  <div>
                    <CardTitle>{connector.displayName}</CardTitle>
                    <CardDescription>
                      {connector.description || " "}
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
          </div>
        )}
      </AppPageContentRegion>

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
    </AppPageShell>
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
      setError(
        err instanceof Error ? err.message : "Unable to save this key.",
      );
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
          <p className="text-sm text-[color:var(--app-destructive)]">
            {error}
          </p>
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
