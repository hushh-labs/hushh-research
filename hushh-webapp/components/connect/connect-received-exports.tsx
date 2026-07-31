"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, Loader2, ShieldCheck } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/lib/morphy-ux/button";
import {
  ConnectionsService,
  type ReceivedScopeExport,
} from "@/lib/services/connections-service";
import { decryptConnectScopedExport } from "@/lib/connect/requester-key";

export interface ConnectReceivedExportsProps {
  /** Current user id (the requester whose on-device key can unwrap these). */
  userId: string;
  /** Firebase ID token loader (retrieval is auth-gated). */
  getIdToken: () => Promise<string | undefined>;
}

/** Best-effort pretty-print: decrypted scope payloads are JSON, but fall back to
 * the raw string so a non-JSON payload still renders instead of throwing. */
function prettyPrint(plaintext: string): string {
  try {
    return JSON.stringify(JSON.parse(plaintext), null, 2);
  } catch {
    return plaintext;
  }
}

/** Turn a machine scope like `vault.read.finance.transactions` into a readable
 * fallback label when the catalog has no friendlier name. */
function humanizeScope(scope: string): string {
  const tail = scope.split(/[.:]/).filter(Boolean).pop() || scope;
  return tail
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * "Shared with you" — scopes other people granted to THIS device through the
 * Connect zero-knowledge pipeline. The list arrives as ciphertext + a key
 * wrapped to this device's X25519 public key; nothing is decrypted until the
 * user taps "View", and decryption happens entirely on-device. The section
 * renders only when at least one decryptable export exists, so it stays out of
 * the way for users who have received nothing.
 */
export function ConnectReceivedExports({
  userId,
  getIdToken,
}: ConnectReceivedExportsProps) {
  const [items, setItems] = useState<ReceivedScopeExport[]>([]);
  const [scopeLabels, setScopeLabels] = useState<Map<string, string>>(new Map());
  const [loaded, setLoaded] = useState(false);

  // Reveal state keyed by grant id (stable per export).
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealText, setRevealText] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const idToken = await getIdToken();
        if (!idToken) return;
        // Received exports are the point of this section; the scope catalog is a
        // best-effort label source, so a catalog failure must not hide exports.
        const [received, catalog] = await Promise.all([
          ConnectionsService.listReceivedExports({ idToken }),
          ConnectionsService.listRequestableScopes({ idToken }).catch(() => ({
            bundles: [],
            scopes: [],
          })),
        ]);
        if (cancelled) return;
        setItems(received);
        setScopeLabels(
          new Map(
            catalog.scopes
              .filter((s) => s.label)
              .map((s) => [s.scope, s.label as string]),
          ),
        );
      } catch {
        /* non-fatal: the section simply stays hidden if retrieval fails */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, getIdToken]);

  const openExport = useMemo(
    () => items.find((it) => (it.grantId || it.scope) === openKey) || null,
    [items, openKey],
  );

  const scopeLabelFor = useCallback(
    (export_: ReceivedScopeExport): string => {
      const scope = export_.scope || "";
      return scopeLabels.get(scope) || (scope ? humanizeScope(scope) : "Shared data");
    },
    [scopeLabels],
  );

  const handleReveal = useCallback(
    async (export_: ReceivedScopeExport) => {
      const key = export_.grantId || export_.scope || "";
      setOpenKey(key);
      setRevealText(null);
      setRevealError(null);
      setRevealBusy(true);
      try {
        const plaintext = await decryptConnectScopedExport({
          userId,
          envelope: export_.envelope,
        });
        setRevealText(prettyPrint(plaintext));
      } catch (error) {
        setRevealError(
          error instanceof Error ? error.message : "Couldn't decrypt on this device.",
        );
      } finally {
        setRevealBusy(false);
      }
    },
    [userId],
  );

  // Stay invisible until we know there is something decryptable to show.
  if (!loaded || items.length === 0) return null;

  return (
    <>
      <SettingsGroup
        title={`Shared with you (${items.length})`}
        description="Data people granted to this device. Encrypted end-to-end — only you can open it here."
        separatorInset
      >
        {items.map((export_) => {
          const key = export_.grantId || export_.scope || "";
          const granter = export_.granterDisplayName || export_.granterUserId || "Someone";
          return (
            <SettingsRow
              key={key}
              icon={Inbox}
              iconTone="green"
              title={granter}
              description={scopeLabelFor(export_)}
              density="compact"
              trailing={
                <Button
                  type="button"
                  variant="none"
                  effect="fill"
                  size="sm"
                  disabled={revealBusy && openKey === key}
                  onClick={() => void handleReveal(export_)}
                >
                  {revealBusy && openKey === key ? "Opening…" : "View"}
                </Button>
              }
            />
          );
        })}
      </SettingsGroup>

      <Dialog
        open={openKey !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOpenKey(null);
            setRevealText(null);
            setRevealError(null);
          }
        }}
      >
        <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
          <DialogHeader className="px-5 pt-5 pb-3 text-left">
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              {openExport ? scopeLabelFor(openExport) : "Shared data"}
            </DialogTitle>
            <DialogDescription>
              {openExport
                ? `Shared by ${openExport.granterDisplayName || openExport.granterUserId || "someone"}. Decrypted on your device — never on our servers.`
                : "Decrypted on your device."}
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 pb-5">
            {revealBusy ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Decrypting…
              </div>
            ) : revealError ? (
              <p className="py-6 text-sm text-destructive">{revealError}</p>
            ) : revealText ? (
              <ScrollArea className="max-h-[52vh] rounded-md border border-border/60 bg-muted/30">
                <pre className="whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-foreground">
                  {revealText}
                </pre>
              </ScrollArea>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
