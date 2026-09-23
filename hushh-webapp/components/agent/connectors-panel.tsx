"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Unplug as PlugIcon } from "@/components/icons";

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
import { DriveConnectorCard } from "@/components/agent/drive-connector-card";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  ExternalConnectorService,
  type ExternalConnectorSummary,
} from "@/lib/services/external-connector-service";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { useVault } from "@/lib/vault/vault-context";

export function ConnectorsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [showUnlock, setShowUnlock] = useState(false);
  const [catalog, setCatalog] = useState<{
    ownerId: string;
    token: string;
    items: ExternalConnectorSummary[];
  } | null>(null);
  const refreshGeneration = useRef(0);
  const connectors =
    catalog &&
    catalog.ownerId === user?.uid &&
    catalog.token === vaultOwnerToken
      ? catalog.items.filter((item) => item.connectorId !== "google_drive")
      : [];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiKeyTarget, setApiKeyTarget] =
    useState<ExternalConnectorSummary | null>(null);
  const [gmailConnectBusy, setGmailConnectBusy] = useState(false);

  const gmailIdTokenProvider = useCallback(
    () => (user?.getIdToken ? user.getIdToken() : Promise.resolve("")),
    [user],
  );
  const gmailConnectorStatus = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: open,
    idTokenProvider: user?.getIdToken ? gmailIdTokenProvider : null,
    routeHref: ROUTES.HOME,
  });
  const handleConnectGmail = useCallback(async () => {
    if (!user?.uid || !user?.getIdToken) return;
    setGmailConnectBusy(true);
    try {
      const idToken = await user.getIdToken();
      const start = await GmailReceiptsService.startConnect({
        idToken,
        userId: user.uid,
        includeGrantedScopes: false,
      });
      window.location.assign(start.authorize_url);
    } catch {
      setGmailConnectBusy(false);
    }
  }, [user]);
  const handleDisconnectGmail = useCallback(async () => {
    setGmailConnectBusy(true);
    try {
      await gmailConnectorStatus.disconnectGmail();
    } finally {
      setGmailConnectBusy(false);
    }
  }, [gmailConnectorStatus]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (!vaultOwnerToken || !user?.uid) {
      setCatalog(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await ExternalConnectorService.list(vaultOwnerToken);
      if (generation === refreshGeneration.current) {
        setCatalog({ ownerId: user.uid, token: vaultOwnerToken, items: list });
      }
    } catch {
      if (generation === refreshGeneration.current) {
        setError("Unable to load your connections. Please try again.");
      }
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [vaultOwnerToken, user?.uid]);

  const invalidateRefresh = useCallback(() => {
    refreshGeneration.current++;
  }, []);

  useEffect(() => {
    if (open) void refresh();
    return invalidateRefresh;
  }, [open, refresh, invalidateRefresh]);

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
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 sm:max-w-md"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-2">
              <PlugIcon className="h-5 w-5" aria-hidden="true" />
              Connections
            </SheetTitle>
            <SheetDescription>
              Manage services One can use. Drive uses MCP; other services use
              their existing app integrations.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <DriveConnectorCard
              user={user}
              enabled={open && Boolean(vaultOwnerToken)}
              onUnlock={() => setShowUnlock(true)}
            />
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
                <Card key="google-workspace">
                  <CardHeader className="flex-row items-center justify-between gap-4">
                    <div>
                      <CardTitle>Gmail</CardTitle>
                      <CardDescription>Email connection</CardDescription>
                    </div>
                    {gmailConnectorStatus.status?.connected ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={gmailConnectBusy}
                        onClick={() => void handleDisconnectGmail()}
                      >
                        {gmailConnectBusy ? "Disconnecting…" : "Disconnect"}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        disabled={gmailConnectBusy}
                        onClick={() => void handleConnectGmail()}
                      >
                        {gmailConnectBusy ? "Connecting…" : "Connect"}
                      </Button>
                    )}
                  </CardHeader>
                  {gmailConnectorStatus.status?.connected &&
                  gmailConnectorStatus.status?.google_email ? (
                    <CardContent className="pt-0">
                      <p className="text-muted-foreground text-xs">
                        Connected as {gmailConnectorStatus.status.google_email}
                      </p>
                    </CardContent>
                  ) : null}
                </Card>

                {[
                  {
                    name: "Calendar",
                    description: "Google Calendar connection",
                    href: ROUTES.CALENDAR,
                  },
                  {
                    name: "Plaid",
                    description: "Brokerage connections",
                    href: ROUTES.KAI_PORTFOLIO_SOURCES,
                  },
                ].map((service) => (
                  <Card key={service.name}>
                    <CardHeader className="flex-row items-center justify-between gap-4">
                      <div>
                        <CardTitle>{service.name}</CardTitle>
                        <CardDescription>{service.description}</CardDescription>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`Manage ${service.name}`}
                        onClick={() => {
                          onOpenChange(false);
                          router.push(service.href);
                        }}
                      >
                        Manage
                      </Button>
                    </CardHeader>
                  </Card>
                ))}

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
